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

const DEFAULT_BBOX: [number, number, number, number] = [80, 5, 100, 25]  // Bay of Bengal

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
  setDepthLevels:      (levels: number[])      => void
  setTimeSteps:        (steps: string[])       => void
  setRenderMode:       (mode: RenderMode)      => void
  setIsoThreshold:     (v: number)             => void
  setColormap:         (cfg: Partial<ColormapConfig>) => void
  setColormapName:     (name: ColormapName)    => void
  setSelectedPlatform: (id: string | null)     => void
  setSources:          (s: SourceEntry[])      => void
  setLoading:          (v: boolean)            => void
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
    error:               null,

    sources:             [],
    activeSourceId:      'hycom_water_temp',
    activeVar:           'water_temp',

    activeDepthIdx:      0,
    activeTimeIdx:       0,
    bbox:                DEFAULT_BBOX,
    depthLevels:         [],
    timeSteps:           [],

    renderMode:          'slice',
    isoThreshold:        20,     // 20°C isotherm — good default for BoB
    colormap:            DEFAULT_COLORMAP,

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
    setActiveSource:     (id)      => set({ activeSourceId: id, activeDepthIdx: 0, activeTimeIdx: 0 }),
    setActiveVar:        (v)       => set({ activeVar: v }),
    setActiveDepthIdx:   (idx)     => set({ activeDepthIdx: idx }),
    setActiveTimeIdx:    (idx)     => set({ activeTimeIdx: idx }),
    setBbox:             (bbox)    => set({ bbox }),
    setDepthLevels:      (levels)  => set({ depthLevels: levels }),
    setTimeSteps:        (steps)   => set({ timeSteps: steps }),
    setRenderMode:       (mode)    => set({ renderMode: mode }),
    setIsoThreshold:     (v)       => set({ isoThreshold: v }),
    setColormap:         (cfg)     => set(s => ({ colormap: { ...s.colormap, ...cfg } })),
    setColormapName:     (name)    => set(s => ({ colormap: { ...s.colormap, name } })),
    setSelectedPlatform: (id)      => set({ selectedPlatformId: id }),
    setSources:          (sources) => set({ sources }),
    setLoading:          (v)       => set({ isLoading: v }),
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
