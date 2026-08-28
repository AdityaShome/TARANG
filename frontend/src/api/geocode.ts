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

      // Clamp a near-zero-area or ocean-sized box to a sane span around its centre.
      const MIN_SPAN = 2, MAX_SPAN = 20  // degrees
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
