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
import type { UIMode, RenderMode, ColormapName, ColormapConfig, SourceEntry, SourceMetadata } from '../api/types'

type CFMetaMap = SourceMetadata['cf_metadata']   // per-variable CF metadata from /api/metadata
import type { LanguageCode } from '../i18n/translations'

const LANGUAGE_STORAGE_KEY = 'tarang_language'

function loadStoredLanguage(): LanguageCode {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY)
    if (stored === 'en' || stored === 'hi' || stored === 'bn' || stored === 'te' || stored === 'ta') return stored
  } catch { /* localStorage unavailable (SSR/private mode) — fall through to default */ }
  return 'en'
}

// ── Default values ────────────────────────────────────────────────────────────

// Not shown by default — see hasSearchedRegion below. Only used as a harmless placeholder
// value for `bbox`'s type until the researcher actually searches a region.
const DEFAULT_BBOX: [number, number, number, number] = [80, 5, 100, 25]

// Camera framing per view scope (lat/lon centre + distance as a multiple of EARTH_RADIUS).
// India: the Arabian Sea + Bay of Bengal basins in one frame, a touch wider than the EEZ so it
// doesn't look clipped. Globe: the wide Indian-Ocean view the app has always opened on.
export const VIEW_SCOPE_PRESETS = {
  india: { lat: 11, lon: 77, distanceMult: 1.95 },
  globe: { lat: 5,  lon: 65, distanceMult: 4.0 },
} as const

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
  language:   LanguageCode
  isLoading:  boolean
  error:      string | null
  showHomeOverlay: boolean
  // Distinct from isLoading (which specifically gates the source-switch race in
  // SceneManager.tsx) — this just reflects whether a data-layer fetch is currently in flight,
  // for UI feedback (e.g. SearchBar's "fetching live data…" spinner after a region search).
  // for UI feedback (e.g. SearchBar's "fetching live data…" spinner after a region search).
  isFetchingLayers: boolean

  // Data Source Mode (live from copernicus vs fast byte-range stream from B2 cache)
  dataSourceMode: 'live' | 'cached'

  // Source selection
  sources:         SourceEntry[]
  activeSourceId:  string
  activeVar:       string
  availableVariables: string[]   // every variable the active source exposes — drives the var dropdown
  cfMetadata:         CFMetaMap

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

  // Region search: display label, one-shot camera fly-to (SceneManager clears it), and a
  // gate — no data layer renders until a region has been searched.
  regionLabel:       string | null
  // distanceMult (× EARTH_RADIUS) is optional: a region search omits it (keep current zoom),
  // a view-scope switch sets it (India = close, Globe = wide).
  flyToTarget:       { lat: number; lon: number; distanceMult?: number } | null
  hasSearchedRegion: boolean

  // 'india' (default) frames the camera on the India ocean basin (~60-100°E, 0-25°N) — the
  // primary demo experience; 'globe' is the unrestricted rotating view. Toggling only reframes
  // the camera — the searched region, data and markers are all preserved.
  viewScope: 'india' | 'globe'

  // Set by DepthSliceLayer when a region's slice fetch comes back empty/degenerate (offline +
  // no cached data for that bbox) — the layer hides itself and the UI shows a clear message
  // instead of leaving the previous region's overlay on screen.
  regionDataMissing: boolean

  // Pick-a-region-on-the-globe: 'off' (normal orbit/click-marker behaviour), 'click' (next
  // click on the globe surface becomes a fixed-size region centred there), 'drag' (drag out a
  // custom rectangle). SceneManager reads this to know whether to raycast the globe instead of
  // orbiting, and resets it to 'off' itself once a pick completes (one-shot, not a sticky mode).
  mapSelectMode: 'off' | 'click' | 'drag'

  // Instrument selection
  selectedPlatformId: string | null

  // Layer visibility (keyed by layer id)
  layerVisibility: Record<string, boolean>

  // ── Actions ───────────────────────────────────────────────────────────────
  setUIMode:           (mode: UIMode)          => void
  setLanguage:         (lang: LanguageCode)    => void
  setDataSourceMode:   (mode: 'live' | 'cached') => void
  setActiveSource:     (id: string)            => void
  setActiveVar:        (variable: string)      => void
  setVariableMeta:     (vars: string[], cf: CFMetaMap) => void
  setActiveDepthIdx:   (idx: number)           => void   // always an index, not meters
  setActiveTimeIdx:    (idx: number)           => void
  setBbox:             (bbox: [number, number, number, number]) => void
  searchRegion:        (bbox: [number, number, number, number], label: string) => void
  clearFlyToTarget:    () => void
  setViewScope:        (scope: 'india' | 'globe') => void
  setRegionDataMissing: (v: boolean) => void
  setMapSelectMode:    (mode: 'off' | 'click' | 'drag') => void
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
  setShowHomeOverlay:  (v: boolean)            => void
  toggleLayer:         (id: string)            => void

  // Derived helpers
  getActiveDepthM: () => number   // converts depthIdx → actual meter value
}

// ── Store implementation ──────────────────────────────────────────────────────

export const useTarangStore = create<TarangState>()(
  subscribeWithSelector((set, get) => ({
    // Defaults
    uiMode:              'console',
    language:            loadStoredLanguage(),
    isLoading:           false,
    isFetchingLayers:    false,
    dataSourceMode:      'live',
    error:               null,
    showHomeOverlay:     true,

    sources:             [],
    activeSourceId:      'copernicus_marine',
    activeVar:           '',   // set by App.tsx once metadata for activeSourceId loads
    availableVariables:  [],
    cfMetadata:          {},

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
    viewScope:           'india',
    regionDataMissing:   false,
    mapSelectMode:       'off',

    selectedPlatformId:  null,
    layerVisibility:     {
      slice:      true,
      volume:     false,
      isosurface: false,
      cube:       false,
      markers:    true,
      vectors:    false,
      eddy:       false,
      fronts:     false,
      delta:      false,
    },

    // ── Actions ───────────────────────────────────────────────────────────────
    setUIMode:           (mode)    => set({ uiMode: mode }),
    setLanguage:         (lang)    => {
      try { localStorage.setItem(LANGUAGE_STORAGE_KEY, lang) } catch { /* private mode — non-fatal */ }
      set({ language: lang })
    },
    setDataSourceMode:   (mode)    => set({ dataSourceMode: mode }),
    // Clear activeVar + the var list so nothing briefly names a variable from the old source;
    // App.tsx re-fetches metadata and calls setActiveVar with the right name.
    setActiveSource:     (id)      => set({
      activeSourceId: id, activeVar: '', activeDepthIdx: 0, activeTimeIdx: 0,
      availableVariables: [], cfMetadata: {},
    }),
    // Also re-seed the colour range from the new variable's CF valid_min/valid_max.
    setActiveVar:        (v)       => set(s => {
      const cf = s.cfMetadata[v]
      if (!cf || !Number.isFinite(cf.valid_min) || !Number.isFinite(cf.valid_max)) {
        return { activeVar: v }
      }
      return { activeVar: v, colormap: { ...s.colormap, min: cf.valid_min, max: cf.valid_max } }
    }),
    setVariableMeta:     (vars, cf) => set({ availableVariables: vars, cfMetadata: cf }),
    setActiveDepthIdx:   (idx)     => set({ activeDepthIdx: idx }),
    setActiveTimeIdx:    (idx)     => set({ activeTimeIdx: idx }),
    setBbox:             (bbox)    => set({ bbox }),
    // Changes the bbox (every layer re-fetches) and flies the camera there; source/var unchanged.
    // Also disarms any active click/drag map-pick mode — a name search is an explicit override,
    // so a still-armed pick must not turn the researcher's next globe click into a stray region.
    searchRegion:        (bbox, label) => {
      const [minLon, minLat, maxLon, maxLat] = bbox
      set({
        bbox,
        regionLabel: label,
        hasSearchedRegion: true,
        flyToTarget: { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 },
        mapSelectMode: 'off',
        regionDataMissing: false,   // re-evaluated by DepthSliceLayer on the new fetch
        activeDepthIdx: 0,
        activeTimeIdx: 0,
      })
    },
    clearFlyToTarget:    () => set({ flyToTarget: null }),
    // Swaps the whole view (2D India map ⇄ 3D globe). The searched region / data / markers are
    // all preserved in the store, so each view just re-renders them — a toggle is a deliberate
    // choice, not a reset.
    setViewScope:        (scope) => set({ viewScope: scope }),
    setRegionDataMissing: (v) => set({ regionDataMissing: v }),
    setMapSelectMode:    (mode) => set({ mapSelectMode: mode }),
    setDepthLevels:      (levels)  => set({ depthLevels: levels }),
    setTimeSteps:        (steps)   => set({ timeSteps: steps }),
    // Switching render mode must also turn that layer on — slice/volume/isosurface
    // are mutually exclusive views, so the other two are turned off to avoid
    // fetching/rendering a hidden layer that can never be seen.
    setRenderMode:       (mode)    => set(s => ({
      renderMode: mode,
      layerVisibility: {
        ...s.layerVisibility,
        slice:      mode === 'slice',
        volume:     mode === 'volume',
        isosurface: mode === 'isosurface',
        cube:       mode === 'cube',
      },
    })),
    setIsoThreshold:     (v)       => set({ isoThreshold: v }),
    setColormap:         (cfg)     => set(s => ({ colormap: { ...s.colormap, ...cfg } })),
    setColormapName:     (name)    => set(s => ({ colormap: { ...s.colormap, name } })),
    setSelectedPlatform: (id)      => set({ selectedPlatformId: id }),
    setSources:          (sources) => set({ sources }),
    setLoading:          (v)       => set({ isLoading: v }),
    setFetchingLayers:   (v)       => set({ isFetchingLayers: v }),
    setError:            (e)       => set({ error: e }),
    setShowHomeOverlay:  (v)       => set({ showHomeOverlay: v }),
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
