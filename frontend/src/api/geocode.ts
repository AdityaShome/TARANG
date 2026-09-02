// Place/sea name → bounding box. Offline-first: the built-in REGION_CATALOG is
// checked before any Nominatim call, so the demo path never touches the network.

import { REGION_CATALOG, searchLocalRegions } from './regions'

export interface GeocodeResult {
  label: string
  bbox: [number, number, number, number]  // [minLon, minLat, maxLon, maxLat]
  lat: number
  lon: number
  offline?: boolean   // true → from the local catalogue
}

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search'

// The lon/lat span envelope every region fed to the renderers must fall within. The volume
// raymarch and marching-cubes grid were tuned against search-sized boxes; a sliver box starves
// the marching-cubes grid (near-empty geometry) and a 100deg+ box over-stretches the downsampled
// voxel cube. The search path has always enforced this; click/drag picks must use the SAME clamp
// (see clampRegionSpan) so all three selection methods produce boxes in one size range.
export const REGION_MIN_SPAN_DEG = 2
export const REGION_MAX_SPAN_DEG = 90

// Interactive picks (click / drag on the globe) get a tighter ceiling than name searches. A
// named "Pacific Ocean" legitimately needs ~150deg → 90deg; a hand-drawn box or a fixed-size
// click never should. Two reasons for the cap:
//   1. Coherence — a big drag was producing a 90x90deg "region" with instrument markers smeared
//      across 30deg+ of latitude that read as two disconnected clusters, not one area.
//   2. Fetchability — a novel (un-cached) 24deg box live-fetches fine; a 40deg one is ~2.7x the
//      volume and times out at nginx's 120s proxy limit (502). Keeping picks near the verified-
//      fetchable size means drag/click actually render data, not a spinner.
// 40° lets a drag span the Arabian Sea + Bay of Bengal in one box (they're ~45° apart) while
// still bounding a runaway drag. A click stays a fixed 24° box.
export const REGION_MAX_PICK_SPAN_DEG = 40

/**
 * Clamp a [minLon, minLat, maxLon, maxLat] box so each of its lon/lat spans lies within
 * [REGION_MIN_SPAN_DEG, maxSpan], recentring on the original centre when a span is out of range.
 * A box already within range is returned unchanged.
 */
export function clampRegionSpan(
  bbox: [number, number, number, number],
  maxSpan: number = REGION_MAX_SPAN_DEG,
): [number, number, number, number] {
  const [minLon, minLat, maxLon, maxLat] = bbox
  const spanLon = maxLon - minLon
  const spanLat = maxLat - minLat
  const inRange =
    spanLon >= REGION_MIN_SPAN_DEG && spanLon <= maxSpan &&
    spanLat >= REGION_MIN_SPAN_DEG && spanLat <= maxSpan
  if (inRange) return bbox
  const cLon = (minLon + maxLon) / 2
  const cLat = (minLat + maxLat) / 2
  const halfLon = Math.min(Math.max(spanLon, REGION_MIN_SPAN_DEG), maxSpan) / 2
  const halfLat = Math.min(Math.max(spanLat, REGION_MIN_SPAN_DEG), maxSpan) / 2
  return [cLon - halfLon, cLat - halfLat, cLon + halfLon, cLat + halfLat]
}

function toResult(bbox: [number, number, number, number], label: string, offline: boolean): GeocodeResult {
  const [minLon, minLat, maxLon, maxLat] = bbox
  return { label, bbox, lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2, offline }
}

export async function geocodeRegion(query: string, signal?: AbortSignal): Promise<GeocodeResult[]> {
  const local = searchLocalRegions(query)
  if (local.length > 0) return local.map(r => toResult(r.bbox, r.name, true))

  // Online fallback for arbitrary place names.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return []

  try {
    const url = `${NOMINATIM_URL}?format=jsonv2&limit=5&q=${encodeURIComponent(query)}`
    const res = await fetch(url, { signal, headers: { 'Accept': 'application/json' } })
    if (!res.ok) return []
    const json = await res.json()

    return (json as any[]).map(r => {
      // Nominatim's boundingbox is [south, north, west, east] as STRINGS.
      const [south, north, west, east] = (r.boundingbox as string[]).map(Number)
      let bbox: [number, number, number, number] = [west, south, east, north]

      // Bring a near-zero-area box (a street address) up to a visible size and a runaway one
      // (a bad geocode matching half the globe) down to a sane one. REGION_MAX_SPAN_DEG is 90,
      // not 20, deliberately: 20 crushed genuinely huge features — "Pacific Ocean" (Nominatim
      // returns a ~150deg-wide box) got shrunk to a tiny square, rendering a real ocean as a
      // barely-there patch.
      // Note: this bbox format has no antimeridian wraparound (assumes minLon < maxLon), so a
      // basin actually centred on the 180deg line (like the Pacific) still renders as whichever
      // arbitrary non-wrapping slice Nominatim's own bounding box happens to fall on — a real
      // limitation of the [minLon,minLat,maxLon,maxLat] convention used throughout this app.
      bbox = clampRegionSpan(bbox)

      return {
        label: r.display_name as string,
        bbox,
        lat: parseFloat(r.lat),
        lon: parseFloat(r.lon),
        offline: false,
      }
    })
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    return []  // network error → "no match", never crash the search box
  }
}

export { REGION_CATALOG }
