/**
 * Region search — geocodes a free-text place/sea name (e.g. "Arabian Sea",
 * "Andaman Sea", "Lakshadweep") to a bounding box, via OpenStreetMap's Nominatim.
 *
 * Nominatim is public, free, and needs no API key — but its usage policy (see
 * https://operations.osmfoundation.org/policies/nominatim/) asks for a descriptive
 * User-Agent/Referer and caps usage at ~1 request/second, which a manual search box
 * comfortably respects. Do not wire this to anything that fires automatically/rapidly.
 */

export interface GeocodeResult {
  label: string
  bbox: [number, number, number, number]  // [minLon, minLat, maxLon, maxLat]
  lat: number
  lon: number
}

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search'

export async function geocodeRegion(query: string, signal?: AbortSignal): Promise<GeocodeResult[]> {
  const url = `${NOMINATIM_URL}?format=jsonv2&limit=5&q=${encodeURIComponent(query)}`
  const res = await fetch(url, {
    signal,
    headers: { 'Accept': 'application/json' },
  })
  if (!res.ok) throw new Error(`Geocoding failed: ${res.status}`)
  const json = await res.json()

  return (json as any[]).map(r => {
    // Nominatim's boundingbox is [south, north, west, east] as STRINGS.
    const [south, north, west, east] = (r.boundingbox as string[]).map(Number)
    let bbox: [number, number, number, number] = [west, south, east, north]

    // Some results (a single point-like place) come back with a near-zero-area box; others
    // (an ocean/sea the size of "Indian Ocean") come back enormous. Both get clamped to a
    // sane span around the result's centre — too small and there's no region to fetch data
    // for; too large and a first-time live Copernicus fetch (uncached region) gets slow fast,
    // since payload size scales with area. 20 degrees still comfortably covers real seas
    // (Arabian Sea, Andaman Sea, ...) without ballooning the fetch.
    const MIN_SPAN = 2   // degrees
    const MAX_SPAN = 20  // degrees
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
    }
  })
}
