/**
 * TARANG API Client
 *
 * Typed fetch wrappers for every backend endpoint (§9).
 * Key rules:
 *   - Binary responses (slice/volume/isosurface) use parseBinaryResponse()
 *   - All requests are debounced at the call site (store layer)
 *   - In-flight request deduplication: same key → same Promise
 *   - AbortController per request — cancel on bbox/mode change
 *
 * Wire format (§8.6, §8.7):
 *   [4 bytes: header_len uint32 LE] [header_len bytes: JSON] [float32 body bytes]
 */

import type {
  SourceMetadata, InstrumentsResponse, DepthProfile, SourceEntry,
  ParsedSlice, ParsedVolume, ParsedIsosurface, LastUpdatedEntry,
  SliceHeader, VolumeHeader, IsosurfaceHeader,
} from './types'

export const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api'

// ── In-flight request deduplication ──────────────────────────────────────────
const _inflight = new Map<string, Promise<unknown>>()

function dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = _inflight.get(key) as Promise<T> | undefined
  if (existing) {
    // The in-flight request under this key carries ONE caller's AbortSignal, but every caller
    // sharing this key gets the SAME promise back. If that signal's owner aborts (React 18
    // StrictMode's mount -> cleanup -> mount is a common trigger — the throwaway first mount's
    // cleanup fires right as the real second mount starts and requests the same key), every
    // OTHER caller waiting on this promise — who did nothing wrong and didn't abort anything —
    // would otherwise inherit that AbortError and hang/fail with no unaborted retry. Instead,
    // transparently retry with a fresh request on their behalf.
    return existing.catch((err: unknown) => {
      if (err instanceof Error && err.name === 'AbortError') {
        _inflight.delete(key)
        return dedupe(key, fn)
      }
      throw err
    })
  }
  const p = fn().finally(() => _inflight.delete(key))
  _inflight.set(key, p)
  return p
}

// ── Binary response parser ────────────────────────────────────────────────────
/**
 * Parses the TARANG binary wire format:
 *   [uint32 header_len][JSON header bytes][float32 body bytes]
 *
 * Returns { header, data } where data is a Float32Array view over the body.
 */
async function parseBinaryResponse<H>(buffer: ArrayBuffer): Promise<{ header: H; data: Float32Array }> {
  const view      = new DataView(buffer)
  const headerLen = view.getUint32(0, true)           // little-endian
  const headerBytes = buffer.slice(4, 4 + headerLen)
  const bodyBytes   = buffer.slice(4 + headerLen)

  const headerText = new TextDecoder().decode(headerBytes)
  const header     = JSON.parse(headerText) as H
  const data       = new Float32Array(bodyBytes)

  return { header, data }
}

/**
 * Parses the isosurface binary response which packs three arrays:
 *   [header][verts float32][normals float32][faces uint32]
 */
async function parseIsosurfaceBinary(buffer: ArrayBuffer): Promise<ParsedIsosurface> {
  const view      = new DataView(buffer)
  const headerLen = view.getUint32(0, true)
  const headerBytes = buffer.slice(4, 4 + headerLen)
  const header      = JSON.parse(new TextDecoder().decode(headerBytes)) as IsosurfaceHeader

  const nVerts  = header.n_verts
  const nFaces  = header.n_faces
  const rest    = buffer.slice(4 + headerLen)

  const vertsBytes   = rest.slice(0,                    nVerts * 3 * 4)
  const normalsBytes = rest.slice(nVerts * 3 * 4,       nVerts * 3 * 4 * 2)
  const facesBytes   = rest.slice(nVerts * 3 * 4 * 2,   nVerts * 3 * 4 * 2 + nFaces * 3 * 4)

  return {
    header,
    verts:   new Float32Array(vertsBytes),
    normals: new Float32Array(normalsBytes),
    faces:   new Uint32Array(facesBytes),
  }
}

// ── Endpoint helpers ──────────────────────────────────────────────────────────

function bboxStr(bbox: [number, number, number, number]): string {
  return bbox.join(',')
}

// ── Retry helper — survives backend restarts ─────────────────────────────────
/**
 * Wraps a fetch call with exponential backoff retry logic.
 * If the fetch fails (network error or 5xx), retries up to `maxRetries` times
 * with delays of 1s, 2s, 4s, 8s, etc.
 * Aborted requests (AbortError) are NOT retried — they are intentional cancellations.
 */
async function fetchWithRetry(
  url: string,
  opts: RequestInit = {},
  maxRetries = 10,
  baseDelayMs = 1000,
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, opts)
      // Retry on 502/503/504 (backend restarting)
      if (res.status >= 502 && res.status <= 504 && attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt)
        console.warn(`[TARANG] ${url} returned ${res.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`)
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      return res
    } catch (err: unknown) {
      // Don't retry aborted requests
      if (err instanceof Error && err.name === 'AbortError') throw err
      // Network error — retry
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt)
        console.warn(`[TARANG] ${url} fetch failed, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries}):`, err)
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      throw err
    }
  }
  // Should never reach here, but TypeScript needs it
  throw new Error(`fetchWithRetry: exhausted all ${maxRetries} retries for ${url}`)
}

// ── Public API ────────────────────────────────────────────────────────────────

/** List all registered data sources. Uses retry to survive backend restarts. */
export async function fetchSources(signal?: AbortSignal): Promise<SourceEntry[]> {
  const res = await fetchWithRetry(`${API_BASE}/sources`, { signal })
  if (!res.ok) throw new Error(`fetchSources failed: ${res.status}`)
  const json = await res.json()
  return json.sources as SourceEntry[]
}

export interface UploadedSource {
  id: string
  label: string
  adapter: string
  variable: string
  all_variables: string[]
  bbox: [number, number, number, number]
  depth_levels: number[]
  n_times: number
  render_type: string
  warnings: string[]
}

/** Upload a NetCDF/CSV file; backend introspects it and registers a new source. */
export async function uploadDataSource(file: File, label?: string): Promise<UploadedSource> {
  const form = new FormData()
  form.append('file', file)
  if (label) form.append('label', label)
  const res = await fetch(`${API_BASE}/registry/upload`, { method: 'POST', body: form })
  if (!res.ok) {
    let msg = `Upload failed (${res.status})`
    try { const j = await res.json(); if (j?.detail) msg = typeof j.detail === 'string' ? j.detail : msg } catch { /* ignore */ }
    throw new Error(msg)
  }
  return res.json() as Promise<UploadedSource>
}

/** Get metadata for one source — drives all frontend selectors. */
export async function fetchMetadata(sourceId: string, signal?: AbortSignal): Promise<SourceMetadata> {
  const key = `meta:${sourceId}`
  return dedupe(key, async () => {
    const res = await fetchWithRetry(`${API_BASE}/metadata?source=${encodeURIComponent(sourceId)}`, { signal })
    if (!res.ok) throw new Error(`fetchMetadata failed: ${res.status}`)
    return res.json() as Promise<SourceMetadata>
  })
}

/** Fetch a 2D depth-slice as Float32Array + metadata header. */
export async function fetchSlice(params: {
  source:  string
  var:     string
  depth:   number       // actual depth in meters (already snapped to nearest level)
  time:    number       // time step index
  bbox:    [number, number, number, number]
  mode?:   'live' | 'cached'
}, signal?: AbortSignal): Promise<ParsedSlice> {
  const { source, var: variable, depth, time, bbox, mode = 'live' } = params
  const key = `slice:${source}:${variable}:${depth}:${time}:${bboxStr(bbox)}:${mode}`

  return dedupe(key, async () => {
    const url = `${API_BASE}/slice?source=${source}&var=${variable}&depth=${depth}&time=${time}&bbox=${bboxStr(bbox)}&mode=${mode}`
    const res = await fetch(url, { signal })
    if (!res.ok) throw new Error(`fetchSlice failed: ${res.status}`)
    const buffer = await res.arrayBuffer()
    const { header, data } = await parseBinaryResponse<SliceHeader>(buffer)
    return { header, data } as ParsedSlice
  })
}

/** Fetch a full 3D volume for raymarching. */
export async function fetchVolume(params: {
  source: string
  var:    string
  time:   number
  bbox:   [number, number, number, number]
  mode?:  'live' | 'cached'
}, signal?: AbortSignal): Promise<ParsedVolume> {
  const { source, var: variable, time, bbox, mode = 'live' } = params
  const key = `volume:${source}:${variable}:${time}:${bboxStr(bbox)}:${mode}`

  return dedupe(key, async () => {
    const url = `${API_BASE}/volume?source=${source}&var=${variable}&time=${time}&bbox=${bboxStr(bbox)}&mode=${mode}`
    const res = await fetch(url, { signal })
    if (!res.ok) throw new Error(`fetchVolume failed: ${res.status}`)
    const buffer = await res.arrayBuffer()
    const { header, data } = await parseBinaryResponse<VolumeHeader>(buffer)
    return { header, data } as ParsedVolume
  })
}

/** Fetch isosurface mesh (verts/faces/normals). */
export async function fetchIsosurface(params: {
  source:    string
  var:       string
  threshold: number
  time:      number
  bbox:      [number, number, number, number]
  mode?:     'live' | 'cached'
}, signal?: AbortSignal): Promise<ParsedIsosurface> {
  const { source, var: variable, threshold, time, bbox, mode = 'live' } = params
  const key = `iso:${source}:${variable}:${threshold}:${time}:${bboxStr(bbox)}:${mode}`

  return dedupe(key, async () => {
    const url = `${API_BASE}/isosurface?source=${source}&var=${variable}&threshold=${threshold}&time=${time}&bbox=${bboxStr(bbox)}&mode=${mode}`
    const res = await fetch(url, { signal })
    if (!res.ok) throw new Error(`fetchIsosurface failed: ${res.status}`)
    const buffer = await res.arrayBuffer()
    return parseIsosurfaceBinary(buffer)
  })
}

/** Fetch instrument positions within a bounding box. */
export async function fetchInstruments(params: {
  bbox: [number, number, number, number]
  type?: string
}, signal?: AbortSignal): Promise<InstrumentsResponse> {
  const { bbox, type } = params
  const typeParam = type ? `&type=${type}` : ''
  const url = `${API_BASE}/instruments?bbox=${bboxStr(bbox)}${typeParam}`
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`fetchInstruments failed: ${res.status}`)
  return res.json()
}

/** Coarse full-extent slice for a source/var — used to paint an instant placeholder gradient. */
export async function fetchSlicePreview(params: {
  source: string
  var:    string
  time:   number
}, signal?: AbortSignal): Promise<ParsedSlice> {
  const { source, var: variable, time } = params
  const key = `preview:${source}:${variable}:${time}`

  return dedupe(key, async () => {
    const url = `${API_BASE}/slice/preview?source=${source}&var=${variable}&time=${time}`
    const res = await fetch(url, { signal })
    if (!res.ok) throw new Error(`fetchSlicePreview failed: ${res.status}`)
    const buffer = await res.arrayBuffer()
    const { header, data } = await parseBinaryResponse<SliceHeader>(buffer)
    return { header, data } as ParsedSlice
  })
}

/** "Last updated" bookkeeping for every region/source/var ever fetched — for the cache-status panel. */
export async function fetchLastUpdated(signal?: AbortSignal): Promise<LastUpdatedEntry[]> {
  const res = await fetch(`${API_BASE}/metrics/last-updated`, { signal })
  if (!res.ok) throw new Error(`fetchLastUpdated failed: ${res.status}`)
  const json = await res.json()
  return json.entries as LastUpdatedEntry[]
}

/** Fetch a depth profile for a single platform, optionally comparing to a model source. */
export async function fetchProfile(platformId: string, source?: string, timeIdx?: number, signal?: AbortSignal): Promise<DepthProfile> {
  const sourceParam = source ? `&source=${encodeURIComponent(source)}&time_idx=${timeIdx ?? 0}` : ''
  const key = `profile:${platformId}${sourceParam}`
  return dedupe(key, async () => {
    const res = await fetch(`${API_BASE}/profile?platform_id=${encodeURIComponent(platformId)}${sourceParam}`, { signal })
    if (!res.ok) throw new Error(`fetchProfile failed: ${res.status}`)
    return res.json() as Promise<DepthProfile>
  })
}
