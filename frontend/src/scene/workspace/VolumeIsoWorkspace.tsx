import React, { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { useTarangStore } from '../../state/store'
import { Legend } from '../../components/Legend'
import { fetchVolume, fetchIsosurface, fetchInstruments, fetchSlice } from '../../api/client'
import { fetchEddyDetection, fetchFrontDetection } from '../../api/eddy'
import { computeDataRange } from '../layers/dataStats'
import type { RenderMode } from '../../api/types'
import { buildColormapLUT } from '../colormaps'

import volumeVertShader from '../shaders/volumeVert.glsl?raw'
import workspaceVolumeFrag from '../shaders/workspaceVolumeFrag.glsl?raw'

/**
 * VolumeIsoWorkspace — dedicated in-app 3D depth workspace for Volume/Isosurface modes.
 *
 * Opened by ForecasterConsole once a region is searched and renderMode leaves 'slice'. Owns ONE
 * WebGLRenderer / Scene / PerspectiveCamera / OrbitControls, entirely separate from SceneManager's
 * globe — this component never imports or touches the globe, its camera, or its controls.
 *
 * Real data (shared with the globe layers, not re-derived):
 *   - Volume mode      → fetchVolume(), raymarched (MIP) in an axis-aligned box via
 *                        workspaceVolumeFrag.glsl. No sphere-orientation math — the box IS the
 *                        lon/lat/depth cube, so world→texture is a plain affine transform.
 *   - Isosurface mode  → fetchIsosurface()'s marching-cubes mesh, verts (voxel indices in
 *                        depth/lat/lon order) reprojected onto the same box.
 *   - Instrument markers → fetchInstruments({bbox}) (same call InstrumentMarkerLayer makes on the
 *                        globe). Rendered as a pin at the sea surface with a faint water-column
 *                        stem; clicking one opens the same ProfilePopover the globe uses
 *                        (setSelectedPlatform → ForecasterConsole renders it above this panel).
 *
 * Axis convention:
 *   world X → longitude   (left = west edge of bbox, right = east edge)
 *   world Z → latitude    (front = south edge of bbox, back = north edge)
 *   world Y → depth, DOWNWARD — y=0 is the sea surface (top face), y=-depthWorld the deepest
 *             sample. Matches the depth_levels convention (index 0 = shallowest) and keeps Y as
 *             the THREE/OrbitControls up-axis.
 */

interface VolumeIsoWorkspaceProps {
  mode: Extract<RenderMode, 'volume' | 'isosurface'>
  onClose: () => void
}

// Box footprint in world units — fixed regardless of the region's real degree span. Aspect ratio
// between the two horizontal axes still reflects the region's shape.
const BOX_MAX_HORIZONTAL = 12
// Depth-axis height at the DEFAULT vertical exaggeration (store's colormap.verticalExaggeration
// = 50). The slider stretches/squashes this so a researcher can dial depth perception in/out.
const BOX_DEPTH_AT_DEFAULT_VE = 7
const DEFAULT_VE = 50
const FALLBACK_DEPTH_LEVELS = [0, 50, 100, 200, 500, 1000, 1500, 2000]

function depthWorldFor(verticalExaggeration: number): number {
  const ve = verticalExaggeration || DEFAULT_VE
  return Math.min(18, Math.max(2.5, BOX_DEPTH_AT_DEFAULT_VE * (ve / DEFAULT_VE)))
}

// Set true only if a data source ever returns lat rows running north→south (the shader / iso
// reprojection then mirror the lat axis). Fixtures + Copernicus are south→north, so: false.
const LAT_FLIP = false

// Instrument marker colours come from the store (user-customizable via InstrumentLegend) —
// one palette everywhere: globe, 2D map, and this workspace.
function markerColorHex(type: string): number {
  const c = useTarangStore.getState().instrumentColors
  return new THREE.Color(c[type] ?? c.other ?? '#ffffff').getHex()
}

// ── Canvas-texture text sprite (axis titles + tick labels) ─────────────────────────────────
function makeTextSprite(text: string, opts: { size?: number; color?: string } = {}): THREE.Sprite {
  const { size = 42, color = '#a0d8ff' } = opts
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  const font = `600 ${size}px Inter, sans-serif`
  ctx.font = font
  const width = Math.ceil(ctx.measureText(text).width) + 24
  const height = size + 20
  canvas.width = width
  canvas.height = height
  ctx.font = font
  ctx.fillStyle = color
  ctx.textBaseline = 'middle'
  ctx.fillText(text, 12, height / 2)

  const texture = new THREE.CanvasTexture(canvas)
  texture.minFilter = THREE.LinearFilter
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false })
  const sprite = new THREE.Sprite(material)
  const worldHeight = 0.55
  sprite.scale.set((width / height) * worldHeight, worldHeight, 1)
  sprite.renderOrder = 10
  return sprite
}

// world → [0,1]^3 box space, ordered (lon frac, lat frac, depth frac — 0 at the sea surface).
// THE box mapping. Volume mode feeds this matrix straight to workspaceVolumeFrag.glsl;
// Isosurface mode inverts it to place marching-cubes verts; instrument markers go through
// project() below, which just prepends the real-units→fraction step. One mapping, one box —
// keeping these in lockstep is why they're all derived from this single function.
//
// Axis frame (right-handed, so the view is never mirrored vs. the 2D map): world +X = EAST,
// world -Z = NORTH, world +Y = up. The camera sits south of the box looking north, so on
// screen east is right and north is back — same as looking at a map.
function makeWorldToUnit(lonW: number, latW: number, depthWorld: number): THREE.Matrix4 {
  return new THREE.Matrix4().set(
    1 / lonW, 0, 0, 0.5,
    0, 0, -1 / latW, 0.5,   // lat frac 0 (south) sits at +Z; north is -Z
    0, -1 / depthWorld, 0, 0,
    0, 0, 0, 1,
  )
}

// ── Dashed grid in the local XY plane (caller rotates/positions per face) ──────────────────
function makeFaceGrid(width: number, height: number, divisions: number, color: number): THREE.LineSegments {
  const points: number[] = []
  for (let i = 0; i <= divisions; i++) {
    const t = i / divisions
    const x = -width / 2 + t * width
    points.push(x, -height / 2, 0, x, height / 2, 0)
  }
  for (let i = 0; i <= divisions; i++) {
    const t = i / divisions
    const y = -height / 2 + t * height
    points.push(-width / 2, y, 0, width / 2, y, 0)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3))
  const material = new THREE.LineDashedMaterial({ color, dashSize: 0.18, gapSize: 0.14, transparent: true, opacity: 0.45 })
  const lines = new THREE.LineSegments(geometry, material)
  lines.computeLineDistances()
  return lines
}

type Status = 'loading' | 'ready' | 'empty' | 'error'

// Volume frames for every (region/var, time) the workspace has fetched this session. Time-step
// playback reads from here — a cache hit swaps a texture with zero network + zero scene rebuild.
// Keyed by a "tag" (mode|source|var|threshold|bbox) so a new region/variable starts fresh.
interface VolFrame { header: any; data: Float32Array }
const _volCache = new Map<string, VolFrame>()
function _volCachePut(key: string, frame: VolFrame) {
  _volCache.set(key, frame)
  while (_volCache.size > 48) {
    const oldest = _volCache.keys().next().value
    if (oldest === undefined) break
    _volCache.delete(oldest)
  }
}
// mode is always 'volume' here — threshold doesn't affect a volume fetch, so it's out of the key.
const volCacheTag = (source: string, v: string, bbox: number[]) =>
  `volume|${source}|${v}|${bbox.join(',')}`

export function VolumeIsoWorkspace({ mode, onClose }: VolumeIsoWorkspaceProps) {
  const mountRef = useRef<HTMLDivElement>(null)
  const [entered, setEntered] = useState(false)
  const [status, setStatus] = useState<Status>('loading')
  const [errMsg, setErrMsg] = useState<string | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  // Box geometry the surface-overlay effect needs, published by the main scene effect. Kept in
  // a ref so toggling a layer only rebuilds the overlays, never the (expensive) volume.
  const overlayCtxRef = useRef<{
    project: (lon: number, lat: number, depthM: number) => THREE.Vector3
    kmToWorld: number
    overlayGroup: THREE.Group
    markerMeshes: THREE.Mesh[]
    markerIds: Map<THREE.Mesh, string>
    currentSource: string
    alive: { v: boolean }
  } | null>(null)

  // Box geometry + the persistent data mesh, published by the scene effect so the data effect
  // can swap time steps in place without tearing the renderer down.
  const volumeCtxRef = useRef<{
    dataGroup: THREE.Group
    worldToUnit: THREE.Matrix4
    unitToWorld: THREE.Matrix4
    lonW: number; latW: number; depthWorld: number
    setDepthTicks: (m: number) => void
    mesh: THREE.Mesh | null
    alive: { v: boolean }
  } | null>(null)
  const [stepping, setStepping] = useState(false)

  const bbox = useTarangStore(s => s.bbox)
  const regionLabel = useTarangStore(s => s.regionLabel)
  const activeVar = useTarangStore(s => s.activeVar)
  const activeSourceId = useTarangStore(s => s.activeSourceId)
  const activeTimeIdx = useTarangStore(s => s.activeTimeIdx)
  const setActiveTimeIdx = useTarangStore(s => s.setActiveTimeIdx)
  const timeSteps = useTarangStore(s => s.timeSteps)
  const isoThreshold = useTarangStore(s => s.isoThreshold)
  const depthLevels = useTarangStore(s => s.depthLevels)
  const cfMetadata = useTarangStore(s => s.cfMetadata)
  const colormapName = useTarangStore(s => s.colormap.name)
  const colormapReversed = useTarangStore(s => s.colormap.reversed)
  const colormapLog = useTarangStore(s => s.colormap.logScale)
  const verticalExaggeration = useTarangStore(s => s.colormap.verticalExaggeration)
  const setSelectedPlatform = useTarangStore(s => s.setSelectedPlatform)
  const setColormap = useTarangStore(s => s.setColormap)
  const layerVisibility = useTarangStore(s => s.layerVisibility)
  const toggleLayer = useTarangStore(s => s.toggleLayer)

  const units = cfMetadata[activeVar]?.units ?? ''

  // How many time steps are already in the volume cache — drives the "buffering N/M" hint and
  // recomputes each render (frequent enough during playback to tick up visibly).
  const cachedFrames = mode === 'volume' && timeSteps.length > 1
    ? timeSteps.reduce(
        (n, _s, t) => n + (_volCache.has(`${volCacheTag(activeSourceId, activeVar, bbox)}#${t}`) ? 1 : 0),
        0,
      )
    : timeSteps.length

  // Slide/fade the panel in on mount — the region fly-to (SceneManager, on searchRegion) is
  // already done by the time the user picks Volume/Iso, so this is the only transition here.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  // Esc closes the workspace, same as the explicit button.
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Time-step playback. The volume for every step is prefetched + cached (see the data effect),
  // so advancing a step swaps a texture in place — no scene rebuild, no loading screen. If the
  // next frame isn't cached yet the swap just waits for its fetch; playback never stops itself.
  useEffect(() => {
    if (!isPlaying || timeSteps.length < 2) return
    const id = setInterval(() => {
      const st = useTarangStore.getState()
      const next = (st.activeTimeIdx + 1) % timeSteps.length
      // Hold on the current (rendered) frame until the prefetcher has buffered the next one —
      // turns a stuttery first lap into a short pause, then smooth playback once buffered.
      if (mode === 'volume') {
        const key = `${volCacheTag(st.activeSourceId, st.activeVar, st.bbox)}#${next}`
        if (!_volCache.has(key)) return
      }
      st.setActiveTimeIdx(next)
    }, 850)
    return () => clearInterval(id)
  }, [isPlaying, timeSteps.length, mode])

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    setErrMsg(null)

    const [minLon, minLat, maxLon, maxLat] = bbox
    const lonSpan = Math.max(maxLon - minLon, 0.01)
    const latSpan = Math.max(maxLat - minLat, 0.01)
    const aspect = latSpan / lonSpan
    const lonW = aspect >= 1 ? BOX_MAX_HORIZONTAL / aspect : BOX_MAX_HORIZONTAL
    const latW = aspect >= 1 ? BOX_MAX_HORIZONTAL : BOX_MAX_HORIZONTAL * aspect
    const depthWorld = depthWorldFor(verticalExaggeration)
    const levels = depthLevels.length > 0 ? depthLevels : FALLBACK_DEPTH_LEVELS
    const maxDepthM = Math.max(...levels)

    // The box mapping, shared by every data mesh in here (see makeWorldToUnit). worldToUnit
    // goes to the volume shader as-is; unitToWorld places iso verts and markers.
    const worldToUnit = makeWorldToUnit(lonW, latW, depthWorld)
    const unitToWorld = worldToUnit.clone().invert()

    // lon/lat/depth (real units) → this box's local XYZ, via the same affine the volume shader
    // uses. Real units → [0,1] grid fraction → unitToWorld. Mirrors sphereUtils.ts for the globe.
    function project(lon: number, lat: number, depthM: number): THREE.Vector3 {
      return new THREE.Vector3(
        (lon - minLon) / lonSpan,
        (lat - minLat) / latSpan,
        depthM / maxDepthM,
      ).applyMatrix4(unitToWorld)
    }

    // ── Renderer / scene / camera ────────────────────────────────────────────
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x050a14)

    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000)
    // South of the box (+Z), a little east, well above — looking north. East → screen right,
    // north → screen back, matching the 2D map's orientation. Pull back for a tall box so a
    // cranked-up vertical exaggeration still fits the frame.
    const fit = Math.max(lonW, latW, depthWorld)
    camera.position.set(lonW * 0.35, depthWorld * 0.6 + fit * 0.5, latW * 0.4 + fit * 1.1)
    camera.up.set(0, 1, 0)

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    const w0 = mount.clientWidth || 800
    const h0 = mount.clientHeight || 600
    renderer.setSize(w0, h0)
    camera.aspect = w0 / h0
    camera.updateProjectionMatrix()
    mount.appendChild(renderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.set(0, -depthWorld / 2, 0)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.minDistance = Math.max(lonW, latW, depthWorld) * 0.6
    controls.maxDistance = Math.max(lonW, latW, depthWorld) * 4
    controls.update()

    scene.add(new THREE.AmbientLight(0xffffff, 1.4))
    const key = new THREE.DirectionalLight(0xffffff, 1.2)
    key.position.set(lonW, depthWorld * 2, latW)
    scene.add(key)

    // ── Box wireframe (surface-to-seabed) ───────────────────────────────────
    const boxGeo = new THREE.BoxGeometry(lonW, depthWorld, latW)
    boxGeo.translate(0, -depthWorld / 2, 0)   // top face at y=0 (the surface)
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(boxGeo),
      new THREE.LineBasicMaterial({ color: 0x3a6a99, transparent: true, opacity: 0.8 })
    )
    scene.add(edges)
    boxGeo.dispose()

    // ── Dashed reference grids on the 3 inner faces ─────────────────────────
    const GRID_DIV = 10
    const GRID_COLOR = 0x2a5580

    const floorGrid = makeFaceGrid(lonW, latW, GRID_DIV, GRID_COLOR)
    floorGrid.rotation.x = -Math.PI / 2
    floorGrid.position.set(0, -depthWorld, 0)
    scene.add(floorGrid)

    const backWallGrid = makeFaceGrid(lonW, depthWorld, GRID_DIV, GRID_COLOR)
    backWallGrid.position.set(0, -depthWorld / 2, -latW / 2)
    scene.add(backWallGrid)

    const sideWallGrid = makeFaceGrid(latW, depthWorld, GRID_DIV, GRID_COLOR)
    sideWallGrid.rotation.y = Math.PI / 2
    sideWallGrid.position.set(-lonW / 2, -depthWorld / 2, 0)
    scene.add(sideWallGrid)

    // ── Axis labels + a few numeric ticks ──────────────────────────────────
    // Axis labels — placed for the south-looking-north camera: longitude runs along the near
    // (front) bottom edge, latitude along the right bottom edge, north points to the far edge.
    const lonTitle = makeTextSprite('LONGITUDE →', { color: '#5ec8ff' })
    lonTitle.position.set(0, -depthWorld - 0.9, latW / 2 + 0.9)
    scene.add(lonTitle)

    const northTitle = makeTextSprite('NORTH ↑', { color: '#5ec8ff' })
    northTitle.position.set(0, -depthWorld - 0.9, -latW / 2 - 0.9)
    scene.add(northTitle)

    const latTitle = makeTextSprite('LATITUDE', { color: '#5ec8ff' })
    latTitle.position.set(lonW / 2 + 1.4, -depthWorld - 0.9, 0)
    scene.add(latTitle)

    const depthTitle = makeTextSprite('DEPTH (m) ↓', { color: '#5ec8ff' })
    depthTitle.position.set(-lonW / 2 - 1.7, -depthWorld * 0.28, latW / 2 + 0.2)
    scene.add(depthTitle)

    const tickColor = '#7fb3d9'
    for (const frac of [0, 0.5, 1]) {
      const lonVal = minLon + frac * lonSpan
      const t1 = makeTextSprite(`${lonVal.toFixed(1)}°`, { size: 30, color: tickColor })
      t1.position.set((frac - 0.5) * lonW, -depthWorld - 0.35, latW / 2 + 0.4)
      scene.add(t1)

      const latVal = minLat + frac * latSpan
      const t2 = makeTextSprite(`${latVal.toFixed(1)}°`, { size: 30, color: tickColor })
      // south (minLat) is at +Z (near), north (maxLat) at -Z (far)
      t2.position.set(lonW / 2 + 0.5, -depthWorld - 0.35, (0.5 - frac) * latW)
      scene.add(t2)
    }

    // Depth ticks are filled in once the data is loaded — the box always spans surface→seabed
    // of whatever the fetch actually returned (a live 0–100 m window vs. a full 0–5000 m column),
    // so labelling from the global metadata's depth_levels would be wrong.
    const depthTicks = new THREE.Group()
    scene.add(depthTicks)
    function setDepthTicks(realMaxDepthM: number) {
      depthTicks.clear()
      for (const frac of [0, 0.5, 1]) {
        const t = makeTextSprite(`${Math.round(frac * realMaxDepthM)}m`, { size: 30, color: tickColor })
        t.position.set(-lonW / 2 - 0.5, -frac * depthWorld, latW / 2 + 0.2)
        depthTicks.add(t)
      }
    }
    setDepthTicks(maxDepthM)   // provisional — replaced on data load

    // ── Surface overlays (markers / eddies / fronts / vectors) ─────────────
    // These are 2D surface fields — they float in a thin slab above the box's top face and
    // are (re)built by a SEPARATE effect keyed on store.layerVisibility, so toggling one
    // never rebuilds the volume. This effect just publishes the box geometry it needs.
    const CURRENT_SOURCE = 'incois_ocean'   // has uo/vo — matches VectorLayer/EddyOverlayLayer
    const kmToWorld = (1 / 111) / lonSpan * lonW
    const overlayGroup = new THREE.Group()
    scene.add(overlayGroup)
    const markerMeshes: THREE.Mesh[] = []
    const markerIds = new Map<THREE.Mesh, string>()
    const alive = { v: true }
    overlayCtxRef.current = {
      project, kmToWorld, overlayGroup, markerMeshes, markerIds,
      currentSource: CURRENT_SOURCE, alive,
    }
    // ── Mode-specific real data mesh ───────────────────────────────────────
    // The data mesh is (re)built and time-step-swapped by the SEPARATE data effect below — this
    // effect only hands it the box geometry (via volumeCtxRef) so a step change never tears the
    // renderer / scene / camera down.
    const dataGroup = new THREE.Group()
    scene.add(dataGroup)
    volumeCtxRef.current = {
      dataGroup, worldToUnit, unitToWorld, lonW, latW, depthWorld,
      setDepthTicks, mesh: null, alive,
    }

    // ── Click-to-inspect: same pipeline the globe uses ─────────────────────
    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    let downPos: { x: number; y: number } | null = null

    function onPointerDown(e: PointerEvent) { downPos = { x: e.clientX, y: e.clientY } }
    function onPointerUp(e: PointerEvent) {
      if (!downPos || Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 4) { downPos = null; return }
      downPos = null
      const rect = renderer.domElement.getBoundingClientRect()
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(pointer, camera)
      const hits = raycaster.intersectObjects(markerMeshes)
      if (hits.length > 0) {
        const id = markerIds.get(hits[0].object as THREE.Mesh)
        if (id) setSelectedPlatform(id)
      }
    }
    renderer.domElement.addEventListener('pointerdown', onPointerDown)
    renderer.domElement.addEventListener('pointerup', onPointerUp)

    // ── Resize + render loop ──────────────────────────────────────────────────
    const ro = new ResizeObserver(() => {
      const w = mount.clientWidth, h = mount.clientHeight
      if (w === 0 || h === 0) return
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    })
    ro.observe(mount)

    let rafId = 0
    function animate() {
      rafId = requestAnimationFrame(animate)
      controls.update()
      renderer.render(scene, camera)
    }
    animate()

    return () => {
      alive.v = false
      overlayCtxRef.current = null
      volumeCtxRef.current = null
      cancelAnimationFrame(rafId)
      ro.disconnect()
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.domElement.removeEventListener('pointerup', onPointerUp)
      controls.dispose()
      scene.traverse(obj => {
        const mesh = obj as THREE.Mesh
        if (mesh.geometry) mesh.geometry.dispose()
        const mat = (mesh as any).material
        if (Array.isArray(mat)) mat.forEach((m: THREE.Material) => m.dispose())
        else if (mat) {
          const uniforms = (mat as any).uniforms
          if (uniforms?.u_data?.value?.dispose) uniforms.u_data.value.dispose()
          mat.dispose()
        }
      })
      renderer.dispose()
      if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement)
    }
    // NOTE: deliberately does NOT depend on activeTimeIdx / colormap — only things that change
    // the box geometry or camera. Data + time steps live in the effect below.
  }, [mode, bbox, depthLevels, verticalExaggeration, setSelectedPlatform])

  // ── Data mesh + time-step swaps ───────────────────────────────────────────
  // Keyed on the data params (NOT the scene). A time step is a Data3DTexture swap inside the
  // existing mesh — cache hit ⇒ instant, no scene rebuild, no loading screen — which is what
  // makes ▶ playback smooth. Colormap changes just poke uniforms. Isosurface rebuilds its mesh
  // each change (threshold-driven, no time cache).
  useEffect(() => {
    const ctx = volumeCtxRef.current
    if (!ctx) return
    const { dataGroup, worldToUnit, unitToWorld, lonW, latW, depthWorld, setDepthTicks } = ctx
    let cancelled = false
    const abort = new AbortController()

    const disposeMesh = () => {
      if (!ctx.mesh) return
      dataGroup.remove(ctx.mesh)
      ctx.mesh.geometry.dispose()
      const mat = ctx.mesh.material as THREE.Material & { uniforms?: any }
      if (mat.uniforms?.u_data?.value?.dispose) mat.uniforms.u_data.value.dispose()
      mat.dispose()
      ctx.mesh = null
    }

    const applyVolFrame = (frame: VolFrame) => {
      if (cancelled || !ctx.alive.v) return
      const [depthSize, latSize, lonSize] = frame.header.shape
      const [dataMin, dataMax] = computeDataRange(
        frame.data, frame.header.missing_value, frame.header.valid_min, frame.header.valid_max,
      )
      setColormap({ min: dataMin, max: dataMax })

      const tex = new THREE.Data3DTexture(frame.data, lonSize, latSize, depthSize)
      tex.format = THREE.RedFormat
      tex.type = THREE.FloatType
      tex.minFilter = THREE.NearestFilter
      tex.magFilter = THREE.NearestFilter
      tex.unpackAlignment = 1
      tex.needsUpdate = true

      const existing = ctx.mesh?.material as (THREE.ShaderMaterial & { uniforms?: any }) | undefined
      if (existing?.uniforms?.u_data) {
        const u = existing.uniforms
        const old = u.u_data.value as THREE.Data3DTexture
        u.u_data.value = tex
        old?.dispose?.()
        ;(u.u_clim.value as THREE.Vector2).set(dataMin, dataMax)
        u.u_missing.value = frame.header.missing_value ?? -9999.0
        u.u_cmap.value = buildColormapLUT(colormapName, colormapReversed)
        u.u_log_scale.value = colormapLog ? 1 : 0
      } else {
        disposeMesh()
        const material = new THREE.ShaderMaterial({
          vertexShader: volumeVertShader,
          fragmentShader: workspaceVolumeFrag,
          uniforms: {
            u_data: { value: tex },
            u_worldToUnit: { value: worldToUnit },
            u_clim: { value: new THREE.Vector2(dataMin, dataMax) },
            u_opacity: { value: 0.9 },
            u_missing: { value: frame.header.missing_value ?? -9999.0 },
            u_cmap: { value: buildColormapLUT(colormapName, colormapReversed) },
            u_log_scale: { value: colormapLog ? 1 : 0 },
            u_lat_flip: { value: LAT_FLIP ? 1 : 0 },
          },
          transparent: true,
          side: THREE.DoubleSide,
          depthWrite: false,
          glslVersion: THREE.GLSL3,
        })
        const geometry = new THREE.BoxGeometry(lonW, depthWorld, latW)
        geometry.translate(0, -depthWorld / 2, 0)
        const mesh = new THREE.Mesh(geometry, material)
        mesh.frustumCulled = false
        mesh.renderOrder = 3
        dataGroup.add(mesh)
        ctx.mesh = mesh
      }
      if (frame.header.depth_levels?.length) setDepthTicks(Math.max(...frame.header.depth_levels))
      setStatus('ready')
      setStepping(false)
    }

    if (mode === 'volume') {
      const key = `${volCacheTag(activeSourceId, activeVar, bbox)}#${activeTimeIdx}`
      const cached = _volCache.get(key)
      if (cached) {
        applyVolFrame(cached)
      } else {
        if (ctx.mesh) setStepping(true); else setStatus('loading')
        setErrMsg(null)
        fetchVolume({ source: activeSourceId, var: activeVar, time: activeTimeIdx, bbox }, abort.signal)
          .then(({ header, data }) => {
            if (cancelled || !ctx.alive.v) return
            const frame: VolFrame = { header, data: data as Float32Array }
            _volCachePut(key, frame)
            applyVolFrame(frame)
          })
          .catch((err: any) => {
            if (cancelled || err?.name === 'AbortError') return
            console.error(err)
            setErrMsg(err?.message ?? String(err))
            setStatus('error')
            setStepping(false)
          })
      }
    } else {
      if (ctx.mesh) setStepping(true); else setStatus('loading')
      setErrMsg(null)
      fetchIsosurface(
        { source: activeSourceId, var: activeVar, threshold: isoThreshold, time: activeTimeIdx, bbox },
        abort.signal,
      )
        .then(({ header, verts, faces }) => {
          if (cancelled || !ctx.alive.v) return
          disposeMesh()
          if (header.n_verts === 0 || verts.length === 0) { setStatus('empty'); setStepping(false); return }
          const [depthSize, latSize, lonSize] = header.volume_shape
          const positions = new Float32Array(verts.length)
          const vv = new THREE.Vector3()
          for (let i = 0; i < verts.length; i += 3) {
            const lonFrac = lonSize > 1 ? verts[i + 2] / (lonSize - 1) : 0.5
            let latFrac = latSize > 1 ? verts[i + 1] / (latSize - 1) : 0.5
            if (LAT_FLIP) latFrac = 1 - latFrac
            const depthFrac = depthSize > 1 ? verts[i] / (depthSize - 1) : 0
            vv.set(lonFrac, latFrac, depthFrac).applyMatrix4(unitToWorld)
            positions[i] = vv.x; positions[i + 1] = vv.y; positions[i + 2] = vv.z
          }
          const geometry = new THREE.BufferGeometry()
          geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
          geometry.setIndex(new THREE.BufferAttribute(faces, 1))
          geometry.computeVertexNormals()
          const material = new THREE.MeshPhongMaterial({
            color: 0x00d4ff, side: THREE.DoubleSide, transparent: true, opacity: 0.85, shininess: 60,
          })
          const mesh = new THREE.Mesh(geometry, material)
          mesh.frustumCulled = false
          dataGroup.add(mesh)
          ctx.mesh = mesh
          if (header.depth_levels?.length) setDepthTicks(Math.max(...header.depth_levels))
          setStatus('ready')
          setStepping(false)
        })
        .catch((err: any) => {
          if (cancelled || err?.name === 'AbortError') return
          console.error(err)
          setErrMsg(err?.message ?? String(err))
          setStatus('error')
          setStepping(false)
        })
    }

    return () => { cancelled = true; abort.abort() }
    // depthLevels / verticalExaggeration are here because the scene effect rebuilds the box (and
    // resets volumeCtxRef) when they change — the data mesh must then be rebuilt into the new box.
  }, [
    mode, bbox, activeSourceId, activeVar, activeTimeIdx, isoThreshold,
    colormapName, colormapReversed, colormapLog, depthLevels, verticalExaggeration, setColormap,
  ])

  // ── Background prefetch of every time step (volume mode) ───────────────────
  // Keyed on the region/variable only (NOT time), so it survives a play-through: each frame it
  // fetches lands in _volCache and the data effect's next step swap is a cache hit.
  useEffect(() => {
    if (mode !== 'volume' || timeSteps.length < 2) return
    const ctx = volumeCtxRef.current
    if (!ctx) return
    const tag = volCacheTag(activeSourceId, activeVar, bbox)
    const abort = new AbortController()
    let cancelled = false
    ;(async () => {
      for (let t = 0; t < timeSteps.length; t++) {
        if (cancelled || !ctx.alive.v) return
        const k = `${tag}#${t}`
        if (_volCache.has(k)) continue
        try {
          const { header, data } = await fetchVolume(
            { source: activeSourceId, var: activeVar, time: t, bbox }, abort.signal,
          )
          if (cancelled || !ctx.alive.v) return
          _volCachePut(k, { header, data: data as Float32Array })
        } catch { /* transient — the on-demand fetch in the data effect will retry this step */ }
      }
    })()
    return () => { cancelled = true; abort.abort() }
  }, [mode, activeSourceId, activeVar, bbox, timeSteps.length])

  // ── Surface overlays (markers / eddies / fronts / vectors) ─────────────────
  // Separate from the scene effect so toggling a layer never rebuilds the volume. Rebuilds the
  // overlay group in place whenever the box is (re)built or a relevant store field changes.
  useEffect(() => {
    const ctx = overlayCtxRef.current
    if (!ctx) return
    const { project, kmToWorld, overlayGroup, markerMeshes, markerIds } = ctx

    // Clear the previous overlays.
    for (const child of [...overlayGroup.children]) {
      overlayGroup.remove(child)
      const m = child as THREE.Mesh
      m.geometry?.dispose?.()
      const mat = (m as any).material
      if (Array.isArray(mat)) mat.forEach((x: THREE.Material) => x.dispose())
      else mat?.dispose?.()
    }
    markerMeshes.length = 0
    markerIds.clear()

    const abort = new AbortController()
    const lv = layerVisibility
    const HOVER = 0.28
    const overlayMat = (color: number, extra: THREE.MeshBasicMaterialParameters = {}) =>
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false, ...extra })

    if (lv.markers) {
      fetchInstruments({ bbox }, abort.signal)
        .then(({ instruments }) => {
          if (!ctx.alive.v || abort.signal.aborted) return
          for (const inst of instruments) {
            const color = markerColorHex(inst.type)
            const marker = new THREE.Mesh(
              new THREE.SphereGeometry(0.17, 16, 16),
              new THREE.MeshPhongMaterial({ color, emissive: color, emissiveIntensity: 0.35 }),
            )
            marker.position.copy(project(inst.lon, inst.lat, 0))
            overlayGroup.add(marker)
            markerMeshes.push(marker)
            markerIds.set(marker, inst.platform_id)
          }
        })
        .catch(err => { if (err?.name !== 'AbortError') console.error(err) })
    }

    if (lv.eddy) {
      fetchEddyDetection({ source: ctx.currentSource, time: activeTimeIdx, bbox }, abort.signal)
        .then(cells => {
          if (!ctx.alive.v || abort.signal.aborted) return
          for (const c of cells) {
            const r = Math.max(0.4, (c.radius_km ?? 60) * kmToWorld * 1.4)
            const col = c.type === 'warm' ? 0xff8c00 : 0x00e5ff
            const ring = new THREE.Mesh(
              new THREE.TorusGeometry(r, Math.max(0.07, r * 0.12), 12, 44),
              overlayMat(col, { side: THREE.DoubleSide }),
            )
            ring.rotation.x = -Math.PI / 2
            ring.position.copy(project(c.lon, c.lat, 0)).setY(HOVER + 0.15)
            ring.renderOrder = 5
            overlayGroup.add(ring)
          }
        })
        .catch(err => { if (err?.name !== 'AbortError') console.error(err) })
    }

    if (lv.fronts && activeVar) {
      fetchFrontDetection(
        { source: activeSourceId, var: activeVar, time: activeTimeIdx, bbox }, abort.signal,
      )
        .then(cells => {
          if (!ctx.alive.v || abort.signal.aborted || cells.length === 0) return
          const stride = Math.max(1, Math.ceil(cells.length / 500))
          const shown = cells.filter((_, i) => i % stride === 0)
          const pos = new Float32Array(shown.length * 3)
          shown.forEach((c, i) => {
            const p = project(c.lon, c.lat, 0)
            pos[i * 3] = p.x; pos[i * 3 + 1] = HOVER; pos[i * 3 + 2] = p.z
          })
          const geo = new THREE.BufferGeometry()
          geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
          const pts = new THREE.Points(geo, new THREE.PointsMaterial({
            color: 0xff3df5, size: 0.24, transparent: true, opacity: 0.95, depthTest: false,
          }))
          pts.renderOrder = 5
          overlayGroup.add(pts)
        })
        .catch(err => { if (err?.name !== 'AbortError') console.error(err) })
    }

    if (lv.vectors) {
      // Depth-resolved current vectors: uo/vo sampled at 3 levels through the water
      // column (Copernicus Marine, 40 levels), one clean arrow sheet per level — the
      // PS's "current vectors across the full water column". Arrows are drawn over the
      // volume (depthTest off) and speed-shaded cyan→white so they stay readable.
      const VECTOR_SOURCE_3D = 'copernicus_marine'
      // Pick levels by DEPTH IN METRES, not by index — Copernicus levels are so dense near
      // the surface that index fractions barely move you down the box. Snap each target to
      // the nearest actual level so the sheets are visibly spread through the column.
      const maxD = depthLevels.length ? depthLevels[depthLevels.length - 1] : 500
      const targets = [5, 0.15 * maxD, 0.45 * maxD, 0.8 * maxD]
      const nearest = (t: number) => depthLevels.reduce((b, d) => (Math.abs(d - t) < Math.abs(b - t) ? d : b), depthLevels[0] ?? 0)
      const levels = depthLevels.length ? Array.from(new Set(targets.map(nearest))) : [0]
      const up = new THREE.Vector3(0, 1, 0)
      const arrowGeo = new THREE.ConeGeometry(0.07, 0.36, 6)
      for (const depthM of levels) {
        Promise.all([
          fetchSlice({ source: VECTOR_SOURCE_3D, var: 'uo', depth: depthM, time: activeTimeIdx, bbox }, abort.signal),
          fetchSlice({ source: VECTOR_SOURCE_3D, var: 'vo', depth: depthM, time: activeTimeIdx, bbox }, abort.signal),
        ])
          .then(([uR, vR]) => {
            if (!ctx.alive.v || abort.signal.aborted) return
            const [latN, lonN] = uR.header.shape
            const u = uR.data, v = vR.data
            const { lon: [loA, loB], lat: [laA, laB] } = uR.header.bounds
            const stepJ = Math.max(1, Math.ceil(lonN / 11))
            const stepI = Math.max(1, Math.ceil(latN / 11))
            // Faint translucent sheet so each level reads as a distinct plane.
            const p00 = project(loA, laA, depthM), p11 = project(loB, laB, depthM)
            const sheet = new THREE.Mesh(
              new THREE.PlaneGeometry(Math.abs(p11.x - p00.x), Math.abs(p11.z - p00.z)),
              new THREE.MeshBasicMaterial({ color: 0x0a3550, transparent: true, opacity: 0.10, side: THREE.DoubleSide, depthWrite: false }),
            )
            sheet.rotation.x = -Math.PI / 2
            sheet.position.set((p00.x + p11.x) / 2, project(0, 0, depthM).y, (p00.z + p11.z) / 2)
            sheet.renderOrder = 4
            overlayGroup.add(sheet)

            // 3 shared materials (slow / medium / fast) — cheap, and disposed with the group.
            const mats = [0.55, 0.72, 0.92].map(l => new THREE.MeshBasicMaterial({
              color: new THREE.Color().setHSL(0.52, 0.85, l), transparent: true, opacity: 0.95, depthTest: false,
            }))
            for (let i = 0; i < latN; i += stepI) {
              for (let j = 0; j < lonN; j += stepJ) {
                const uu = u[i * lonN + j], vv = v[i * lonN + j]
                const spd = Math.hypot(uu, vv)
                if (!isFinite(spd) || spd < 1e-3 || spd > 50) continue
                const lon = loA + (loB - loA) * (j / (lonN - 1))
                const lat = laA + (laB - laA) * (i / (latN - 1))
                const k = Math.min(1, spd / 0.6)
                const a = new THREE.Mesh(arrowGeo, mats[k > 0.66 ? 2 : k > 0.33 ? 1 : 0])
                a.position.copy(project(lon, lat, depthM))
                a.quaternion.setFromUnitVectors(up, new THREE.Vector3(uu, 0, -vv).normalize())
                a.scale.setY(0.9 + k * 1.3)
                a.renderOrder = 6
                overlayGroup.add(a)
              }
            }
          })
          .catch(err => { if (err?.name !== 'AbortError') console.error(err) })
      }
    }

    return () => { abort.abort() }
    // Same "heavy" deps as the scene effect (which runs first and refreshes overlayCtxRef) PLUS
    // layerVisibility — so a layer toggle rebuilds only the overlays, a data change rebuilds both.
  }, [mode, bbox, activeSourceId, activeVar, activeTimeIdx, isoThreshold, verticalExaggeration, depthLevels, layerVisibility])

  return (
    <div style={{ ...styles.overlay, opacity: entered ? 1 : 0 }}>
      <div style={{ ...styles.panel, transform: entered ? 'translateY(0) scale(1)' : 'translateY(24px) scale(0.98)' }}>
        <div style={styles.header}>
          <div>
            <div style={styles.title}>
              {mode === 'volume' ? '🧊 Volume Workspace' : '🔵 Isosurface Workspace'}
            </div>
            <div style={styles.subtitle}>
              {regionLabel ?? 'Selected region'} · {activeVar || '—'}
              {mode === 'isosurface' && activeVar ? ` = ${isoThreshold}${units ? ' ' + units : ''}` : ''}
            </div>
          </div>
          <button style={styles.closeBtn} onClick={onClose} title="Back to globe (Esc)">
            ← Back to Globe
          </button>
        </div>

        <div style={styles.body}>
          <div ref={mountRef} style={styles.canvasHost} />

          <div style={styles.layersHost}>
            <div style={styles.layersTitle}>Layers in view</div>
            {([
              ['markers', 'Instruments'],
              ['eddy', 'Eddies'],
              ['fronts', 'Thermal Fronts'],
              ['vectors', 'Current Vectors'],
            ] as const).map(([id, label]) => (
              <label key={id} style={styles.layerRow}>
                <input
                  type="checkbox"
                  checked={!!layerVisibility[id]}
                  onChange={() => toggleLayer(id)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>

          {(status === 'ready' || stepping) && timeSteps.length > 1 && (
            <div style={styles.timeHost}>
              <div style={styles.layersTitle}>Time step</div>
              <div style={styles.timeValue}>{timeSteps[activeTimeIdx] ?? `T+${activeTimeIdx}`}</div>
              <div style={styles.timeMeta}>
                {activeTimeIdx + 1} / {timeSteps.length}
                {stepping
                  ? ' · loading…'
                  : cachedFrames < timeSteps.length
                    ? ` · buffering ${cachedFrames}/${timeSteps.length}`
                    : ' · buffered'}
              </div>
              <div style={styles.timeControls}>
                <button
                  style={styles.timeBtn}
                  onClick={() => setIsPlaying(p => !p)}
                  title={isPlaying ? 'Pause' : 'Play through time'}
                >
                  {isPlaying ? '⏸' : '▶'}
                </button>
                <input
                  type="range"
                  min={0}
                  max={timeSteps.length - 1}
                  step={1}
                  value={activeTimeIdx}
                  onChange={e => setActiveTimeIdx(Number(e.target.value))}
                  style={styles.timeSlider}
                />
              </div>
              <div style={styles.timeEnds}>
                <span>{timeSteps[0]}</span>
                <span>{timeSteps[timeSteps.length - 1]}</span>
              </div>
            </div>
          )}

          {status === 'loading' && (
            <div style={styles.overlayMsg}>
              <div style={styles.spinner} />
              <div>Loading {mode === 'volume' ? 'volume' : 'isosurface'} data…</div>
            </div>
          )}
          {status === 'empty' && (
            <div style={styles.overlayMsg}>
              No {activeVar} = {isoThreshold}{units ? ' ' + units : ''} surface in this region.
              <div style={styles.msgHint}>Adjust the isosurface threshold and try again.</div>
            </div>
          )}
          {status === 'error' && (
            <div style={styles.overlayMsg}>
              Could not load data for this region.
              {errMsg && <div style={styles.msgHint}>{errMsg}</div>}
            </div>
          )}

          {mode === 'volume' && status === 'ready' && (
            <div style={styles.legendHost}>
              <Legend />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(2, 6, 14, 0.72)',
    backdropFilter: 'blur(6px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1500,
    transition: 'opacity 280ms ease',
  },
  panel: {
    position: 'relative',
    width: '92vw',
    height: '90vh',
    background: 'rgba(6, 14, 28, 0.96)',
    border: '1px solid rgba(0, 180, 255, 0.25)',
    borderRadius: '16px',
    boxShadow: '0 24px 80px rgba(0, 0, 0, 0.6)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    transition: 'transform 320ms cubic-bezier(0.2, 0.8, 0.2, 1)',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '16px 22px',
    borderBottom: '1px solid rgba(0, 180, 255, 0.15)',
    fontFamily: "'Inter', sans-serif",
  },
  title: { fontSize: '16px', fontWeight: 700, color: '#e0f0ff', letterSpacing: '0.02em' },
  subtitle: { fontSize: '12px', color: 'rgba(160, 196, 232, 0.7)', marginTop: '2px' },
  closeBtn: {
    padding: '8px 16px',
    background: 'rgba(0, 180, 255, 0.12)',
    border: '1px solid rgba(0, 180, 255, 0.3)',
    borderRadius: '8px',
    color: '#00d4ff',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: 500,
  },
  body: { flex: 1, position: 'relative', minHeight: 0 },
  canvasHost: { position: 'absolute', inset: 0 },
  legendHost: { position: 'absolute', left: 0, bottom: 0 },
  layersHost: {
    position: 'absolute',
    left: '20px',
    top: '20px',
    zIndex: 20,
    pointerEvents: 'auto',
    padding: '12px 14px',
    background: 'rgba(8, 15, 30, 0.82)',
    backdropFilter: 'blur(12px)',
    border: '1px solid rgba(0, 180, 255, 0.3)',
    borderRadius: '12px',
    display: 'flex',
    flexDirection: 'column',
    gap: '7px',
    boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
    fontFamily: "'Inter', sans-serif",
  },
  layersTitle: {
    fontSize: '11px',
    fontWeight: 600,
    color: '#00d4ff',
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
    marginBottom: '2px',
  },
  layerRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    fontSize: '12px',
    color: 'rgba(255,255,255,0.85)',
    cursor: 'pointer',
  },
  timeHost: {
    position: 'absolute',
    right: '20px',
    top: '20px',
    zIndex: 20,
    pointerEvents: 'auto',
    width: '210px',
    padding: '12px 14px',
    background: 'rgba(8, 15, 30, 0.82)',
    backdropFilter: 'blur(12px)',
    border: '1px solid rgba(0, 180, 255, 0.3)',
    borderRadius: '12px',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
    fontFamily: "'Inter', sans-serif",
  },
  timeValue: { fontSize: '15px', fontWeight: 700, color: '#e0f0ff' },
  timeMeta: { fontSize: '11px', color: 'rgba(160, 196, 232, 0.7)' },
  timeControls: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' },
  timeBtn: {
    padding: '2px 9px',
    background: 'rgba(0, 180, 255, 0.14)',
    border: '1px solid rgba(0, 180, 255, 0.35)',
    borderRadius: '6px',
    color: '#00d4ff',
    cursor: 'pointer',
    fontSize: '13px',
  },
  timeSlider: { flex: 1, accentColor: '#00d4ff' },
  timeEnds: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: '10px',
    color: 'rgba(160, 196, 232, 0.6)',
  },
  overlayMsg: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '10px',
    padding: '20px 28px',
    background: 'rgba(4, 10, 22, 0.82)',
    border: '1px solid rgba(0, 180, 255, 0.25)',
    borderRadius: '12px',
    color: '#cfe6ff',
    fontSize: '13px',
    fontFamily: "'Inter', sans-serif",
    textAlign: 'center',
  },
  msgHint: { fontSize: '11px', color: 'rgba(160, 196, 232, 0.6)', marginTop: '4px' },
  spinner: {
    width: '24px',
    height: '24px',
    border: '3px solid rgba(0, 180, 255, 0.25)',
    borderTopColor: '#00d4ff',
    borderRadius: '50%',
    animation: 'tarang-spin 0.9s linear infinite',
  },
}
