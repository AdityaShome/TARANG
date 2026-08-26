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

import React, { useEffect, useRef, useCallback } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { useTarangStore } from '../state/store'
import { LayerManager } from './LayerManager'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { DepthSliceLayer } from './layers/DepthSliceLayer'
import { VolumeLayer } from './layers/VolumeLayer'
import { IsosurfaceLayer } from './layers/IsosurfaceLayer'
import { InstrumentMarkerLayer } from './layers/InstrumentMarkerLayer'

interface SceneManagerProps {
  autoRotate?: boolean
}

// ── Constants ─────────────────────────────────────────────────────────────────
const EARTH_RADIUS = 200
const BOB_CENTER   = new THREE.Vector3(0, 0, 0)   // scene origin
const BOB_LAT_C    = 15   // deg — centre of Bay of Bengal
const BOB_LON_C    = 90   // deg

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
  const particlesRef    = useRef<THREE.Points | null>(null)
  const clockRef        = useRef(new THREE.Clock())

  const activeSourceId  = useTarangStore(s => s.activeSourceId)
  const activeVar       = useTarangStore(s => s.activeVar)
  const activeDepthIdx  = useTarangStore(s => s.activeDepthIdx)
  const activeTimeIdx   = useTarangStore(s => s.activeTimeIdx)
  const renderMode      = useTarangStore(s => s.renderMode)
  const colormap        = useTarangStore(s => s.colormap)
  const bbox            = useTarangStore(s => s.bbox)
  const layerVisibility = useTarangStore(s => s.layerVisibility)

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

    // ── Camera — aimed at Bay of Bengal ───────────────────────────────────
    const camera = new THREE.PerspectiveCamera(45, w / h, 1, 5000)
    const camTarget = latLonToXYZ(BOB_LAT_C, BOB_LON_C, EARTH_RADIUS * 2.4)
    camera.position.copy(camTarget)
    camera.lookAt(0, 0, 0)
    cameraRef.current = camera

    // ── Post Processing (Bloom) ───────────────────────────────────────────
    const composer = new EffectComposer(renderer)
    const renderScene = new RenderPass(scene, camera)
    const bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 1.5, 0.4, 0.85)
    bloomPass.threshold = 0.95
    bloomPass.strength = 1.0
    bloomPass.radius = 0.8
    composer.addPass(renderScene)
    composer.addPass(bloomPass)

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
        if (particlesRef.current) {
            (particlesRef.current.material as THREE.ShaderMaterial).uniforms.tDay.value = tex;
        }
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

    // ── Lat/Lon grid over Indian Ocean ────────────────────────────────────
    const gridMat = new THREE.LineBasicMaterial({
      color: 0x00d4ff, transparent: true, opacity: 0.08, depthWrite: false,
    })
    // Draw parallels 0° to 30°N every 5°
    for (let lat = 0; lat <= 30; lat += 5) {
      const pts: THREE.Vector3[] = []
      for (let lon = 60; lon <= 110; lon += 2) {
        pts.push(latLonToXYZ(lat, lon, EARTH_RADIUS * 1.001))
      }
      scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), gridMat))
    }
    // Draw meridians 60° to 110°E every 5°
    for (let lon = 60; lon <= 110; lon += 5) {
      const pts: THREE.Vector3[] = []
      for (let lat = -5; lat <= 35; lat += 2) {
        pts.push(latLonToXYZ(lat, lon, EARTH_RADIUS * 1.001))
      }
      scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), gridMat))
    }

    // ── Animated ocean current particles over Bay of Bengal ───────────────
    const N_PARTICLES = 15000 // Massive increase for jaw-dropping effect
    const pGeo = new THREE.BufferGeometry()
    const pPos = new Float32Array(N_PARTICLES * 3)
    const pVel = new Float32Array(N_PARTICLES * 3)
    for (let i = 0; i < N_PARTICLES; i++) {
      const lat = -10 + Math.random() * 40   // Indian Ocean spread
      const lon = 50 + Math.random() * 60    // Indian Ocean spread
      const v   = latLonToXYZ(lat, lon, EARTH_RADIUS * 1.002)
      pPos[i*3]   = v.x
      pPos[i*3+1] = v.y
      pPos[i*3+2] = v.z
      // Velocity flow field based on latitude
      pVel[i*3]   = (Math.random() - 0.5) * 0.5
      pVel[i*3+1] = (Math.random() - 0.5) * 0.5
      pVel[i*3+2] = (Math.random() - 0.5) * 0.5
    }
    pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3))
    // Store velocity in normal attribute for shader access
    pGeo.setAttribute('normal', new THREE.BufferAttribute(pVel, 3))
    
    // Custom ShaderMaterial to mask out land using tDay
    const particleVert = `
      attribute vec3 normal; // velocity
      varying vec2 vUv;
      void main() {
        // Calculate spherical UV based on position
        vec3 n = normalize(position);
        float u = 0.5 + atan(n.z, n.x) / (2.0 * 3.14159265);
        float v = 0.5 - asin(n.y) / 3.14159265;
        vUv = vec2(u, v);
        
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = 4.0 * (1000.0 / -mvPosition.z); // Increased base size from 2.0 to 4.0
        gl_Position = projectionMatrix * mvPosition;
      }
    `;
    const particleFrag = `
      uniform sampler2D tDay;
      varying vec2 vUv;
      void main() {
        // Sample earth texture to see if this is land or ocean
        vec3 texColor = texture2D(tDay, vUv).rgb;
        
        // Simple heuristic: oceans are dark blue, land is brighter and has more red/green
        // If it's bright or red > blue, it's land. Discard!
        float brightness = length(texColor);
        if (brightness > 0.4 || texColor.r > texColor.b) {
            discard; // It's land or bright clouds!
        }
        
        // Circular particle
        vec2 pt = gl_PointCoord - vec2(0.5);
        if (dot(pt, pt) > 0.25) discard;
        
        // HDR color for bloom - make it very bright
        gl_FragColor = vec4(0.0, 3.0, 4.0, 1.0);
      }
    `;

    const pMat = new THREE.ShaderMaterial({
      vertexShader: particleVert,
      fragmentShader: particleFrag,
      uniforms: {
        tDay: { value: null } // We will assign this when tDay loads
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
    
    const pMesh = new THREE.Points(pGeo, pMat)
    pMesh.userData.velocities = pVel
    scene.add(pMesh)
    particlesRef.current = pMesh

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

    // ── BOB region highlight ring ──────────────────────────────────────────
    // Glowing ring showing the Bay of Bengal study area
    const ringPts: THREE.Vector3[] = []
    const ringLats = [5, 5, 25, 25, 5]
    const ringLons = [80, 100, 100, 80, 80]
    for (let i = 0; i < ringLats.length; i++) {
      const steps = 30
      if (i < ringLats.length - 1) {
        for (let s = 0; s <= steps; s++) {
          const t = s / steps
          const lat = ringLats[i] + (ringLats[i+1] - ringLats[i]) * t
          const lon = ringLons[i] + (ringLons[i+1] - ringLons[i]) * t
          ringPts.push(latLonToXYZ(lat, lon, EARTH_RADIUS * 1.003))
        }
      }
    }
    const ringMat = new THREE.LineBasicMaterial({
      color: 0x00d4ff, transparent: true, opacity: 0.5,
    })
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ringPts), ringMat))

    // ── Render loop ───────────────────────────────────────────────────────
    function animate() {
      rafRef.current = requestAnimationFrame(animate)
      const elapsed = clockRef.current.getElapsedTime()

      // Slow Earth rotation
      if (earthRef.current) {
        earthRef.current.rotation.y = elapsed * 0.015
      }

      // Animate particles (drift on sphere surface)
      if (particlesRef.current) {
        const pos = (particlesRef.current.geometry.attributes.position as THREE.BufferAttribute)
        const vel = particlesRef.current.userData.velocities as Float32Array
        for (let i = 0; i < N_PARTICLES; i++) {
          let x = pos.array[i*3]     + vel[i*3]   * 0.3
          let y = pos.array[i*3+1]   + vel[i*3+1] * 0.3
          let z = pos.array[i*3+2]   + vel[i*3+2] * 0.3
          // Re-project onto sphere surface
          const len = Math.sqrt(x*x + y*y + z*z)
          const r   = EARTH_RADIUS * 1.002
          x = (x/len)*r; y = (y/len)*r; z = (z/len)*r
          ;(pos.array as Float32Array)[i*3]   = x
          ;(pos.array as Float32Array)[i*3+1] = y
          ;(pos.array as Float32Array)[i*3+2] = z
        }
        pos.needsUpdate = true
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

    return () => {
      cancelAnimationFrame(rafRef.current)
      ro.disconnect()
      controls.dispose()
      renderer.dispose()
      layerManager.disposeAll()
    }
  }, [autoRotate])

  // ── Update data layers on store changes ────────────────────────────────────
  useEffect(() => {
    if (!layerManagerRef.current) return

    if (layerVisibility['slice'] && renderMode === 'slice') {
      const layer = layerManagerRef.current.getLayer('slice')
      if (layer) {
        const depthLevels = useTarangStore.getState().depthLevels
        const activeDepthM = depthLevels[activeDepthIdx] ?? 0
        layer.update({
          source: activeSourceId, variable: activeVar,
          timeIdx: activeTimeIdx, depthIdx: activeDepthM,
          bbox, clim: [colormap.min, colormap.max],
          colormap: colormap.name, opacity: colormap.opacity,
        })
      }
    }

    if (layerVisibility['volume'] && renderMode === 'volume') {
      const layer = layerManagerRef.current.getLayer('volume')
      if (layer) {
        layer.update({
          source: activeSourceId, variable: activeVar,
          timeIdx: activeTimeIdx, bbox,
          clim: [colormap.min, colormap.max],
          colormap: colormap.name, opacity: colormap.opacity,
        })
      }
    }

    if (layerVisibility['isosurface'] && renderMode === 'isosurface') {
      const layer = layerManagerRef.current.getLayer('isosurface')
      if (layer) {
        layer.update({
          source: activeSourceId, variable: activeVar,
          timeIdx: activeTimeIdx, bbox, opacity: colormap.opacity,
        })
      }
    }

    if (layerVisibility['markers']) {
      const layer = layerManagerRef.current.getLayer('markers')
      if (layer) layer.update({ bbox })
    }
  }, [renderMode, activeSourceId, activeVar, activeTimeIdx, activeDepthIdx, bbox, colormap, layerVisibility])

  return (
    <canvas
      ref={canvasRef}
      id="tarang-canvas"
      style={{ display: 'block', width: '100%', height: '100%' }}
    />
  )
}
