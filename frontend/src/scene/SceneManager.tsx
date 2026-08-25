/**
 * SceneManager — Three.js scene ownership
 *
 * Owns: ONE WebGLRenderer, ONE Scene, ONE PerspectiveCamera, ONE LayerManager.
 * Components NEVER touch Three.js directly — all scene mutations go through LayerManager.
 * On unmount: disposes renderer + all layers (§20 Rule 7 — explicit GPU dispose).
 *
 * Props:
 *   autoRotate — used by ExplorerMode for passive flythrough
 */

import React, { useEffect, useRef, useCallback } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { useTarangStore } from '../state/store'
import { LayerManager } from './LayerManager'
import { DepthSliceLayer } from './layers/DepthSliceLayer'
import { VolumeLayer } from './layers/VolumeLayer'
import { IsosurfaceLayer } from './layers/IsosurfaceLayer'
import { InstrumentMarkerLayer } from './layers/InstrumentMarkerLayer'

interface SceneManagerProps {
  autoRotate?: boolean
}

export function SceneManager({ autoRotate = false }: SceneManagerProps) {
  const canvasRef   = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const sceneRef    = useRef<THREE.Scene | null>(null)
  const cameraRef   = useRef<THREE.PerspectiveCamera | null>(null)
  const controlsRef = useRef<OrbitControls | null>(null)
  const rafRef      = useRef<number>(0)
  const layerManagerRef = useRef<LayerManager | null>(null)

  // Watch for state changes that require scene updates
  const activeSourceId = useTarangStore(s => s.activeSourceId)
  const activeVar      = useTarangStore(s => s.activeVar)
  const activeDepthIdx = useTarangStore(s => s.activeDepthIdx)
  const activeTimeIdx  = useTarangStore(s => s.activeTimeIdx)
  const renderMode     = useTarangStore(s => s.renderMode)
  const colormap       = useTarangStore(s => s.colormap)
  const bbox           = useTarangStore(s => s.bbox)
  const layerVisibility = useTarangStore(s => s.layerVisibility)

  // ── Mount: create renderer, scene, camera ─────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current!
    const w = canvas.clientWidth
    const h = canvas.clientHeight

    // ── Renderer (WebGL2) ─────────────────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias:    true,
      alpha:        false,
      powerPreference: 'high-performance',
    })
    renderer.setSize(w, h)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    rendererRef.current = renderer

    // ── Scene ─────────────────────────────────────────────────────────────
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x020810)
    sceneRef.current = scene

    // ── Camera ────────────────────────────────────────────────────────────
    const camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 10000)
    camera.position.set(0, 150, 400)  // overview position for BoB
    cameraRef.current = camera

    // ── Controls ──────────────────────────────────────────────────────────
    const controls = new OrbitControls(camera, canvas)
    controls.enableDamping    = true
    controls.dampingFactor    = 0.05
    controls.autoRotate       = autoRotate
    controls.autoRotateSpeed  = 0.3
    controls.minDistance      = 10
    controls.maxDistance      = 2000
    controlsRef.current = controls

    // ── LayerManager ──────────────────────────────────────────────────────
    const layerManager = new LayerManager(scene)
    layerManagerRef.current = layerManager
    layerManager.addLayer('slice', new DepthSliceLayer())
    layerManager.addLayer('volume', new VolumeLayer())
    layerManager.addLayer('isosurface', new IsosurfaceLayer())
    layerManager.addLayer('markers', new InstrumentMarkerLayer())

    // ── Ambient lighting ──────────────────────────────────────────────────
    scene.add(new THREE.AmbientLight(0xffffff, 0.6))
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8)
    dirLight.position.set(1, 2, 3)
    scene.add(dirLight)

    // ── Render loop ───────────────────────────────────────────────────────
    function animate() {
      rafRef.current = requestAnimationFrame(animate)
      controls.update()
      renderer.render(scene, camera)
    }
    animate()

    // ── Resize handler ─────────────────────────────────────────────────────
    const ro = new ResizeObserver(() => {
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    })
    ro.observe(canvas)

    // ── Unmount cleanup ────────────────────────────────────────────────────
    return () => {
      cancelAnimationFrame(rafRef.current)
      ro.disconnect()
      controls.dispose()
      renderer.dispose()     // (§20 Rule 7)
      layerManager.disposeAll()
    }
  }, [autoRotate])

  // ── Update layers on store changes ──────────────────────────────────────
  useEffect(() => {
    if (!layerManagerRef.current) return
    
    if (layerVisibility['slice'] && renderMode === 'slice') {
      const layer = layerManagerRef.current.getLayer('slice')
      if (layer) {
        layer.update({
          source: activeSourceId,
          variable: activeVar,
          timeIdx: activeTimeIdx,
          depthIdx: activeDepthIdx,
          bbox: bbox,
          clim: [colormap.min, colormap.max],
          colormap: colormap.name,
          opacity: colormap.opacity
        })
      }
    }

    if (layerVisibility['volume'] && renderMode === 'volume') {
      const layer = layerManagerRef.current.getLayer('volume')
      if (layer) {
        layer.update({
          source: activeSourceId,
          variable: activeVar,
          timeIdx: activeTimeIdx,
          bbox: bbox,
          clim: [colormap.min, colormap.max],
          colormap: colormap.name,
          opacity: colormap.opacity
        })
      }
    }

    if (layerVisibility['isosurface'] && renderMode === 'isosurface') {
      const layer = layerManagerRef.current.getLayer('isosurface')
      if (layer) {
        layer.update({
          source: activeSourceId,
          variable: activeVar,
          timeIdx: activeTimeIdx,
          bbox: bbox,
          opacity: colormap.opacity
        })
      }
    }

    if (layerVisibility['markers']) {
      const layer = layerManagerRef.current.getLayer('markers')
      if (layer) {
        layer.update({ bbox })
      }
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
