import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { useTarangStore } from '../state/store'
import { fetchVolume } from '../api/client'
import { computeDataRange } from '../scene/layers/dataStats'

import vertShader from '../scene/shaders/workspaceVolumeVert.glsl?raw'
import fragShader from '../scene/shaders/workspaceVolumeFrag.glsl?raw'



interface VolumeState {
  dataMin: number
  dataMax: number
  varName: string
  region: string
}

export function VolumeWorkspace() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [volState, setVolState] = useState<VolumeState | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const renderMode     = useTarangStore(s => s.renderMode)
  const setRenderMode  = useTarangStore(s => s.setRenderMode)
  const bbox           = useTarangStore(s => s.bbox)
  const activeSourceId = useTarangStore(s => s.activeSourceId)
  const activeVar      = useTarangStore(s => s.activeVar)
  const activeTimeIdx  = useTarangStore(s => s.activeTimeIdx)
  const regionLabel    = useTarangStore(s => s.regionLabel)
  const cfMetadata     = useTarangStore(s => s.cfMetadata)
  const storeError     = useTarangStore(s => s.error)

  if (renderMode !== 'cube') return null
  if (!activeVar) {
    if (storeError) {
      return (
        <div style={{ width: '100vw', height: '100vh', background: '#070d1a', color: '#ff9999', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Inter, sans-serif', fontSize: 16 }}>
          <div style={{ textAlign: 'center', maxWidth: 420, padding: 20, border: '1px solid #aa3333', borderRadius: 10, background: 'rgba(60,0,0,0.85)' }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>❌</div>
            {storeError}
          </div>
        </div>
      )
    }
    return (
      <div style={{ width: '100vw', height: '100vh', background: '#070d1a', color: '#88ccff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Inter, sans-serif', fontSize: 16 }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
          Loading data source metadata...
        </div>
      </div>
    )
  }

  useEffect(() => {
    if (!containerRef.current) return
    const container = containerRef.current

    setLoading(true)
    setError(null)

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    renderer.setSize(container.clientWidth, container.clientHeight)
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.setClearColor(0x070d1a, 1)
    container.appendChild(renderer.domElement)

    const scene = new THREE.Scene()

    const camera = new THREE.PerspectiveCamera(40, container.clientWidth / container.clientHeight, 0.01, 1000)
    camera.position.set(3.5, 2.2, 4.0)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.06
    controls.target.set(0, 0, 0)

    // Track disposables
    const disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = []
    const objects3d: THREE.Object3D[] = []

    function add(obj: THREE.Object3D) { scene.add(obj); objects3d.push(obj) }

    function makeLabel(text: string, pos: THREE.Vector3, size = 0.28, color = '#88bbff') {
      const c = document.createElement('canvas')
      c.width = 512; c.height = 80
      const ctx = c.getContext('2d')!
      ctx.fillStyle = color
      ctx.font = 'bold 36px Arial, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(text, 256, 40)
      const tex = new THREE.CanvasTexture(c)
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false })
      const sprite = new THREE.Sprite(mat)
      const asp = c.width / c.height
      sprite.scale.set(size * asp, size, 1)
      sprite.position.copy(pos)
      add(sprite)
      disposables.push(mat, tex)
    }

    function addBox(W: number, H: number, D: number) {
      // Grid lines on bottom face
      const gridMat = new THREE.LineBasicMaterial({ color: 0x1a4466, transparent: true, opacity: 0.4 })
      disposables.push(gridMat)
      const GCOLS = 8, GROWS = 8
      for (let i = 0; i <= GCOLS; i++) {
        const x = -W / 2 + (i / GCOLS) * W
        const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x, -D / 2, -H / 2), new THREE.Vector3(x, -D / 2, H / 2)])
        const line = new THREE.Line(geo, gridMat)
        add(line); disposables.push(geo)
      }
      for (let j = 0; j <= GROWS; j++) {
        const z = -H / 2 + (j / GROWS) * H
        const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-W / 2, -D / 2, z), new THREE.Vector3(W / 2, -D / 2, z)])
        const line = new THREE.Line(geo, gridMat)
        add(line); disposables.push(geo)
      }

      // Bounding box wireframe
      const boxMat = new THREE.LineBasicMaterial({ color: 0x2266aa, transparent: true, opacity: 0.65 })
      disposables.push(boxMat)
      const boxGeo = new THREE.BoxGeometry(W, D, H)
      const edges = new THREE.EdgesGeometry(boxGeo)
      const wire = new THREE.LineSegments(edges, boxMat)
      add(wire); disposables.push(boxGeo, edges)
    }

    let active = true
    const abort = new AbortController()
    let animId: number

    async function loadData() {
      try {
        const result = await fetchVolume({ source: activeSourceId, var: activeVar, time: activeTimeIdx, bbox }, abort.signal)
        if (!active) return

        const { header, data } = result
        const [depthSize, latSize, lonSize] = header.shape
        const [dataMin, dataMax] = computeDataRange(data, header.missing_value, header.valid_min, header.valid_max)
        const [minLon, minLat, maxLon, maxLat] = bbox
        const lonSpan = maxLon - minLon
        const latSpan = maxLat - minLat

        // Dimensions: lon=X, depth=Y, lat=Z
        const W = 2.0
        const H = W * (latSpan / Math.max(lonSpan, 0.01))
        const D = 1.2

        addBox(W, H, D)

        // ── Build Volumetric Raymarching Cube ──────────────────────────────────
        const tex = new THREE.Data3DTexture(data as any, lonSize, latSize, depthSize)
        tex.format = THREE.RedFormat
        tex.type = THREE.FloatType
        tex.minFilter = THREE.LinearFilter
        tex.magFilter = THREE.LinearFilter
        tex.unpackAlignment = 1
        tex.needsUpdate = true
        disposables.push(tex)

        const geo = new THREE.BoxGeometry(W, D, H)
        disposables.push(geo)

        const mat = new THREE.ShaderMaterial({
          vertexShader: vertShader,
          fragmentShader: fragShader,
          uniforms: {
            u_data: { value: tex },
            u_clim: { value: new THREE.Vector2(dataMin, dataMax) },
            u_missing: { value: header.missing_value },
            u_opacity: { value: 1.0 }, // Base density
            u_cameraPos: { value: new THREE.Vector3() }
          },
          transparent: true,
          side: THREE.DoubleSide,
          depthWrite: false,
          glslVersion: THREE.GLSL3,
        })
        disposables.push(mat)

        const mesh = new THREE.Mesh(geo, mat)
        
        // Ensure shader knows camera position in local space!
        // We will update this in the render loop.
        // Wait, the mesh is centered at origin and not rotated. So world pos = local pos * scale.
        // But the BoxGeometry is scaled to (W, D, H).
        // Let's pass the raw camera position, but scaled into the local unit box.
        mesh.onBeforeRender = function(_renderer, _scene, camera) {
          const c = camera.position
          // Inverse scale to map camera position into the [-0.5, 0.5] box coordinates, then shift to [0, 1]
          mat.uniforms.u_cameraPos.value.set(
            (c.x / W) + 0.5,
            (c.y / D) + 0.5,
            (c.z / H) + 0.5
          )
        }
        
        add(mesh)

        // ── Labels ──────────────────────────────────────────────────────────────
        for (let i = 0; i <= 4; i++) {
          const lon = minLon + (i / 4) * lonSpan
          const x = -W / 2 + (i / 4) * W
          makeLabel(`${lon.toFixed(1)}°`, new THREE.Vector3(x, -D / 2 - 0.18, H / 2), 0.2)
        }
        makeLabel('LONGITUDE →', new THREE.Vector3(0, -D / 2 - 0.42, H / 2 + 0.28), 0.2)

        for (let j = 0; j <= 4; j++) {
          const lat = minLat + (j / 4) * latSpan
          const z = -H / 2 + (j / 4) * H
          makeLabel(`${lat.toFixed(1)}°`, new THREE.Vector3(W / 2 + 0.25, -D / 2 - 0.12, z), 0.2, '#88ffaa')
        }
        makeLabel('LATITUDE →', new THREE.Vector3(W / 2 + 0.5, -D / 2 - 0.12, 0), 0.2, '#88ffaa')

        const nDL = Math.min(6, depthSize)
        for (let k = 0; k < nDL; k++) {
          const di = Math.round((k / Math.max(nDL - 1, 1)) * (depthSize - 1))
          const dm = header.depth_levels?.[di] ?? 0
          const y = D / 2 - (di / Math.max(depthSize - 1, 1)) * D
          makeLabel(`${dm.toFixed(0)}m`, new THREE.Vector3(-W / 2 - 0.32, y, H / 2), 0.2, '#ffcc66')
        }
        makeLabel('DEPTH ↓', new THREE.Vector3(-W / 2 - 0.42, 0, H / 2 + 0.2), 0.2, '#ffcc66')

        // Surface indicator
        const sMat = new THREE.LineBasicMaterial({ color: 0x00d4ff, transparent: true, opacity: 0.5 })
        disposables.push(sMat)
        const sGeo = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(-W / 2, D / 2, -H / 2), new THREE.Vector3(W / 2, D / 2, -H / 2),
          new THREE.Vector3(W / 2, D / 2, H / 2),   new THREE.Vector3(-W / 2, D / 2, H / 2),
          new THREE.Vector3(-W / 2, D / 2, -H / 2),
        ])
        add(new THREE.Line(sGeo, sMat)); disposables.push(sGeo)
        makeLabel('0m (Surface)', new THREE.Vector3(0, D / 2 + 0.18, H / 2), 0.2, '#00d4ff')

        camera.position.set(W * 1.8, D * 1.8, H * 2.4)
        controls.target.set(0, 0, 0)
        controls.update()

        setVolState({
          dataMin, dataMax,
          varName: header.long_name ?? activeVar,
          region: regionLabel ?? 'Selected Region',
        })
        setLoading(false)

      } catch (e: any) {
        if (e?.name === 'AbortError') return
        setError(`Failed to load volume: ${e?.message ?? 'unknown'}`)
        setLoading(false)
      }
    }

    loadData()

    function animate() {
      animId = requestAnimationFrame(animate)
      controls.update()
      renderer.render(scene, camera)
    }
    animate()

    function onResize() {
      if (!containerRef.current) return
      camera.aspect = containerRef.current.clientWidth / containerRef.current.clientHeight
      camera.updateProjectionMatrix()
      renderer.setSize(containerRef.current.clientWidth, containerRef.current.clientHeight)
    }
    window.addEventListener('resize', onResize)

    return () => {
      active = false
      abort.abort()
      cancelAnimationFrame(animId)
      window.removeEventListener('resize', onResize)
      disposables.forEach(d => d.dispose())
      renderer.dispose()
      if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement)
    }
  }, [bbox, activeSourceId, activeVar, activeTimeIdx])

  const gradient = 'linear-gradient(to top, #440154, #31688e, #35b779, #fde725)'

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', fontFamily: 'Inter, sans-serif' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />

      {/* Header */}
      <div style={{
        position: 'absolute', top: 20, left: 20,
        background: 'rgba(5,12,28,0.88)', border: '1px solid #1a3a66',
        borderRadius: 10, padding: '12px 18px', color: 'white', backdropFilter: 'blur(6px)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#00d4ff', boxShadow: '0 0 6px #00d4ff' }} />
          <span style={{ fontWeight: 700, fontSize: 14 }}>Volume Workspace</span>
        </div>
        <div style={{ fontSize: 12, color: '#88aacc' }}>
          {volState?.region ?? regionLabel ?? '—'} · {volState?.varName ?? activeVar}
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          background: 'radial-gradient(circle at center, #0a192f 0%, #020611 100%)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          color: '#88ccff', fontFamily: 'Inter, sans-serif', zIndex: 10
        }}>
          {/* Pulsing globe/satellite icon */}
          <div style={{ 
            fontSize: 48, marginBottom: 20,
            animation: 'pulse 2s infinite' 
          }}>🛰️</div>
          
          <style>{`
            @keyframes pulse {
              0% { transform: scale(0.95); opacity: 0.8; }
              50% { transform: scale(1.05); opacity: 1; text-shadow: 0 0 20px #00d4ff; }
              100% { transform: scale(0.95); opacity: 0.8; }
            }
            @keyframes scan {
              0% { left: -100%; }
              100% { left: 100%; }
            }
          `}</style>

          <div style={{ fontSize: 20, fontWeight: 600, color: '#ffffff', letterSpacing: 1, marginBottom: 8 }}>
            Establishing Secure Link to {activeSourceId.includes('hycom') ? 'Global HYCOM' : 'Copernicus Marine'}
          </div>
          
          <div style={{ fontSize: 14, color: '#6688aa', marginBottom: 30, maxWidth: 400, textAlign: 'center', lineHeight: 1.5 }}>
            Fetching live, high-resolution 3D volumetric data for {regionLabel || 'the selected region'}.
            <br/><br/>
            <span style={{ color: '#00d4ff' }}>Direct connection to {activeSourceId.includes('hycom') ? 'US HYCOM servers' : 'EU Space Agency'}...</span> Downloading telemetry...
          </div>

          <div style={{ width: 280, height: 4, background: '#1a3a66', borderRadius: 2, overflow: 'hidden', position: 'relative' }}>
            <div style={{
              position: 'absolute', top: 0, bottom: 0, width: '40%',
              background: 'linear-gradient(90deg, transparent, #00d4ff, transparent)',
              animation: 'scan 1.5s linear infinite'
            }} />
          </div>
          
          <div style={{ marginTop: 16, fontSize: 11, color: '#446688', textTransform: 'uppercase', letterSpacing: 2 }}>
            Estimated time: 30 - 60 seconds
          </div>
        </div>
      )}

      {error && (
        <div style={{
          position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
          background: 'rgba(60,0,0,0.85)', color: '#ff9999', padding: '20px 30px', borderRadius: 10,
          fontSize: 13, maxWidth: 420, textAlign: 'center', border: '1px solid #aa3333',
        }}>{error}</div>
      )}

      {/* Color Legend */}
      {volState && (
        <div style={{
          position: 'absolute', bottom: 40, left: 32,
          background: 'rgba(5,12,28,0.88)', border: '1px solid #1a3a66',
          borderRadius: 10, padding: '14px 16px', color: 'white', backdropFilter: 'blur(6px)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, color: '#88ccff', marginBottom: 2 }}>
            {activeVar.toUpperCase()}
          </div>
          <div style={{ fontSize: 12 }}>{volState.dataMax.toFixed(1)}</div>
          <div style={{ width: 18, height: 140, background: gradient, borderRadius: 4 }} />
          <div style={{ fontSize: 12 }}>{volState.dataMin.toFixed(1)}</div>
          <div style={{ fontSize: 10, color: '#667788', marginTop: 2 }}>
            {cfMetadata[activeVar]?.units ?? ''}
          </div>
        </div>
      )}

      {/* Back to Globe */}
      <button
        onClick={() => setRenderMode('slice')}
        style={{
          position: 'absolute', top: 20, right: 20,
          background: 'rgba(5,12,28,0.9)', color: '#00d4ff',
          border: '1px solid #1a5588', borderRadius: 8,
          padding: '10px 22px', cursor: 'pointer',
          fontWeight: 600, fontSize: 13, backdropFilter: 'blur(6px)',
        }}
        onMouseEnter={e => (e.currentTarget.style.background = '#0a2244')}
        onMouseLeave={e => (e.currentTarget.style.background = 'rgba(5,12,28,0.9)')}
      >
        ← Back to Globe
      </button>

      {!loading && volState && (
        <div style={{
          position: 'absolute', bottom: 20, right: 20,
          background: 'rgba(5,12,28,0.75)', border: '1px solid #1a3a66',
          borderRadius: 8, padding: '8px 14px', color: '#667788', fontSize: 11,
        }}>
          🖱 Drag to rotate · Scroll to zoom
        </div>
      )}
    </div>
  )
}

