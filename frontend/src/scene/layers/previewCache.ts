/**
 * Client-side cache of each source/variable's coarse full-extent preview grid
 * (/api/slice/preview) plus a crop helper. DepthSliceLayer uses this to paint an instant
 * placeholder gradient the moment a region is picked, before the real regional fetch resolves —
 * "cache all parts of the ocean for a temporary gradient".
 *
 * The preview covers the source's ENTIRE default_bbox, so once it's been fetched once for a
 * given source/var/time, every subsequent region pick within that source's coverage can be
 * cropped from memory with zero network round-trip.
 */
import { fetchSlicePreview } from '../../api/client'
import type { ParsedSlice } from '../../api/types'

const _cache = new Map<string, ParsedSlice>()
const _inflight = new Map<string, Promise<ParsedSlice | null>>()

function keyOf(source: string, variable: string, timeIdx: number): string {
  return `${source}:${variable}:${timeIdx}`
}

/** Fetch (and cache) the full-extent preview for this source/var/time. Never throws. */
export function getOrFetchPreview(source: string, variable: string, timeIdx: number): Promise<ParsedSlice | null> {
  const key = keyOf(source, variable, timeIdx)
  const cached = _cache.get(key)
  if (cached) return Promise.resolve(cached)

  const existing = _inflight.get(key)
  if (existing) return existing

  const p = fetchSlicePreview({ source, var: variable, time: timeIdx })
    .then(result => { _cache.set(key, result); return result })
    .catch(() => null)
    .finally(() => _inflight.delete(key))
  _inflight.set(key, p)
  return p
}

/** Synchronous lookup — only returns something once getOrFetchPreview has resolved once. */
export function peekPreview(source: string, variable: string, timeIdx: number): ParsedSlice | null {
  return _cache.get(keyOf(source, variable, timeIdx)) ?? null
}

export interface CroppedGrid {
  data:   Float32Array
  width:  number   // lon count
  height: number   // lat count
  bounds: { lat: [number, number]; lon: [number, number] }
}

/** Crop a full-extent preview grid down to `bbox`, by nearest-index mapping. */
export function cropPreview(preview: ParsedSlice, bbox: [number, number, number, number]): CroppedGrid | null {
  const [minLon, minLat, maxLon, maxLat] = bbox
  const { data, header } = preview
  const [height, width] = header.shape
  const [plMin, plMax] = header.bounds.lon
  const [ptMin, ptMax] = header.bounds.lat
  if (plMax <= plMin || ptMax <= ptMin || width < 2 || height < 2) return null

  // The preview only covers header.bounds — currently each source's default_bbox (e.g. Bay of
  // Bengal), NOT the whole ocean. A region picked mostly/entirely outside that coverage has no
  // real preview data there; clamping indices to the nearest edge would smear that edge's pixels
  // across the whole selection instead of showing nothing, which reads as wrong data ("crooked"),
  // not a placeholder. Skip the preview rather than show that.
  const overlapLon = Math.max(0, Math.min(maxLon, plMax) - Math.max(minLon, plMin))
  const overlapLat = Math.max(0, Math.min(maxLat, ptMax) - Math.max(minLat, ptMin))
  const overlapArea = overlapLon * overlapLat
  const requestedArea = Math.max(1e-9, (maxLon - minLon) * (maxLat - minLat))
  if (overlapArea / requestedArea < 0.6) return null

  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
  const lonToX = (lon: number) => clamp(Math.round(((lon - plMin) / (plMax - plMin)) * (width - 1)), 0, width - 1)
  const latToY = (lat: number) => clamp(Math.round(((lat - ptMin) / (ptMax - ptMin)) * (height - 1)), 0, height - 1)

  let x0 = lonToX(minLon), x1 = lonToX(maxLon)
  let y0 = latToY(minLat), y1 = latToY(maxLat)
  if (x1 <= x0) x1 = Math.min(width - 1, x0 + 1)
  if (y1 <= y0) y1 = Math.min(height - 1, y0 + 1)

  const w = x1 - x0 + 1
  const h = y1 - y0 + 1
  const out = new Float32Array(w * h)
  for (let row = 0; row < h; row++) {
    const srcRow = (y0 + row) * width
    out.set(data.subarray(srcRow + x0, srcRow + x0 + w), row * w)
  }

  return { data: out, width: w, height: h, bounds: { lat: [minLat, maxLat], lon: [minLon, maxLon] } }
}
