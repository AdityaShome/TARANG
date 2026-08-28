import * as THREE from 'three'
import { Layer, LayerParams } from '../LayerManager'
import { fetchSlice } from '../../api/client'
import { useTarangStore } from '../../state/store'

import vertShader from '../shaders/depthSliceVert.glsl?raw'
import fragShader from '../shaders/colormapFrag.glsl?raw'
import type { ColormapName } from '../../api/types'

// Must match the u_colormap branches in colormapFrag.glsl exactly.
const COLORMAP_INDEX: Record<ColormapName, number> = {
  viridis: 0, plasma: 1, magma: 2, inferno: 3, jet: 4,
}

export class DepthSliceLayer implements Layer {
  private mesh: THREE.Mesh | null = null
  private texture: THREE.DataTexture | null = null
  private material: THREE.ShaderMaterial | null = null
  private scene: THREE.Scene | null = null
  private abortController: AbortController | null = null
  private wantVisible = true   // setVisible() intent; ANDed with hasData
  private hasData = false

  build(scene: THREE.Scene) {
    this.scene = scene
    // High-segment plane so it can bend smoothly onto the sphere
    const geometry = new THREE.PlaneGeometry(1, 1, 128, 128)
    
    this.material = new THREE.ShaderMaterial({
      vertexShader: vertShader,
      fragmentShader: fragShader,
      uniforms: {
        u_data: { value: null },
        u_clim: { value: new THREE.Vector2(0, 1) },
        u_opacity: { value: 1.0 },
        u_missing: { value: 99999.0 },
        u_bounds: { value: new THREE.Vector4(-180, 180, -90, 90) },
        u_colormap: { value: 0 },
        u_log_scale: { value: 0 },
      },
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false
    })

    this.mesh = new THREE.Mesh(geometry, this.material)
    this.mesh.frustumCulled = false   // vertex shader displaces onto the sphere; bounds are wrong
    this.mesh.visible = false          // until update() has real data
    scene.add(this.mesh)
  }

  async update(params: Partial<LayerParams>) {
    if (!this.mesh || !this.material) return

    if (params.opacity !== undefined) {
      this.material.uniforms.u_opacity.value = params.opacity
    }

    if (
      params.source && 
      params.variable && 
      params.bbox && 
      params.timeIdx !== undefined && 
      params.depthIdx !== undefined
    ) {
      // Cancel previous fetch if still in flight
      if (this.abortController) {
        this.abortController.abort()
      }
      this.abortController = new AbortController()

      try {
        const state = useTarangStore.getState()
        const depth_m = state.depthLevels[params.depthIdx] || 0
        
        const { header, data } = await fetchSlice({
          source: params.source,
          var: params.variable,
          depth: depth_m,
          time: params.timeIdx,
          bbox: params.bbox
        }, this.abortController.signal)

        const [latSize, lonSize] = header.shape 
        
        if (!this.texture || this.texture.image.width !== lonSize || this.texture.image.height !== latSize) {
          if (this.texture) this.texture.dispose()
          this.texture = new THREE.DataTexture(data, lonSize, latSize, THREE.RedFormat, THREE.FloatType)
          // NearestFilter: linear on a float texture needs OES_texture_float_linear.
          this.texture.minFilter = THREE.NearestFilter
          this.texture.magFilter = THREE.NearestFilter
          this.texture.needsUpdate = true
          this.material.uniforms.u_data.value = this.texture
        } else {
          this.texture.image.data = data
          this.texture.needsUpdate = true
        }
        this.hasData = true
        this.mesh.visible = this.wantVisible

        // Apply config from state/params
        const userClim = [state.colormap.min, state.colormap.max]
        this.material.uniforms.u_clim.value.set(userClim[0], userClim[1])
        this.material.uniforms.u_missing.value = header.missing_value ?? -9999.0
        this.material.uniforms.u_colormap.value = COLORMAP_INDEX[state.colormap.name] ?? 0
        this.material.uniforms.u_log_scale.value = state.colormap.logScale ? 1 : 0
        
        // Scale and position: assuming 1 scene unit = 1 degree
        const lonMin = header.bounds.lon[0]
        const lonMax = header.bounds.lon[1]
        const latMin = header.bounds.lat[0]
        const latMax = header.bounds.lat[1]
        
        // Pass bounds to vertex shader to warp onto sphere
        this.material.uniforms.u_bounds.value.set(lonMin, lonMax, latMin, latMax)
        
        // Ensure mesh is at origin with scale 1, since shader handles everything
        this.mesh.position.set(0, 0, 0)
        this.mesh.rotation.set(0, 0, 0)
        this.mesh.scale.set(1, 1, 1)
        
      } catch (err: any) {
        if (err.name === 'AbortError') {
          // Ignore aborts
        } else {
          console.error("DepthSliceLayer fetch error:", err)
        }
      }
    }
  }

  setVisible(visible: boolean) {
    this.wantVisible = visible
    if (this.mesh) this.mesh.visible = visible && this.hasData
  }

  dispose() {
    if (this.abortController) this.abortController.abort()
    if (this.mesh && this.scene) {
      this.scene.remove(this.mesh)
    }
    if (this.mesh?.geometry) this.mesh.geometry.dispose()
    if (this.material) this.material.dispose()
    if (this.texture) this.texture.dispose()
  }
}
