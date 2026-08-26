/**
 * TARANG Central Zustand Store (§10 — State Management)
 *
 * Single source of truth for all app state.
 * The 3D scene subscribes and re-renders only layers whose inputs changed.
 * NOTHING touches Three.js directly from components — only through the store.
 *
 * State shape:
 *   uiMode          'console' | 'explorer'
 *   activeSourceId  string (registry ID)
 *   activeVar       string
 *   activeDepthIdx  index into depth_levels[] — NEVER a raw meter value (§20 Rule 4)
 *   activeTimeIdx   time step index
 *   bbox            [minLon, minLat, maxLon, maxLat]
 *   depthLevels     number[] (loaded from /api/metadata)
 *   timeSteps       string[]
 *   renderMode      'slice' | 'volume' | 'isosurface'
 *   isoThreshold    number
 *   colormap        ColormapConfig
 *   selectedPlatformId  string | null
 *   layerVisibility Record<string, boolean>
 *   sources         SourceEntry[]
 *   isLoading       boolean
 *   error           string | null
 */

import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type { UIMode, RenderMode, ColormapName, ColormapConfig, SourceEntry } from '../api/types'

// ── Default values ────────────────────────────────────────────────────────────

// Not shown by default — see hasSearchedRegion below. Only used as a harmless placeholder
// value for `bbox`'s type until the researcher actually searches a region.
const DEFAULT_BBOX: [number, number, number, number] = [80, 5, 100, 25]

const DEFAULT_COLORMAP: ColormapConfig = {
  name:                 'viridis',
  min:                  0,
  max:                  35,
  logScale:             false,
  opacity:              0.85,
  verticalExaggeration: 50,   // ocean depth needs strong vertical exaggeration for visual impact
}

// ── Store interface ───────────────────────────────────────────────────────────

interface TarangState {
  // UI
  uiMode:     UIMode
  isLoading:  boolean
  error:      string | null
  // Distinct from isLoading (which specifically gates the source-switch race in
  // SceneManager.tsx) — this just reflects whether a data-layer fetch is currently in flight,
  // for UI feedback (e.g. SearchBar's "fetching live data…" spinner after a region search).
  isFetchingLayers: boolean

  // Source selection
  sources:         SourceEntry[]
  activeSourceId:  string
  activeVar:       string

  // Spatial / temporal
  activeDepthIdx: number                            // index into depthLevels[]
  activeTimeIdx:  number
  bbox:           [number, number, number, number]  // [minLon, minLat, maxLon, maxLat]
  depthLevels:    number[]                          // NON-UNIFORM, from /api/metadata
  timeSteps:      string[]

  // Rendering
  renderMode:   RenderMode
  isoThreshold: number
  colormap:     ColormapConfig

  // Region search — label for display, and a one-shot camera fly-to target consumed by
  // SceneManager (cleared back to null right after it acts on it). hasSearchedRegion gates
  // whether SceneManager fetches/renders ANY data layer — there is no default sea; the
  // researcher picks one by searching, per the actual requirement (not a fixed demo region).
  regionLabel:       string | null
  flyToTarget:       { lat: number; lon: number } | null
  hasSearchedRegion: boolean

  // Instrument selection
  selectedPlatformId: string | null

  // Layer visibility (keyed by layer id)
  layerVisibility: Record<string, boolean>

  // ── Actions ───────────────────────────────────────────────────────────────
  setUIMode:           (mode: UIMode)          => void
  setActiveSource:     (id: string)            => void
  setActiveVar:        (variable: string)      => void
  setActiveDepthIdx:   (idx: number)           => void   // always an index, not meters
  setActiveTimeIdx:    (idx: number)           => void
  setBbox:             (bbox: [number, number, number, number]) => void
  searchRegion:        (bbox: [number, number, number, number], label: string) => void
  clearFlyToTarget:    () => void
  setDepthLevels:      (levels: number[])      => void
  setTimeSteps:        (steps: string[])       => void
  setRenderMode:       (mode: RenderMode)      => void
  setIsoThreshold:     (v: number)             => void
  setColormap:         (cfg: Partial<ColormapConfig>) => void
  setColormapName:     (name: ColormapName)    => void
  setSelectedPlatform: (id: string | null)     => void
  setSources:          (s: SourceEntry[])      => void
  setLoading:          (v: boolean)            => void
  setFetchingLayers:   (v: boolean)            => void
  setError:            (e: string | null)      => void
  toggleLayer:         (id: string)            => void

  // Derived helpers
  getActiveDepthM: () => number   // converts depthIdx → actual meter value
}

// ── Store implementation ──────────────────────────────────────────────────────

export const useTarangStore = create<TarangState>()(
  subscribeWithSelector((set, get) => ({
    // Defaults
    uiMode:              'console',
    isLoading:           false,
    isFetchingLayers:    false,
    error:               null,

    sources:             [],
    activeSourceId:      'copernicus_temp',
    // Left empty (not hardcoded to a guessed variable name) until App.tsx's bootstrap
    // effect fetches real metadata for activeSourceId and calls setActiveVar — see the
    // comment on setActiveSource below for why an empty activeVar matters.
    activeVar:           '',

    activeDepthIdx:      0,
    activeTimeIdx:       0,
    bbox:                DEFAULT_BBOX,
    depthLevels:         [],
    timeSteps:           [],

    renderMode:          'slice',
    isoThreshold:        20,     // 20°C isotherm — good default for BoB
    colormap:            DEFAULT_COLORMAP,

    regionLabel:         null,
    flyToTarget:         null,
    hasSearchedRegion:   false,

    selectedPlatformId:  null,
    layerVisibility:     {
      slice:      true,
      volume:     false,
      isosurface: false,
      markers:    true,
      vectors:    false,
    },

    // ── Actions ───────────────────────────────────────────────────────────────
    setUIMode:           (mode)    => set({ uiMode: mode }),
    // activeVar is cleared here (not just left stale) so it never briefly names a variable
    // that belongs to the PREVIOUS source. App.tsx's bootstrap effect re-fetches metadata for
    // the new source and calls setActiveVar once it knows the right name. Consumers (SceneManager,
    // Legend) treat an empty activeVar as "still loading" and skip firing requests / rendering.
    setActiveSource:     (id)      => set({ activeSourceId: id, activeVar: '', activeDepthIdx: 0, activeTimeIdx: 0 }),
    setActiveVar:        (v)       => set({ activeVar: v }),
    setActiveDepthIdx:   (idx)     => set({ activeDepthIdx: idx }),
    setActiveTimeIdx:    (idx)     => set({ activeTimeIdx: idx }),
    setBbox:             (bbox)    => set({ bbox }),
    // A region search changes WHERE every layer fetches data from (bbox — already reactive,
    // every layer's update() effect depends on it) and asks the camera to fly there. It does
    // NOT touch activeSourceId/activeVar — the same source/variable just gets re-queried for
    // the new bbox (live-fetched from Copernicus if outside a local source's cached extent).
    searchRegion:        (bbox, label) => {
      const [minLon, minLat, maxLon, maxLat] = bbox
      set({
        bbox,
        regionLabel: label,
        hasSearchedRegion: true,
        flyToTarget: { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 },
        activeDepthIdx: 0,
        activeTimeIdx: 0,
      })
    },
    clearFlyToTarget:    () => set({ flyToTarget: null }),
    setDepthLevels:      (levels)  => set({ depthLevels: levels }),
    setTimeSteps:        (steps)   => set({ timeSteps: steps }),
    setRenderMode:       (mode)    => set({ renderMode: mode }),
    setIsoThreshold:     (v)       => set({ isoThreshold: v }),
    setColormap:         (cfg)     => set(s => ({ colormap: { ...s.colormap, ...cfg } })),
    setColormapName:     (name)    => set(s => ({ colormap: { ...s.colormap, name } })),
    setSelectedPlatform: (id)      => set({ selectedPlatformId: id }),
    setSources:          (sources) => set({ sources }),
    setLoading:          (v)       => set({ isLoading: v }),
    setFetchingLayers:   (v)       => set({ isFetchingLayers: v }),
    setError:            (e)       => set({ error: e }),
    toggleLayer:         (id)      => set(s => ({
      layerVisibility: { ...s.layerVisibility, [id]: !s.layerVisibility[id] }
    })),

    // Converts current depthIdx → actual depth in meters (non-uniform lookup)
    getActiveDepthM: () => {
      const { depthLevels, activeDepthIdx } = get()
      return depthLevels[activeDepthIdx] ?? 0
    },
  }))
)

// ── Debounce helper (150ms — slider use) ──────────────────────────────────────
export function debounce<T extends unknown[]>(fn: (...args: T) => void, ms = 150) {
  let timer: ReturnType<typeof setTimeout>
  return (...args: T) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
}
