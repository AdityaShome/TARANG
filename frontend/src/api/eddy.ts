import type { EddyCell, FrontCell } from './types'

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api'

export async function fetchEddyDetection(params: {
  source: string
  time: number
  bbox: [number, number, number, number]
  threshold?: number   // omitted → backend auto-scales to the dataset
}, signal?: AbortSignal): Promise<EddyCell[]> {
  const { source, time, bbox, threshold } = params
  const q = threshold != null ? `&threshold=${threshold}` : ''
  const url = `${API_BASE}/eddy?source=${source}&time=${time}&bbox=${bbox.join(',')}${q}`
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`fetchEddyDetection failed: ${res.status}`)
  return (await res.json()).cells
}

export async function fetchFrontDetection(params: {
  source: string
  var: string
  time: number
  bbox: [number, number, number, number]
  threshold?: number   // omitted → backend auto-scales to the field
}, signal?: AbortSignal): Promise<FrontCell[]> {
  const { source, var: variable, time, bbox, threshold } = params
  const q = threshold != null ? `&threshold=${threshold}` : ''
  const url = `${API_BASE}/front?source=${source}&var=${variable}&time=${time}&bbox=${bbox.join(',')}${q}`
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`fetchFrontDetection failed: ${res.status}`)
  return (await res.json()).cells
}
