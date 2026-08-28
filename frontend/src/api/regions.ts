// Offline region catalogue — Indian coastal / EEZ regions with pre-resolved
// bboxes so region search needs no network (geocode.ts checks this before Nominatim).
// bbox = [minLon, minLat, maxLon, maxLat].

export interface CatalogRegion {
  name: string
  aliases?: string[]
  bbox: [number, number, number, number]
  hasModelData?: boolean   // true → the pre-cached HYCOM/Copernicus fixtures cover this box
}

export const REGION_CATALOG: CatalogRegion[] = [
  // ── World oceans ─────────────────────────────────────────────────────────
  // Nominatim's free-text search is unreliable for these — its top match for "Pacific Ocean"
  // is a near-zero-area point (some mislabeled POI, not the ocean polygon), which the geocoder's
  // MIN_SPAN clamp then expands to a tiny 2deg box — a real ocean search rendering as a barely-
  // there patch. Hardcode these instead of depending on OSM's point-vs-polygon disambiguation.
  // bbox format here has no antimeridian wraparound (assumes minLon < maxLon, same limitation as
  // the rest of this app's bbox convention), so Pacific/Southern/Arctic use the largest
  // non-wrapping approximation rather than their true full extent.
  { name: 'Pacific Ocean', bbox: [120, -60, 180, 60] },
  { name: 'Atlantic Ocean', bbox: [-70, -60, 20, 65] },
  { name: 'Southern Ocean', aliases: ['antarctic ocean'], bbox: [-180, -80, 180, -60] },
  { name: 'Arctic Ocean', bbox: [-180, 66, 180, 90] },

  // ── Primary seas ─────────────────────────────────────────────────────────
  { name: 'Bay of Bengal', aliases: ['bob'], bbox: [80, 5, 100, 22], hasModelData: true },
  { name: 'Arabian Sea', bbox: [55, 5, 75, 25], hasModelData: true },
  { name: 'Andaman Sea', bbox: [92, 6, 99, 16], hasModelData: true },
  { name: 'Laccadive Sea', aliases: ['lakshadweep sea'], bbox: [71, 6, 78, 14] },
  { name: 'Indian Ocean', bbox: [45, -15, 100, 25] },
  { name: 'North Indian Ocean', bbox: [55, 0, 95, 25] },
  { name: 'Equatorial Indian Ocean', bbox: [55, -8, 95, 6] },

  // ── Gulfs, straits, bays ─────────────────────────────────────────────────
  { name: 'Gulf of Mannar', bbox: [78, 7.5, 80, 10], hasModelData: true },
  { name: 'Palk Strait', aliases: ['palk bay'], bbox: [79, 9, 80.5, 10.6], hasModelData: true },
  { name: 'Gulf of Khambhat', aliases: ['gulf of cambay'], bbox: [71.5, 20, 73, 22.5] },
  { name: 'Gulf of Kutch', aliases: ['gulf of kachchh'], bbox: [68.3, 22, 70.5, 23.6] },
  { name: 'Sundarbans', aliases: ['bengal delta', 'ganges delta'], bbox: [87, 20.5, 90, 22.5], hasModelData: true },
  { name: 'Lakshadweep', aliases: ['lakshadweep islands'], bbox: [71, 8, 74.5, 12.5] },
  { name: 'Andaman and Nicobar Islands', aliases: ['andaman islands', 'nicobar islands'], bbox: [91.5, 6, 94.5, 14], hasModelData: true },

  // ── Coastal stretches ───────────────────────────────────────────────────
  { name: 'Gujarat coast', bbox: [68, 19.5, 73, 23.5] },
  { name: 'Konkan coast', bbox: [72.3, 15, 74, 18.5] },
  { name: 'Malabar coast', bbox: [74.3, 8, 76.5, 13] },
  { name: 'Kerala coast', bbox: [74.5, 8, 77.5, 13] },
  { name: 'Coromandel coast', aliases: ['tamil nadu coast'], bbox: [79, 8, 81.5, 14], hasModelData: true },
  { name: 'Andhra Pradesh coast', bbox: [80, 13.5, 85, 19.5], hasModelData: true },
  { name: 'Odisha coast', bbox: [85, 17.5, 88, 21.5], hasModelData: true },
  { name: 'West Bengal coast', bbox: [86.5, 20, 89, 22], hasModelData: true },

  // ── Coastal cities / ports ──────────────────────────────────────────────
  { name: 'Mumbai coast', aliases: ['bombay'], bbox: [71.8, 18, 73.2, 19.6] },
  { name: 'Goa coast', bbox: [73, 14.7, 74.3, 15.9] },
  { name: 'Kochi', aliases: ['cochin'], bbox: [75.2, 9.3, 76.4, 10.4] },
  { name: 'Chennai', aliases: ['madras'], bbox: [79.8, 12.4, 81.2, 13.6], hasModelData: true },
  { name: 'Visakhapatnam', aliases: ['vizag'], bbox: [82.8, 17, 84.2, 18.4], hasModelData: true },
  { name: 'Paradip', bbox: [86, 19.5, 87.3, 20.7], hasModelData: true },
  { name: 'Puducherry', aliases: ['pondicherry'], bbox: [79.4, 11.3, 80.4, 12.3], hasModelData: true },
  { name: 'Kolkata', aliases: ['calcutta'], bbox: [87.5, 20.5, 89, 22.3], hasModelData: true },
  { name: 'Port Blair', bbox: [92.4, 11, 93.2, 12], hasModelData: true },
  { name: 'Kanyakumari', aliases: ['cape comorin'], bbox: [77, 7.5, 78.3, 8.6] },
]

/** Case-insensitive substring match over region names + aliases. */
export function searchLocalRegions(query: string): CatalogRegion[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const starts: CatalogRegion[] = []
  const contains: CatalogRegion[] = []
  for (const r of REGION_CATALOG) {
    const hay = [r.name.toLowerCase(), ...(r.aliases ?? [])]
    if (hay.some(h => h === q || h.startsWith(q))) starts.push(r)
    else if (hay.some(h => h.includes(q))) contains.push(r)
  }
  return [...starts, ...contains]
}
