/**
 * Pre-warm the India-ocean region so the first click/drag pick in "India" view scope resolves
 * fast instead of cold. Each /api/slice or /api/volume call makes the backend open the region's
 * NetCDF once (the slow part) and land the result in Redis + its on-disk cache — so a subsequent
 * pick of a nearby bbox reuses the warm file handle / cached tiles rather than paying a cold
 * open (or, online, a cold live-Copernicus fetch).
 *
 * Best-effort and fire-and-forget: failures are swallowed, requests are spaced out so they never
 * contend with the researcher's own first actions.
 */
import { fetchSlice } from './client'

import { useTarangStore } from '../state/store'

// The India ocean basin (Arabian Sea + Bay of Bengal) and its two halves — warming these opens
// the region's NetCDF so a later pick reuses the warm file handle / cached tiles.
const INDIA_WARM_BBOXES: [number, number, number, number][] = [
  [80, 5, 100, 25],   // Bay of Bengal half
  [58, 2, 80, 26],    // Arabian Sea half (both within the EEZ-wide fixture extent)
]

let started = false

export function prewarmIndiaRegion(source: string, variable: string): void {
  if (started || !source || !variable) return
  started = true

  void (async () => {
    await sleep(6000)   // well clear of the researcher's own first search/click
    for (const bbox of INDIA_WARM_BBOXES) {
      // Skip the rest once the user has driven their own region — no point competing with it.
      if (useTarangStore.getState().hasSearchedRegion) return
      try { await fetchSlice({ source, var: variable, depth: 0, time: 0, bbox }) } catch { /* best-effort */ }
      await sleep(1200)
    }
  })()
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

// ── Time-step prefetch for smooth animation ───────────────────────────────────
// Playback advances activeTimeIdx on a timer; each step triggers a fresh /api/slice
// fetch. Warming every step in the background first (backend caches to Redis, and
// the client dedupes) means the player advances into already-computed frames
// instead of stalling on a cold fetch mid-loop.

const _warmedLoops = new Set<string>()

export function prewarmTimeSteps(params: {
  source: string
  variable: string
  depth: number
  bbox: [number, number, number, number]
  nSteps: number
}): void {
  const { source, variable, depth, bbox, nSteps } = params
  if (!source || !variable || nSteps <= 1) return
  const loopKey = `${source}:${variable}:${depth}:${bbox.join(',')}:${nSteps}`
  if (_warmedLoops.has(loopKey)) return
  _warmedLoops.add(loopKey)
  if (_warmedLoops.size > 12) _warmedLoops.delete(_warmedLoops.values().next().value as string)

  void (async () => {
    for (let t = 0; t < nSteps; t++) {
      try { await fetchSlice({ source, var: variable, depth, time: t, bbox }) }
      catch { /* best-effort; a failed frame just isn't pre-warmed */ }
      await sleep(120)   // gentle — don't stampede the backend workers
    }
  })()
}
