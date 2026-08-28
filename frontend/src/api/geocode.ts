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

      // Clamp only a near-zero-area box (e.g. a single street address) up to a visible size.
      // MAX_SPAN used to be 20deg, which crushed genuinely huge features — searching "Pacific
      // Ocean" (Nominatim returns a ~150+deg-wide box) got shrunk to a tiny 20deg square, i.e.
      // a real ocean search rendered as a barely-there patch. 90deg still bounds truly runaway
      // results (a bad geocode matching most of the globe) without nuking legitimate large seas.
      // Note: this bbox format has no antimeridian wraparound (assumes minLon < maxLon), so a
      // basin actually centred on the 180deg line (like the Pacific) still renders as whichever
      // arbitrary non-wrapping slice Nominatim's own bounding box happens to fall on — a real
      // limitation of the [minLon,minLat,maxLon,maxLat] convention used throughout this app, not
      // fixable by adjusting the clamp alone.
      const MIN_SPAN = 2, MAX_SPAN = 90  // degrees
      const [minLon, minLat, maxLon, maxLat] = bbox
      const spanLon = maxLon - minLon
      const spanLat = maxLat - minLat
      if (spanLon < MIN_SPAN || spanLat < MIN_SPAN || spanLon > MAX_SPAN || spanLat > MAX_SPAN) {
        const cLon = (minLon + maxLon) / 2
        const cLat = (minLat + maxLat) / 2
        const halfLon = Math.min(Math.max(spanLon, MIN_SPAN), MAX_SPAN) / 2
        const halfLat = Math.min(Math.max(spanLat, MIN_SPAN), MAX_SPAN) / 2
        bbox = [cLon - halfLon, cLat - halfLat, cLon + halfLon, cLat + halfLat]
      }

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
