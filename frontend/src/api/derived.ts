import { API_BASE } from './client'

export interface WaterMassCentroid {
  label: number
  temperature: number
  salinity: number
  count: number
  fraction: number
}

export interface WaterMassResult {
  product: 'water_masses'
  method: string
  source: string
  variables: { temperature: string; salinity: string }
  depth_m: number
  k: number
  shape: [number, number]        // [lat, lon]
  bounds: { lon: [number, number]; lat: [number, number] }
  labels: number[]               // flat lat-major, row 0 = south; -1 = no data
  centroids: WaterMassCentroid[]
}

export interface WaterMassParams {
  source: string
  time: number
  depth: number
  bbox: [number, number, number, number]
  k?: number
}

export async function fetchWaterMasses(p: WaterMassParams, signal?: AbortSignal): Promise<WaterMassResult> {
  const qs = new URLSearchParams({
    source: p.source,
    time: String(p.time),
    depth: String(p.depth),
    bbox: p.bbox.join(','),
    k: String(p.k ?? 4),
  })
  const res = await fetch(`${API_BASE}/derived/water_masses?${qs}`, { signal })
  if (!res.ok) {
    let msg = `water_masses failed (${res.status})`
    try { const j = await res.json(); if (j?.detail) msg = typeof j.detail === 'string' ? j.detail : msg } catch { /* ignore */ }
    throw new Error(msg)
  }
  return res.json() as Promise<WaterMassResult>
}

// Distinct categorical colours for up to 8 water-mass classes ( colour-blind-safe-ish).
export const WATER_MASS_COLORS = [
  '#4c78a8', '#f58518', '#54a24b', '#e45756',
  '#72b7b2', '#b279a2', '#ff9da6', '#9d755d',
]
