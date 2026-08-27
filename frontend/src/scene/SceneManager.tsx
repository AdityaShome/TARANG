/**
 * SceneManager — Three.js scene ownership
 *
 * TARANG SIH 2026 · PS 26067 · MoES/INCOIS
 *
 * Owns: ONE WebGLRenderer, ONE Scene, ONE PerspectiveCamera, ONE LayerManager.
 * Builds a visually stunning Indian Ocean scene:
 *   - Photorealistic Earth sphere (Blue Marble texture via NASA CDN)
 *   - Atmospheric glow shader (Fresnel rim)
 *   - Starfield (10 000 procedural stars)
 *   - Depth slice data plane mapped over Bay of Bengal
 *   - Animated particle currents
 *   - Argo float markers as glowing sprites
 *
 * On unmount: disposes renderer + all layers (§20 Rule 7 — explicit GPU dispose).
 */

import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { useTarangStore } from '../state/store'
import { LayerManager } from './LayerManager'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { DepthSliceLayer } from './layers/DepthSliceLayer'
import { VolumeLayer } from './layers/VolumeLayer'
import { IsosurfaceLayer } from './layers/IsosurfaceLayer'
import { InstrumentMarkerLayer } from './layers/InstrumentMarkerLayer'
import { VectorLayer } from './layers/VectorLayer'

interface SceneManagerProps {
  autoRotate?: boolean
}

// ── Constants ─────────────────────────────────────────────────────────────────
const EARTH_RADIUS = 200
// Initial camera framing on load, BEFORE any region is searched — deliberately not centred
// tightly on any one sea (there is no default region; see hasSearchedRegion in store.ts).
// A wide, pulled-back view of the broader Indian Ocean invites a search instead of implying
// "this is the region," which a closer BoB-centred view used to.
const INITIAL_VIEW_LAT = 5
const INITIAL_VIEW_LON = 65
const INITIAL_VIEW_DISTANCE_MULT = 4

// Convert lat/lon to 3D point on sphere
function latLonToXYZ(lat: number, lon: number, r = EARTH_RADIUS): THREE.Vector3 {
  const phi   = (90 - lat)  * (Math.PI / 180)
  const theta = (lon + 180) * (Math.PI / 180)
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
     r * Math.cos(phi),
     r * Math.sin(phi) * Math.sin(theta),
  )
}

// ── Atmosphere vertex shader ───────────────────────────────────────────────────
const atmosphereVert = `
varying vec3 vNormal;
void main() {
  vNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`
// ── Atmosphere fragment shader ─────────────────────────────────────────────────
const atmosphereFrag = `
varying vec3 vNormal;
void main() {
  float intensity = pow(0.65 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 3.0);
  gl_FragColor = vec4(0.05, 0.35, 0.9, 1.0) * intensity;
}
`

// ── Earth Day/Night God-Level Shader ───────────────────────────────────────────────────
const earthVert = `
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vPosition;
void main() {
  vUv = uv;
  // Pass normal in world space for consistent sun lighting regardless of camera angle
  vNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
  vPosition = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * viewMatrix * vec4(vPosition, 1.0);
}
`

const earthFrag = `
uniform sampler2D tDay;
uniform sampler2D tNight;
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vPosition;

void main() {
  vec3 dayColor = texture2D(tDay, vUv).rgb;
  vec3 nightColor = texture2D(tNight, vUv).rgb;

  // If textures failed to load, fall back to a procedural deep ocean color
  if (length(dayColor) < 0.01) {
      dayColor = vec3(0.01, 0.15, 0.4);
  }
  if (length(nightColor) < 0.01) {
      nightColor = vec3(0.0, 0.01, 0.05);
  }

  // Sun direction (World space, static relative to Earth)
  vec3 sunDir = normalize(vec3(1.0, 0.2, 0.5));
  float intensity = dot(vNormal, sunDir);
  
  // Smooth day-night transition
  float mixVal = smoothstep(-0.25, 0.25, intensity);
  
  // Combine day and night (night map contains city lights)
  // Emphasize city lights by adding them where intensity is low
  vec3 finalColor = mix(nightColor * 2.5, dayColor * 1.2, mixVal);
  
  // Add an atmospheric rim glow (Fresnel effect)
  vec3 viewDir = normalize(cameraPosition - vPosition);
  float fresnel = pow(1.0 - max(dot(vNormal, viewDir), 0.0), 3.0);
  vec3 atmosphereGlow = vec3(0.3, 0.6, 1.0) * fresnel * mixVal * 1.5;
  
  finalColor += atmosphereGlow;
  
  // Clamp maximum brightness to 0.8 so the Earth NEVER triggers the bloom pass (threshold 0.95)
  finalColor = min(finalColor, vec3(0.8));
  
  gl_FragColor = vec4(finalColor, 1.0);
}
`

export function SceneManager({ autoRotate = false }: SceneManagerProps) {
  const canvasRef       = useRef<HTMLCanvasElement>(null)
  const rendererRef     = useRef<THREE.WebGLRenderer | null>(null)
  const sceneRef        = useRef<THREE.Scene | null>(null)
  const cameraRef       = useRef<THREE.PerspectiveCamera | null>(null)
  const controlsRef     = useRef<OrbitControls | null>(null)
  const rafRef          = useRef<number>(0)
  const layerManagerRef = useRef<LayerManager | null>(null)
  const earthRef        = useRef<THREE.Mesh | null>(null)
  const boundaryRef     = useRef<THREE.Line | null>(null)
  const clockRef        = useRef(new THREE.Clock())

  const activeSourceId  = useTarangStore(s => s.activeSourceId)
  const activeVar       = useTarangStore(s => s.activeVar)
  const activeDepthIdx  = useTarangStore(s => s.activeDepthIdx)
  const activeTimeIdx   = useTarangStore(s => s.activeTimeIdx)
  const renderMode      = useTarangStore(s => s.renderMode)
  const colormap        = useTarangStore(s => s.colormap)
  const bbox            = useTarangStore(s => s.bbox)
  const layerVisibility = useTarangStore(s => s.layerVisibility)
  const isLoading       = useTarangStore(s => s.isLoading)
  const flyToTarget     = useTarangStore(s => s.flyToTarget)
  const clearFlyToTarget = useTarangStore(s => s.clearFlyToTarget)
  const hasSearchedRegion = useTarangStore(s => s.hasSearchedRegion)

  // ── Mount: build the entire scene ──────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current!
    const w = canvas.clientWidth  || canvas.offsetWidth  || 800
    const h = canvas.clientHeight || canvas.offsetHeight || 600

    // ── Renderer ──────────────────────────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, alpha: false, powerPreference: 'high-performance',
    })
    renderer.setSize(w, h)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping      = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.1
    rendererRef.current = renderer

    // ── Scene ─────────────────────────────────────────────────────────────
    const scene = new THREE.Scene()
    sceneRef.current = scene

    // ── Camera — wide initial view; see INITIAL_VIEW_* comment above ──────
    const camera = new THREE.PerspectiveCamera(45, w / h, 1, 5000)
    const camTarget = latLonToXYZ(INITIAL_VIEW_LAT, INITIAL_VIEW_LON, EARTH_RADIUS * INITIAL_VIEW_DISTANCE_MULT)
    camera.position.copy(camTarget)
    camera.lookAt(0, 0, 0)
    cameraRef.current = camera

    // ── Post Processing (Bloom) ───────────────────────────────────────────
    const composer = new EffectComposer(renderer)
    const renderScene = new RenderPass(scene, camera)
    const bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 1.5, 0.4, 0.85)
    // Kept tight on purpose: UnrealBloomPass has a soft knee below `threshold`, so a wide
    // `radius` still spreads glow from content that doesn't fully clear it — over a large
    // filled bright area (the data slice/volume) that reads as an oversized, washed-out halo
    // rather than a crisp gradient. Reserve bloom for small genuinely-HDR points (particles).
    bloomPass.threshold = 1.0
    bloomPass.strength = 0.6
    bloomPass.radius = 0.3
    composer.addPass(renderScene)
    composer.addPass(bloomPass)
    // EffectComposer renders into its own chain of render targets — the renderer's
    // toneMapping/outputColorSpace settings above only apply automatically when rendering
    // straight to the canvas, NOT through the composer. Without this pass as the final step,
    // raw HDR values get written close to directly to the screen, and exactly how out-of-range
    // (>1.0) values get clamped there is GPU/driver-dependent — this is why bloom (and the HDR
    // particle/data colors) can look wildly different, or blow out globally, across machines.
    composer.addPass(new OutputPass())

    // ── Controls ──────────────────────────────────────────────────────────
    const controls = new OrbitControls(camera, canvas)
    controls.enableDamping   = true
    controls.dampingFactor   = 0.06
    controls.autoRotate      = autoRotate
    controls.autoRotateSpeed = 0.25
    controls.minDistance     = EARTH_RADIUS * 1.1
    controls.maxDistance     = EARTH_RADIUS * 6
    controls.target.set(0, 0, 0)
    controls.update()
    controlsRef.current = controls

    // ── Starfield ─────────────────────────────────────────────────────────
    const starGeo  = new THREE.BufferGeometry()
    const starPositions = new Float32Array(10000 * 3)
    for (let i = 0; i < 10000 * 3; i++) {
      starPositions[i] = (Math.random() - 0.5) * 8000
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3))
    const starMat = new THREE.PointsMaterial({ color: 0x555555, size: 0.7, sizeAttenuation: true })
    scene.add(new THREE.Points(starGeo, starMat))

    // ── Earth sphere ──────────────────────────────────────────────────────
    const earthGeo = new THREE.SphereGeometry(EARTH_RADIUS, 128, 128)
    const texLoader = new THREE.TextureLoader()

    const earthMat = new THREE.ShaderMaterial({
      vertexShader: earthVert,
      fragmentShader: earthFrag,
      uniforms: {
        tDay: { value: null },
        tNight: { value: null }
      }
    })

    const earthMesh = new THREE.Mesh(earthGeo, earthMat)
    scene.add(earthMesh)
    earthRef.current = earthMesh

    // Load NASA Blue Marble (Day) and Night lights from local public directory
    texLoader.load(
      '/earth-blue-marble.jpg',
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        earthMat.uniforms.tDay.value = tex;
        earthMat.needsUpdate = true;
      }
    )
    texLoader.load(
      '/earth-night.jpg',
      (tex) => { 
        tex.colorSpace = THREE.SRGBColorSpace;
        earthMat.uniforms.tNight.value = tex; 
        earthMat.needsUpdate = true;
      }
    )

    // ── Atmosphere glow ───────────────────────────────────────────────────
    const atmGeo = new THREE.SphereGeometry(EARTH_RADIUS * 1.04, 64, 64)
    const atmMat = new THREE.ShaderMaterial({
      vertexShader:   atmosphereVert,
      fragmentShader: atmosphereFrag,
      blending:       THREE.AdditiveBlending,
      side:           THREE.BackSide,
      transparent:    true,
      depthWrite:     false,
    })
    scene.add(new THREE.Mesh(atmGeo, atmMat))

    // (The static Indian-Ocean-only reference grid that used to live here was replaced by a
    // boundary box that tracks whatever region is actually searched — see the `bbox`-keyed
    // effect below. A grid fixed to one ocean stopped making sense once search is global.)

    // ── Lighting ──────────────────────────────────────────────────────────
    scene.add(new THREE.AmbientLight(0xffffff, 1.8))
    const sun = new THREE.DirectionalLight(0xffeedd, 3.5)
    sun.position.set(500, 200, 300)
    scene.add(sun)
    // Subtle blue rim from opposite side (night side)
    const rim = new THREE.DirectionalLight(0x2255ff, 1.5)
    rim.position.set(-500, -100, -300)
    scene.add(rim)

    // ── LayerManager ──────────────────────────────────────────────────────
    const layerManager = new LayerManager(scene)
    layerManagerRef.current = layerManager
    layerManager.addLayer('slice',      new DepthSliceLayer())
    layerManager.addLayer('volume',     new VolumeLayer())
    layerManager.addLayer('isosurface', new IsosurfaceLayer())
    layerManager.addLayer('markers',    new InstrumentMarkerLayer())
    layerManager.addLayer('vectors',    new VectorLayer())

    // (A hardcoded "Bay of Bengal region highlight ring" used to live here, always drawn
    // regardless of search state. Replaced by the boundary-box effect further down, which
    // tracks whatever region is actually searched and draws nothing until then.)

    // ── Render loop ───────────────────────────────────────────────────────
    function animate() {
      rafRef.current = requestAnimationFrame(animate)
      const elapsed = clockRef.current.getElapsedTime()

      // Slow Earth rotation — only in Explorer Mode's cinematic flythrough (autoRotate=true).
      // The Forecaster Console (autoRotate=false, the default) needs a STILL globe: a
      // researcher searching a region and inspecting it doesn't want the ground moving
      // under them a second later.
      if (earthRef.current && autoRotate) {
        earthRef.current.rotation.y = elapsed * 0.015
      }

      controlsRef.current?.update()
      composer.render()
    }
    animate()

    // ── Resize handler ────────────────────────────────────────────────────
    const ro = new ResizeObserver(() => {
      const w2 = canvas.clientWidth
      const h2 = canvas.clientHeight
      if (w2 === 0 || h2 === 0) return
      renderer.setSize(w2, h2)
      camera.aspect = w2 / h2
      camera.updateProjectionMatrix()
    })
    ro.observe(canvas)

    // ── Click-to-inspect an instrument marker ───────────────────────────────
    // InstrumentMarkerLayer already exposes getMesh()/getPlatformIdAt() for exactly this, but
    // nothing ever called them — clicking a float marker did nothing. Raycast against the
    // markers' InstancedMesh; ForecasterConsole already renders <ProfilePopover> whenever
    // selectedPlatformId is set, so setting it here is the only missing piece.
    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    let downPos: { x: number; y: number } | null = null

    function onPointerDown(e: PointerEvent) {
      downPos = { x: e.clientX, y: e.clientY }
    }

    function onPointerUp(e: PointerEvent) {
      // Ignore drags (camera orbit) — only treat as a click if the pointer barely moved.
      if (!downPos || Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 4) {
        downPos = null
        return
      }
      downPos = null

      const markerLayer = layerManagerRef.current?.getLayer('markers') as InstrumentMarkerLayer | undefined
      const meshes = markerLayer?.getMeshes?.()
      if (!meshes || meshes.length === 0) return

      const rect = canvas.getBoundingClientRect()
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1

      raycaster.setFromCamera(pointer, camera)
      const hits = raycaster.intersectObjects(meshes)
      if (hits.length > 0 && hits[0].instanceId !== undefined) {
        const hitMesh = hits[0].object as THREE.InstancedMesh
        const platformId = markerLayer!.getPlatformIdAt(hitMesh, hits[0].instanceId)
        if (platformId) useTarangStore.getState().setSelectedPlatform(platformId)
      }
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointerup', onPointerUp)

    return () => {
      cancelAnimationFrame(rafRef.current)
      ro.disconnect()
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointerup', onPointerUp)
      controls.dispose()
      renderer.dispose()
      layerManager.disposeAll()
    }
  }, [autoRotate])

  // ── Update data layers on store changes ────────────────────────────────────
  useEffect(() => {
    if (!layerManagerRef.current) return
    // store.setActiveSource() clears activeVar synchronously so it can never name a variable
    // belonging to the PREVIOUS source. App.tsx's bootstrap effect re-fetches metadata and
    // calls setActiveVar once it knows the right name for the new source — until then, skip
    // firing layer requests (otherwise we ask the new source for a variable it doesn't have
    // and the backend 500s).
    // No default sea — nothing renders until the researcher actually searches a region.
    if (!hasSearchedRegion) return
    if (!activeVar || isLoading) return

    // Collected so a search/region change can show real "still fetching" feedback (e.g. a live,
    // uncached Copernicus region search can take tens of seconds) instead of the UI just
    // guessing when to stop showing a spinner. Deliberately NOT read/set through the `isLoading`
    // flag this effect also guards on above — toggling that here would make the effect re-fire
    // itself (isLoading is one of its own deps) and re-request the same data twice.
    const pending: Promise<void>[] = []

    if (layerVisibility['slice'] && renderMode === 'slice') {
      const layer = layerManagerRef.current.getLayer('slice')
      if (layer) {
        const depthLevels = useTarangStore.getState().depthLevels
        const activeDepthM = depthLevels[activeDepthIdx] ?? 0
        pending.push(layer.update({
          source: activeSourceId, variable: activeVar,
          timeIdx: activeTimeIdx, depthIdx: activeDepthM,
          bbox, clim: [colormap.min, colormap.max],
          colormap: colormap.name, opacity: colormap.opacity,
        }))
      }
    }

    if (layerVisibility['volume'] && renderMode === 'volume') {
      const layer = layerManagerRef.current.getLayer('volume')
      if (layer) {
        pending.push(layer.update({
          source: activeSourceId, variable: activeVar,
          timeIdx: activeTimeIdx, bbox,
          clim: [colormap.min, colormap.max],
          colormap: colormap.name, opacity: colormap.opacity,
        }))
      }
    }

    if (layerVisibility['isosurface'] && renderMode === 'isosurface') {
      const layer = layerManagerRef.current.getLayer('isosurface')
      if (layer) {
        pending.push(layer.update({
          source: activeSourceId, variable: activeVar,
          timeIdx: activeTimeIdx, bbox, opacity: colormap.opacity,
        }))
      }
    }

    if (layerVisibility['markers']) {
      const layer = layerManagerRef.current.getLayer('markers')
      if (layer) pending.push(layer.update({ bbox }))
    }

    if (layerVisibility['vectors']) {
      const layer = layerManagerRef.current.getLayer('vectors')
      if (layer) pending.push(layer.update({ bbox, timeIdx: activeTimeIdx, opacity: colormap.opacity }))
    }

    if (pending.length > 0) {
      useTarangStore.getState().setFetchingLayers(true)
      Promise.allSettled(pending).finally(() => useTarangStore.getState().setFetchingLayers(false))
    }
  }, [renderMode, activeSourceId, activeVar, activeTimeIdx, activeDepthIdx, bbox, colormap, layerVisibility, isLoading, hasSearchedRegion])

  // ── Region search: fly the camera to the searched location ─────────────────
  useEffect(() => {
    if (!flyToTarget || !cameraRef.current || !controlsRef.current) return
    const camera = cameraRef.current
    const controls = controlsRef.current

    // Keep the current zoom distance — only change WHERE we're looking, matching how the
    // camera was originally aimed at BOB_LAT_C/BOB_LON_C on mount (see camTarget above).
    const distance = camera.position.length() || EARTH_RADIUS * 2.4
    const newPos = latLonToXYZ(flyToTarget.lat, flyToTarget.lon, distance)
    camera.position.copy(newPos)
    controls.target.set(0, 0, 0)
    controls.update()

    clearFlyToTarget()
  }, [flyToTarget, clearFlyToTarget])

  // ── Draw a boundary outline around the current search region ───────────────
  useEffect(() => {
    if (!sceneRef.current) return
    const scene = sceneRef.current

    if (boundaryRef.current) {
      scene.remove(boundaryRef.current)
      boundaryRef.current.geometry.dispose()
      ;(boundaryRef.current.material as THREE.Material).dispose()
      boundaryRef.current = null
    }

    // No default sea — don't draw a box around the placeholder bbox before any search.
    if (!hasSearchedRegion) return

    const [minLon, minLat, maxLon, maxLat] = bbox
    const r = EARTH_RADIUS * 1.006  // clear of the depth-slice layer (1.0025) and grid lines
    const pts: THREE.Vector3[] = []
    const STEP = 1 // degrees — dense enough that the box reads as a curve, not a polygon
    for (let lon = minLon; lon <= maxLon; lon += STEP) pts.push(latLonToXYZ(minLat, lon, r))
    pts.push(latLonToXYZ(minLat, maxLon, r))
    for (let lat = minLat; lat <= maxLat; lat += STEP) pts.push(latLonToXYZ(lat, maxLon, r))
    pts.push(latLonToXYZ(maxLat, maxLon, r))
    for (let lon = maxLon; lon >= minLon; lon -= STEP) pts.push(latLonToXYZ(maxLat, lon, r))
    pts.push(latLonToXYZ(maxLat, minLon, r))
    for (let lat = maxLat; lat >= minLat; lat -= STEP) pts.push(latLonToXYZ(lat, minLon, r))
    pts.push(latLonToXYZ(minLat, minLon, r))

    const geo = new THREE.BufferGeometry().setFromPoints(pts)
    const mat = new THREE.LineBasicMaterial({ color: 0x00d4ff, transparent: true, opacity: 0.6 })
    const line = new THREE.Line(geo, mat)
    scene.add(line)
    boundaryRef.current = line
  }, [bbox, hasSearchedRegion])

  return (
    <canvas
      ref={canvasRef}
      id="tarang-canvas"
      style={{ display: 'block', width: '100%', height: '100%' }}
    />
  )
}
