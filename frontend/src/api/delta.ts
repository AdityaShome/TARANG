const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api'

export interface DeltaCell {
  platform_id: string
  lat: number
  lon: number
  delta: number
  type: string
}

export async function fetchDeltaOverlay(params: {
  source: string
  timeIdx: number
  bbox: [number, number, number, number]
}, signal?: AbortSignal): Promise<DeltaCell[]> {
  const { source, timeIdx, bbox } = params
  const bboxStr = bbox.join(',')
  const url = `${API_BASE}/delta?source=${source}&time_idx=${timeIdx}&bbox=${bboxStr}`
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`fetchDeltaOverlay failed: ${res.status}`)
  const json = await res.json()
  return json.deltas
}
