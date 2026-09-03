import * as THREE from 'three'
import type { ColormapName } from '../api/types'

/**
 * Single source of truth for every colour palette in TARANG.
 *
 * Before this module the palette stops were copy-pasted into four GLSL shaders
 * (colormapFrag / volumeFrag_v2 / workspaceVolumeFrag / oceanCubeFrag) and two
 * JS renderers (IndiaMapView 2D raster, Legend) — six places, each with its own
 * hardcoded 5-palette switch. Adding a palette meant editing all six and keeping
 * an integer index in sync.
 *
 * Now: palettes live here as RGB stop lists (0–255, evenly spaced). The shaders
 * take a 256×1 LUT texture built by `buildColormapLUT`; the 2D renderers sample
 * `samplePalette` directly. A new palette is one entry in PALETTES.
 *
 * The cmocean palettes (thermal, haline, deep, dense, balance, curl, ice) are the
 * oceanography-standard set from Thyng et al. 2016 (doi:10.5670/oceanog.2016.66) —
 * perceptually uniform and, for the diverging ones, symmetric about the midpoint.
 * Using them signals domain fluency: `thermal` for temperature, `haline` for
 * salinity, `balance`/`curl` for current & vorticity anomalies, `deep` for depth.
 */

// RGB stops, 0–255, evenly spaced from t=0 to t=1.
export const PALETTES: Record<ColormapName, number[][]> = {
  // ── Perceptually-uniform sequential (matplotlib) ──────────────────────────
  viridis: [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]],
  plasma:  [[13, 8, 135], [126, 3, 168], [204, 71, 120], [248, 149, 65], [240, 249, 33]],
  magma:   [[0, 0, 4], [59, 15, 112], [140, 41, 129], [222, 73, 104], [252, 253, 191]],
  inferno: [[0, 0, 4], [66, 10, 104], [147, 38, 103], [221, 81, 58], [252, 255, 164]],

  // ── cmocean — oceanography-standard (Thyng et al. 2016) ───────────────────
  thermal: [[4, 35, 51], [38, 36, 113], [103, 32, 146], [168, 42, 127], [221, 73, 82], [243, 142, 52], [233, 213, 66]],
  haline:  [[41, 24, 107], [27, 66, 130], [13, 105, 131], [47, 140, 107], [121, 171, 68], [209, 197, 64], [253, 238, 153]],
  deep:    [[253, 253, 204], [142, 207, 160], [74, 157, 168], [70, 101, 156], [62, 54, 110], [40, 20, 53]],
  dense:   [[230, 240, 240], [140, 197, 214], [95, 138, 200], [110, 82, 171], [92, 32, 111], [40, 10, 40]],
  balance: [[17, 32, 64], [44, 89, 158], [126, 167, 215], [240, 240, 240], [224, 153, 124], [178, 52, 45], [80, 12, 20]],
  curl:    [[21, 72, 72], [44, 140, 130], [150, 200, 180], [245, 245, 245], [220, 170, 200], [170, 60, 140], [90, 10, 90]],
  ice:     [[4, 6, 25], [24, 30, 80], [45, 80, 150], [110, 150, 200], [190, 215, 235], [240, 248, 255]],

  // ── Legacy / utility ─────────────────────────────────────────────────────
  jet:       [[0, 0, 127], [0, 255, 255], [127, 255, 127], [255, 255, 0], [127, 0, 0]],
  grayscale: [[0, 0, 0], [255, 255, 255]],
}

// Palettes that are diverging (symmetric about a centre) — the UI can hint that
// min/max should straddle zero for these.
export const DIVERGING: ReadonlySet<ColormapName> = new Set(['balance', 'curl'])

export const COLORMAP_NAMES = Object.keys(PALETTES) as ColormapName[]

/** Linear-interpolate a stop list at t∈[0,1]. Returns RGB 0–255. */
export function samplePalette(stops: number[][], t: number): [number, number, number] {
  t = Math.min(1, Math.max(0, t)) * (stops.length - 1)
  const i = Math.floor(t)
  const f = t - i
  const a = stops[i]
  const b = stops[Math.min(i + 1, stops.length - 1)]
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
}

// ── GPU lookup-table texture ─────────────────────────────────────────────────

const LUT_WIDTH = 256
const _lutCache = new Map<string, THREE.DataTexture>()

/**
 * A 256×1 RGBA texture the fragment shaders sample as `texture(u_cmap, vec2(t, 0.5))`.
 * Cached by name+reversed so a render loop can call this every frame for free.
 */
export function buildColormapLUT(name: ColormapName, reversed = false): THREE.DataTexture {
  const key = `${name}|${reversed ? 'r' : 'f'}`
  const hit = _lutCache.get(key)
  if (hit) return hit

  const stops = PALETTES[name] ?? PALETTES.viridis
  const data = new Uint8Array(LUT_WIDTH * 4)
  for (let i = 0; i < LUT_WIDTH; i++) {
    let t = i / (LUT_WIDTH - 1)
    if (reversed) t = 1 - t
    const [r, g, b] = samplePalette(stops, t)
    data[i * 4 + 0] = r
    data[i * 4 + 1] = g
    data[i * 4 + 2] = b
    data[i * 4 + 3] = 255
  }

  const tex = new THREE.DataTexture(data, LUT_WIDTH, 1, THREE.RGBAFormat, THREE.UnsignedByteType)
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  // Palette stops are already display-referred RGB and the shaders write them
  // straight to the framebuffer — no extra colour-space conversion.
  tex.colorSpace = THREE.NoColorSpace
  tex.needsUpdate = true
  _lutCache.set(key, tex)
  return tex
}

// ── CSS gradient (HTML legend, palette-picker swatches) ───────────────────────

/** `linear-gradient(...)` body for a palette, sampled at `steps` points. */
export function colormapGradientCSS(
  name: ColormapName,
  reversed = false,
  direction = 'to top',
  steps = 12,
): string {
  const stops = PALETTES[name] ?? PALETTES.viridis
  const parts: string[] = []
  for (let i = 0; i < steps; i++) {
    let t = i / (steps - 1)
    if (reversed) t = 1 - t
    const [r, g, b] = samplePalette(stops, t)
    parts.push(`rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)}) ${((i / (steps - 1)) * 100).toFixed(0)}%`)
  }
  return `linear-gradient(${direction}, ${parts.join(', ')})`
}
