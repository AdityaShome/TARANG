/**
 * TARANG TypeScript API Types
 *
 * These types mirror the backend wire format exactly (§8.6).
 * CF metadata fields are pulled from the backend — NEVER hand-typed here. (§20 Rule 2)
 */

// ── CF Metadata (from backend JSON header) ────────────────────────────────────
export interface CFMetadata {
  variable:      string
  standard_name: string
  long_name:     string
  units:         string
  missing_value: number
  valid_min:     number
  valid_max:     number
  dtype:         string
  depth_levels:  number[]     // NON-UNIFORM — never assume linear spacing (§8.1)
  bounds: {
    lat?:   [number, number]
    lon?:   [number, number]
    depth?: number[]
  }
}

// Adapters that implement get_slice()/get_volume() always populate bounds.lat
// and bounds.lon (see backend/app/adapters/netcdf_adapter.py) — narrower than
// the base CFMetadata.bounds, which is optional for the /metadata endpoint.
interface ResolvedBounds {
  lat:   [number, number]
  lon:   [number, number]
  depth: number[]
}

// ── Binary response headers (prepended to Float32Array body) ──────────────────
export interface SliceHeader extends CFMetadata {
  shape:          [number, number]   // [lat, lon]
  depth_actual_m: number
  time:           string
  bounds:         ResolvedBounds
}

export interface VolumeHeader extends CFMetadata {
  shape:  [number, number, number]   // [depth, lat, lon]
  time:   string
  bounds: ResolvedBounds
}

export interface IsosurfaceHeader extends CFMetadata {
  n_verts:      number
  n_faces:      number
  dtype_verts:  'float32'
  dtype_faces:  'uint32'
  threshold:    number
  time:         string
  volume_shape: [number, number, number]  // (depth, lat, lon) — the voxel grid verts are indexed into
}

// ── Metadata endpoint response ────────────────────────────────────────────────
export interface SourceMetadata {
  source_id:            string
  label:                string
  available_variables:  string[]
  cf_metadata: Record<string, {
    standard_name: string
    long_name:     string
    units:         string
    valid_min:     number
    valid_max:     number
    missing_value: number
  }>
  depth_levels: number[]          // non-uniform, from dataset (§8.1)
  time_range: {
    start: string
    end:   string
    steps: number
  }
  dimensions: Record<string, number>
}

// ── Instruments endpoint ──────────────────────────────────────────────────────
export interface InstrumentPosition {
  platform_id:  string
  // Backend has no allow-list on this (see /api/instruments) — new sensor types just need new
  // rows in PostGIS, no code change, so this is deliberately not a closed union. Known values in
  // practice: 'argo' | 'glider' | 'ctd' | 'bgc' | 'mooring' | 'adcp'.
  type:         string
  lat:          number
  lon:          number
  time_start:   string | null
  time_end:     string | null
  cycle_number: number | null
}

export interface InstrumentsResponse {
  instruments: InstrumentPosition[]
  count:       number
}

// ── Profile endpoint ──────────────────────────────────────────────────────────
export interface DepthProfile {
  platform_id: string
  lat:         number
  lon:         number
  time:        string | null
  depth:       number[]
  temperature: number[]
  model_temperature?: number[] | null
  delta_temperature?: number[] | null
  salinity:    number[]
  model_salinity?: number[] | null
  delta_salinity?: number[] | null
  units: {
    depth:       string
    temperature: string
    salinity:    string
  }
}

export interface EddyCell {
  lat: number
  lon: number
  type: 'warm' | 'cold' | 'front'
  w_value: number
}

export interface FrontCell {
  lat: number
  lon: number
  gradient_magnitude: number
}

// ── Parsed binary data ────────────────────────────────────────────────────────
export interface ParsedSlice {
  header: SliceHeader
  data:   Float32Array
}

export interface ParsedVolume {
  header: VolumeHeader
  data:   Float32Array
}

export interface ParsedIsosurface {
  header:  IsosurfaceHeader
  verts:   Float32Array
  normals: Float32Array
  faces:   Uint32Array
}

// ── Cache/last-updated metrics ────────────────────────────────────────────────
export interface LastUpdatedEntry {
  key:         string
  kind:        'slice' | 'volume' | 'isosurface'
  source:      string
  var:         string
  bbox:        string
  cache_hit:   boolean
  duration_ms: number
  updated_at:  number   // unix seconds
}

// ── Registry / source list ────────────────────────────────────────────────────
export interface SourceEntry {
  id:          string
  label:       string
  render_type: 'volume' | 'slice' | 'isosurface' | 'marker' | 'vector'
}

// ── Colourmap config ──────────────────────────────────────────────────────────
export type ColormapName = 'viridis' | 'plasma' | 'magma' | 'inferno' | 'jet'

export interface ColormapConfig {
  name:      ColormapName
  min:       number        // overrides valid_min if set
  max:       number        // overrides valid_max if set
  logScale:  boolean
  opacity:   number        // 0–1
  verticalExaggeration: number  // 1 = no exaggeration
}

// ── Render modes ──────────────────────────────────────────────────────────────
export type RenderMode = 'slice' | 'volume' | 'isosurface'
export type UIMode     = 'console' | 'explorer'

// ── Layer params (dispatched to LayerManager) ─────────────────────────────────
export interface LayerParams {
  sourceId:   string
  variable:   string
  depthIdx:   number     // index into depth_levels[], NOT raw meters
  timeIdx:    number
  bbox:       [number, number, number, number]  // [minLon, minLat, maxLon, maxLat]
  renderMode: RenderMode
  colormap:   ColormapConfig
  threshold?: number     // for isosurface mode
}
