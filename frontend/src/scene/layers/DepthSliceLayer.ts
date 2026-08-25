import * as THREE from 'three'
import { Layer, LayerParams } from '../LayerManager'
import { fetchSlice } from '../../api/client'
import { useTarangStore } from '../../state/store'

import vertShader from '../shaders/depthSliceVert.glsl?raw'
import fragShader from '../shaders/colormapFrag.glsl?raw'

export class DepthSliceLayer implements Layer {
  private mesh: THREE.Mesh | null = null
  private texture: THREE.DataTexture | null = null
  private material: THREE.ShaderMaterial | null = null
  private scene: THREE.Scene | null = null
  private abortController: AbortController | null = null

  build(scene: THREE.Scene) {
    this.scene = scene
    const geometry = new THREE.PlaneGeometry(1, 1)
    
    this.material = new THREE.ShaderMaterial({
      vertexShader: vertShader,
      fragmentShader: fragShader,
      uniforms: {
        u_data: { value: null },
        u_clim: { value: new THREE.Vector2(0, 1) },
        u_opacity: { value: 1.0 },
        u_missing: { value: 99999.0 }
      },
      transparent: true,
      side: THREE.DoubleSide
    })

    this.mesh = new THREE.Mesh(geometry, this.material)
    this.mesh.rotation.x = -Math.PI / 2 // Lie flat on XZ plane
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
          this.texture.minFilter = THREE.LinearFilter
          this.texture.magFilter = THREE.LinearFilter
          this.texture.needsUpdate = true
          this.material.uniforms.u_data.value = this.texture
        } else {
          this.texture.image.data = data
          this.texture.needsUpdate = true
        }

        // Apply config from state/params
        const userClim = state.colormapConfig?.clim || [header.valid_min, header.valid_max]
        this.material.uniforms.u_clim.value.set(userClim[0], userClim[1])
        this.material.uniforms.u_missing.value = header.missing_value
        
        // Scale and position: assuming 1 scene unit = 1 degree
        const widthDeg = header.bounds.lon[1] - header.bounds.lon[0]
        const heightDeg = header.bounds.lat[1] - header.bounds.lat[0]
        this.mesh.scale.set(widthDeg, heightDeg, 1)
        
      } catch (err: any) {
        if (err.name === 'AbortError') {
          // Ignore aborts
        } else {
          console.error("DepthSliceLayer fetch error:", err)
        }
      }
    }
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
