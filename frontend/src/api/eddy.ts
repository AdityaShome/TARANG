import type { EddyCell, FrontCell } from './types'

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api'

export async function fetchEddyDetection(params: {
  source: string
  time: number
  bbox: [number, number, number, number]
  threshold?: number
}, signal?: AbortSignal): Promise<EddyCell[]> {
  const { source, time, bbox, threshold = 2e-11 } = params
  const bboxStr = bbox.join(',')
  const url = `${API_BASE}/eddy?source=${source}&time=${time}&bbox=${bboxStr}&threshold=${threshold}`
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`fetchEddyDetection failed: ${res.status}`)
  const json = await res.json()
  return json.cells
}

export async function fetchFrontDetection(params: {
  source: string
  var: string
  time: number
  bbox: [number, number, number, number]
  threshold?: number
}, signal?: AbortSignal): Promise<FrontCell[]> {
  const { source, var: variable, time, bbox, threshold = 0.05 } = params
  const bboxStr = bbox.join(',')
  const url = `${API_BASE}/front?source=${source}&var=${variable}&time=${time}&bbox=${bboxStr}&threshold=${threshold}`
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`fetchFrontDetection failed: ${res.status}`)
  const json = await res.json()
  return json.cells
}
