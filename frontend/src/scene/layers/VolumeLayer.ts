import * as THREE from 'three'
import { Layer, LayerParams } from '../LayerManager'
import { fetchVolume } from '../../api/client'
import { useTarangStore } from '../../state/store'

import vertShader from '../shaders/volumeVert.glsl?raw'
import fragShader from '../shaders/volumeFrag_v2.glsl?raw'
import type { ColormapName } from '../../api/types'
import { EARTH_RADIUS, surfaceBasis } from './sphereUtils'
import { computeDataRange } from './dataStats'

// Must match the u_colormap branches in the shaders.
const COLORMAP_INDEX: Record<ColormapName, number> = {
  viridis: 0, plasma: 1, magma: 2, inferno: 3, jet: 4,
}

const DEG_TO_WORLD = (Math.PI * EARTH_RADIUS) / 180 // world units per degree of lat/lon

// ?voldebug=1..4 → raymarch diagnostic overlay (see volumeFrag_v2.glsl).
function readDebugFlag(): number {
  try {
    const n = parseInt(new URLSearchParams(window.location.search).get('voldebug') || '0', 10)
    return Number.isFinite(n) ? n : 0
  } catch { return 0 }
}

export class VolumeLayer implements Layer {
  private mesh: THREE.Mesh | null = null
  private texture: THREE.Data3DTexture | null = null
  private material: THREE.ShaderMaterial | null = null
  private scene: THREE.Scene | null = null
  private abortController: AbortController | null = null
  private wantVisible = true
  private hasData = false

  build(scene: THREE.Scene) {
    this.scene = scene
    const geometry = new THREE.BoxGeometry(1, 1, 1)
    
    this.material = new THREE.ShaderMaterial({
      vertexShader: vertShader,
      fragmentShader: fragShader,
      uniforms: {
        u_data: { value: null },
        u_modelInv: { value: new THREE.Matrix4() },   // world → local box space
        u_regionNormal: { value: new THREE.Vector3(0, 0, 1) },
        u_clim: { value: new THREE.Vector2(0, 1) },
        u_opacity: { value: 1.0 },
        u_missing: { value: 99999.0 },
        u_renderstyle: { value: 0 }, // MIP (iso is a separate layer)
        u_iso_threshold: { value: 20.0 },
        u_colormap: { value: 0 },
        u_log_scale: { value: 0 },
        u_debug: { value: readDebugFlag() },
      },
      transparent: true,
      side: THREE.BackSide,
      depthWrite: false,
      // Box sits inside the opaque globe; depth testing would hide all but the surface sliver.
      depthTest: false,
      glslVersion: THREE.GLSL3
    })

    this.mesh = new THREE.Mesh(geometry, this.material)
    this.mesh.renderOrder = 3          // draw after the globe + markers (depthTest is off)
    this.mesh.frustumCulled = false    // shader displaces verts onto the globe; bounds are wrong
    this.mesh.visible = false          // until update() has real data
    scene.add(this.mesh)
  }

  async update(params: Partial<LayerParams>) {
    if (!this.mesh || !this.material) return

    if (params.opacity !== undefined) {
      this.material.uniforms.u_opacity.value = params.opacity
    }

    if (params.source && params.variable && params.bbox && params.timeIdx !== undefined) {
      if (this.abortController) this.abortController.abort()
      this.abortController = new AbortController()

      try {
        const { header, data } = await fetchVolume({
          source: params.source,
          var: params.variable,
          time: params.timeIdx,
          bbox: params.bbox
        }, this.abortController.signal)

        const [depthSize, latSize, lonSize] = header.shape

        if (
          !this.texture || 
          this.texture.image.width !== lonSize || 
          this.texture.image.height !== latSize || 
          this.texture.image.depth !== depthSize
        ) {
          if (this.texture) this.texture.dispose()
          this.texture = new THREE.Data3DTexture(data as unknown as Float32Array<ArrayBuffer>, lonSize, latSize, depthSize)
          this.texture.format = THREE.RedFormat
          this.texture.type = THREE.FloatType
          // NearestFilter: linear on a float texture needs OES_texture_float_linear.
          this.texture.minFilter = THREE.NearestFilter
          this.texture.magFilter = THREE.NearestFilter
          this.texture.unpackAlignment = 1
          this.texture.needsUpdate = true
          this.material.uniforms.u_data.value = this.texture
        } else {
          this.texture.image.data = data as any
          this.texture.needsUpdate = true
        }
        this.hasData = true
        this.mesh.visible = this.wantVisible

        const state = useTarangStore.getState()
        // Auto-contrast-stretch to the actual fetched data's range — see dataStats.ts /
        // DepthSliceLayer.ts for why (global valid_min/valid_max makes a small region's real
        // variance compress to a near-invisible sliver of the colormap).
        const [dataMin, dataMax] = computeDataRange(data, header.missing_value, header.valid_min, header.valid_max)
        this.material.uniforms.u_clim.value.set(dataMin, dataMax)
        useTarangStore.getState().setColormap({ min: dataMin, max: dataMax })
        this.material.uniforms.u_missing.value = header.missing_value ?? -9999.0
        this.material.uniforms.u_colormap.value = COLORMAP_INDEX[state.colormap.name] ?? 0
        this.material.uniforms.u_log_scale.value = state.colormap.logScale ? 1 : 0

        const widthDeg = header.bounds.lon[1] - header.bounds.lon[0]
        const heightDeg = header.bounds.lat[1] - header.bounds.lat[0]

        const maxDepthM = Math.max(...header.depth_levels)
        const vExag = state.colormap.verticalExaggeration || 50
        const depthScale = (maxDepthM / 111000) * vExag  // ~m-per-degree → world units

        // Scale degree-sized extents into world units; place tangent to the globe, extending inward.
        this.mesh.scale.set(widthDeg * DEG_TO_WORLD, heightDeg * DEG_TO_WORLD, depthScale * DEG_TO_WORLD)
        const centerLat = (header.bounds.lat[0] + header.bounds.lat[1]) / 2
        const centerLon = (header.bounds.lon[0] + header.bounds.lon[1]) / 2
        const { east, north, outward } = surfaceBasis(centerLat, centerLon)
        const surfacePoint = outward.clone().multiplyScalar(EARTH_RADIUS)

        this.material.uniforms.u_regionNormal.value.copy(outward)  // limb fade (shader)
        // Local X=lon(width), Y=lat(height), Z=depth — see sphereUtils.ts for why this must be
        // a full three-axis basis (shared with IsosurfaceLayer), not a single-axis alignment.
        this.mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(east, north, outward))
        this.mesh.position.copy(surfacePoint)
          .addScaledVector(outward, -(depthScale * DEG_TO_WORLD) / 2)

        // CPU inverse-world-matrix for the raymarch (GLSL inverse() is imprecise here).
        this.mesh.updateMatrixWorld(true)
        this.material.uniforms.u_modelInv.value.copy(this.mesh.matrixWorld).invert()

      } catch (err: any) {
        if (err.name !== 'AbortError') console.error(err)
      }
    }
  }

  setVisible(visible: boolean) {
    this.wantVisible = visible
    if (this.mesh) this.mesh.visible = visible && this.hasData
  }

  dispose() {
    if (this.abortController) this.abortController.abort()
    if (this.mesh && this.scene) this.scene.remove(this.mesh)
    if (this.mesh?.geometry) this.mesh.geometry.dispose()
    if (this.material) this.material.dispose()
    if (this.texture) this.texture.dispose()
  }
}
