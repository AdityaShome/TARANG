import React, { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { useTarangStore } from '../../state/store'
import { Legend } from '../../components/Legend'
import { fetchVolume, fetchIsosurface, fetchInstruments } from '../../api/client'
import { computeDataRange } from '../layers/dataStats'
import type { RenderMode, ColormapName } from '../../api/types'

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
 *   world Y → depth, DOWNWARD — y=0 is the sea surface (top face), y=-BOX_DEPTH the deepest
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
const BOX_DEPTH = 7
const FALLBACK_DEPTH_LEVELS = [0, 50, 100, 200, 500, 1000, 1500, 2000]

// Set true only if a data source ever returns lat rows running north→south (the shader / iso
// reprojection then mirror the lat axis). Fixtures + Copernicus are south→north, so: false.
const LAT_FLIP = false

// Must match workspaceVolumeFrag.glsl's u_colormap branches (same order as the globe shaders).
const COLORMAP_INDEX: Record<ColormapName, number> = {
  viridis: 0, plasma: 1, magma: 2, inferno: 3, jet: 4,
}

// Same palette as InstrumentMarkerLayer.ts's TYPE_COLORS — one instrument overlay, one set of
// colors, on the globe and in here.
const TYPE_COLORS: Record<string, number> = {
  argo: 0xffcc00, glider: 0x00e5ff, ctd: 0xff6b6b, bgc: 0x7cfc7c,
  mooring: 0xff8c00, adcp: 0xb388ff, default: 0xffffff,
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
function makeWorldToUnit(lonW: number, latW: number, depthWorld: number): THREE.Matrix4 {
  return new THREE.Matrix4().set(
    1 / lonW, 0, 0, 0.5,
    0, 0, 1 / latW, 0.5,
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

export function VolumeIsoWorkspace({ mode, onClose }: VolumeIsoWorkspaceProps) {
  const mountRef = useRef<HTMLDivElement>(null)
  const [entered, setEntered] = useState(false)
  const [status, setStatus] = useState<Status>('loading')
  const [errMsg, setErrMsg] = useState<string | null>(null)

  const bbox = useTarangStore(s => s.bbox)
  const regionLabel = useTarangStore(s => s.regionLabel)
  const activeVar = useTarangStore(s => s.activeVar)
  const activeSourceId = useTarangStore(s => s.activeSourceId)
  const activeTimeIdx = useTarangStore(s => s.activeTimeIdx)
  const isoThreshold = useTarangStore(s => s.isoThreshold)
  const depthLevels = useTarangStore(s => s.depthLevels)
  const cfMetadata = useTarangStore(s => s.cfMetadata)
  const colormapName = useTarangStore(s => s.colormap.name)
  const colormapLog = useTarangStore(s => s.colormap.logScale)
  const setSelectedPlatform = useTarangStore(s => s.setSelectedPlatform)
  const setColormap = useTarangStore(s => s.setColormap)

  const units = cfMetadata[activeVar]?.units ?? ''

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

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    let disposed = false
    const abort = new AbortController()
    setStatus('loading')
    setErrMsg(null)

    const [minLon, minLat, maxLon, maxLat] = bbox
    const lonSpan = Math.max(maxLon - minLon, 0.01)
    const latSpan = Math.max(maxLat - minLat, 0.01)
    const aspect = latSpan / lonSpan
    const lonW = aspect >= 1 ? BOX_MAX_HORIZONTAL / aspect : BOX_MAX_HORIZONTAL
    const latW = aspect >= 1 ? BOX_MAX_HORIZONTAL : BOX_MAX_HORIZONTAL * aspect
    const depthWorld = BOX_DEPTH
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
    camera.position.set(lonW * 1.1, depthWorld * 0.95, latW * 1.5)
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
    const lonTitle = makeTextSprite('LONGITUDE →', { color: '#5ec8ff' })
    lonTitle.position.set(0, -depthWorld - 0.9, latW / 2 + 0.9)
    scene.add(lonTitle)

    const latTitle = makeTextSprite('← LATITUDE', { color: '#5ec8ff' })
    latTitle.position.set(lonW / 2 + 1.1, -depthWorld - 0.9, 0)
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
      t2.position.set(lonW / 2 + 0.5, -depthWorld - 0.35, (frac - 0.5) * latW)
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

    // ── Instrument markers (co-visualization — the PS's core ask) ───────────
    const markerMeshes: THREE.Mesh[] = []
    const markerIds = new Map<THREE.Mesh, string>()
    fetchInstruments({ bbox }, abort.signal)
      .then(({ instruments }) => {
        if (disposed) return
        for (const inst of instruments) {
          const color = TYPE_COLORS[inst.type] ?? TYPE_COLORS.default
          // Instruments carry no depth of their own — sit the pin on the sea surface (top face);
          // its full vertical profile is one click away in the popover.
          const marker = new THREE.Mesh(
            new THREE.SphereGeometry(0.17, 16, 16),
            new THREE.MeshPhongMaterial({ color, emissive: color, emissiveIntensity: 0.35 })
          )
          marker.position.copy(project(inst.lon, inst.lat, 0))
          scene.add(marker)
          markerMeshes.push(marker)
          markerIds.set(marker, inst.platform_id)
        }
      })
      .catch(err => { if (err?.name !== 'AbortError') console.error(err) })

    // ── Mode-specific real data mesh ───────────────────────────────────────
    const dataGroup = new THREE.Group()
    scene.add(dataGroup)

    ;(async () => {
      try {
        if (mode === 'volume') {
          const { header, data } = await fetchVolume(
            { source: activeSourceId, var: activeVar, time: activeTimeIdx, bbox },
            abort.signal,
          )
          if (disposed) return
          const [depthSize, latSize, lonSize] = header.shape

          const texture = new THREE.Data3DTexture(data, lonSize, latSize, depthSize)
          texture.format = THREE.RedFormat
          texture.type = THREE.FloatType
          // NearestFilter: linear on a float texture needs OES_texture_float_linear (see VolumeLayer).
          texture.minFilter = THREE.NearestFilter
          texture.magFilter = THREE.NearestFilter
          texture.unpackAlignment = 1
          texture.needsUpdate = true

          // Auto-contrast-stretch to the fetched data's real range — see dataStats.ts. Drives
          // both the shader and the reused <Legend/> (via the store's colormap min/max).
          const [dataMin, dataMax] = computeDataRange(
            data, header.missing_value, header.valid_min, header.valid_max,
          )
          setColormap({ min: dataMin, max: dataMax })

          const material = new THREE.ShaderMaterial({
            vertexShader: volumeVertShader,
            fragmentShader: workspaceVolumeFrag,
            uniforms: {
              u_data: { value: texture },
              u_worldToUnit: { value: worldToUnit },
              u_clim: { value: new THREE.Vector2(dataMin, dataMax) },
              u_opacity: { value: 0.9 },
              u_missing: { value: header.missing_value ?? -9999.0 },
              u_colormap: { value: COLORMAP_INDEX[colormapName] ?? 0 },
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
          if (header.depth_levels?.length) setDepthTicks(Math.max(...header.depth_levels))
          setStatus('ready')
        } else {
          const { header, verts, faces } = await fetchIsosurface(
            { source: activeSourceId, var: activeVar, threshold: isoThreshold, time: activeTimeIdx, bbox },
            abort.signal,
          )
          if (disposed) return
          if (header.n_verts === 0 || verts.length === 0) {
            setStatus('empty')
            return
          }

          // fetchIsosurface() verts are marching-cubes voxel indices in (depth, lat, lon) order,
          // each in [0, size-1]. Normalise to a [0,1] grid fraction, then run through the SAME
          // unitToWorld the volume shader and markers use. Depth uses the index fraction (not a
          // metre value) so the surface lines up with the volume raymarch, which is also
          // index-parametrised. `verts` is the shared fetch buffer — read only, never mutate it
          // (IsosurfaceLayer copies before its own geometry.translate() for the same reason).
          const [depthSize, latSize, lonSize] = header.volume_shape
          const positions = new Float32Array(verts.length)
          const v = new THREE.Vector3()
          for (let i = 0; i < verts.length; i += 3) {
            const lonFrac = lonSize > 1 ? verts[i + 2] / (lonSize - 1) : 0.5
            let latFrac = latSize > 1 ? verts[i + 1] / (latSize - 1) : 0.5
            if (LAT_FLIP) latFrac = 1 - latFrac
            const depthFrac = depthSize > 1 ? verts[i] / (depthSize - 1) : 0
            v.set(lonFrac, latFrac, depthFrac).applyMatrix4(unitToWorld)
            positions[i] = v.x
            positions[i + 1] = v.y
            positions[i + 2] = v.z
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
          if (header.depth_levels?.length) setDepthTicks(Math.max(...header.depth_levels))
          setStatus('ready')
        }
      } catch (err: any) {
        if (disposed || err?.name === 'AbortError') return
        console.error(err)
        setErrMsg(err?.message ?? String(err))
        setStatus('error')
      }
    })()

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
      disposed = true
      abort.abort()
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
  }, [
    mode, bbox, activeSourceId, activeVar, activeTimeIdx, isoThreshold, depthLevels,
    colormapName, colormapLog, setSelectedPlatform, setColormap,
  ])

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
    zIndex: 200,
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
