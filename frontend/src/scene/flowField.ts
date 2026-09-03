/**
 * flowField — animated particle advection over a current (u/v) field.
 *
 * Map-agnostic: you give it a velocity grid, a canvas, and a project(lat,lon)→pixel
 * function; it runs a requestAnimationFrame loop that seeds particles, advects them
 * by the bilinearly-sampled velocity, and draws fading trails. This is the classic
 * "wind map" / streamline look applied to ocean currents — the thing a plain arrow
 * glyph layer can't show: where the water is actually going, and how fast.
 */

export interface FlowGrid {
  u: Float32Array
  v: Float32Array
  nlat: number
  nlon: number
  lonA: number
  lonB: number
  latA: number   // south edge (grid row 0)
  latB: number   // north edge
}

export interface FlowFieldHandle {
  stop(): void
  /** call after the map canvas size changes */
  resize(): void
}

interface Particle { lat: number; lon: number; age: number; life: number; px: number; py: number }

const MISSING = (v: number) => !Number.isFinite(v) || Math.abs(v) > 50

function sample(grid: FlowGrid, lat: number, lon: number): [number, number] | null {
  const { nlat, nlon, lonA, lonB, latA, latB } = grid
  if (lon < lonA || lon > lonB || lat < latA || lat > latB) return null
  const fx = ((lon - lonA) / (lonB - lonA)) * (nlon - 1)
  const fy = ((lat - latA) / (latB - latA)) * (nlat - 1)
  const x0 = Math.floor(fx), y0 = Math.floor(fy)
  const x1 = Math.min(x0 + 1, nlon - 1), y1 = Math.min(y0 + 1, nlat - 1)
  const tx = fx - x0, ty = fy - y0
  const idx = (yy: number, xx: number) => yy * nlon + xx
  const u00 = grid.u[idx(y0, x0)], u10 = grid.u[idx(y0, x1)], u01 = grid.u[idx(y1, x0)], u11 = grid.u[idx(y1, x1)]
  const v00 = grid.v[idx(y0, x0)], v10 = grid.v[idx(y0, x1)], v01 = grid.v[idx(y1, x0)], v11 = grid.v[idx(y1, x1)]
  if (MISSING(u00) || MISSING(u10) || MISSING(u01) || MISSING(u11)) return null
  const u = (u00 * (1 - tx) + u10 * tx) * (1 - ty) + (u01 * (1 - tx) + u11 * tx) * ty
  const v = (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty
  return [u, v]
}

export function startFlowField(opts: {
  canvas: HTMLCanvasElement
  grid: FlowGrid
  project: (lat: number, lon: number) => { x: number; y: number } | null
  particleCount?: number
  color?: string
  paused?: () => boolean
}): FlowFieldHandle {
  const { canvas, grid, project } = opts
  const N = opts.particleCount ?? 2400
  const color = opts.color ?? 'rgba(150, 235, 255, 0.85)'
  const ctx = canvas.getContext('2d')!

  let dpr = 1
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2)
    const r = canvas.getBoundingClientRect()
    canvas.width = Math.max(1, Math.round(r.width * dpr))
    canvas.height = Math.max(1, Math.round(r.height * dpr))
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, r.width, r.height)
  }
  resize()

  const randLat = () => grid.latA + Math.random() * (grid.latB - grid.latA)
  const randLon = () => grid.lonA + Math.random() * (grid.lonB - grid.lonA)
  const spawn = (p: Particle) => {
    p.lat = randLat(); p.lon = randLon()
    p.age = 0; p.life = 60 + Math.random() * 90
    const pt = project(p.lat, p.lon)
    p.px = pt ? pt.x : -1; p.py = pt ? pt.y : -1
  }
  const particles: Particle[] = Array.from({ length: N }, () => {
    const p: Particle = { lat: 0, lon: 0, age: 0, life: 0, px: -1, py: -1 }
    spawn(p); p.age = Math.random() * p.life
    return p
  })

  // degrees moved per (m/s) per frame — tuned so a ~0.5 m/s surface current reads as a
  // brisk-but-followable drift at 60 fps.
  const STEP = 0.055

  let raf = 0
  let running = true
  function frame() {
    if (!running) return
    raf = requestAnimationFrame(frame)
    if (opts.paused?.()) return

    const r = canvas.getBoundingClientRect()
    // Fade previous trails toward TRANSPARENT (not toward a dark colour) so the
    // basemap / data raster underneath stays visible — this canvas sits over a map.
    ctx.globalCompositeOperation = 'destination-out'
    ctx.fillStyle = 'rgba(0, 0, 0, 0.12)'
    ctx.fillRect(0, 0, r.width, r.height)
    ctx.globalCompositeOperation = 'source-over'

    ctx.lineWidth = 1.1
    ctx.strokeStyle = color
    ctx.lineCap = 'round'
    ctx.beginPath()
    for (const p of particles) {
      const vel = sample(grid, p.lat, p.lon)
      if (!vel || p.age > p.life) { spawn(p); continue }
      const [u, v] = vel
      const speed = Math.hypot(u, v)
      p.lat += v * STEP
      p.lon += u * STEP
      p.age++
      const pt = project(p.lat, p.lon)
      if (!pt) { spawn(p); continue }
      const prevX = p.px, prevY = p.py
      p.px = pt.x; p.py = pt.y
      if (prevX >= 0 && speed > 1e-3) {
        ctx.moveTo(prevX, prevY)
        ctx.lineTo(p.px, p.py)
      }
    }
    ctx.stroke()
  }
  raf = requestAnimationFrame(frame)

  return {
    stop() { running = false; cancelAnimationFrame(raf) },
    resize,
  }
}
