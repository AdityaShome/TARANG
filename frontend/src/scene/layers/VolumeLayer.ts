import * as THREE from 'three'
import { Layer, LayerParams } from '../LayerManager'
import { fetchVolume } from '../../api/client'
import { useTarangStore } from '../../state/store'

import vertShader from '../shaders/volumeVert.glsl?raw'
import fragShader from '../shaders/volumeFrag_v2.glsl?raw'

export class VolumeLayer implements Layer {
  private mesh: THREE.Mesh | null = null
  private texture: THREE.Data3DTexture | null = null
  private material: THREE.ShaderMaterial | null = null
  private scene: THREE.Scene | null = null
  private abortController: AbortController | null = null

  build(scene: THREE.Scene) {
    this.scene = scene
    const geometry = new THREE.BoxGeometry(1, 1, 1)
    
    this.material = new THREE.ShaderMaterial({
      vertexShader: vertShader,
      fragmentShader: fragShader,
      uniforms: {
        u_data: { value: null },
        u_clim: { value: new THREE.Vector2(0, 1) },
        u_opacity: { value: 1.0 },
        u_missing: { value: 99999.0 },
        u_renderstyle: { value: 0 }, // 0 = MIP
        u_iso_threshold: { value: 20.0 }
      },
      transparent: true,
      side: THREE.BackSide,
      glslVersion: THREE.GLSL3
    })

    this.mesh = new THREE.Mesh(geometry, this.material)
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
          this.texture = new THREE.Data3DTexture(data, lonSize, latSize, depthSize)
          this.texture.format = THREE.RedFormat
          this.texture.type = THREE.FloatType
          this.texture.minFilter = THREE.LinearFilter
          this.texture.magFilter = THREE.LinearFilter
          this.texture.unpackAlignment = 1
          this.texture.needsUpdate = true
          this.material.uniforms.u_data.value = this.texture
        } else {
          this.texture.image.data = data
          this.texture.needsUpdate = true
        }

        const state = useTarangStore.getState()
        const userClim = [state.colormap.min, state.colormap.max]
        this.material.uniforms.u_clim.value.set(userClim[0], userClim[1])
        this.material.uniforms.u_missing.value = header.missing_value

        const widthDeg = header.bounds.lon[1] - header.bounds.lon[0]
        const heightDeg = header.bounds.lat[1] - header.bounds.lat[0]
        
        const maxDepthM = Math.max(...header.depth_levels)
        const vExag = state.colormap.verticalExaggeration || 50
        const depthScale = (maxDepthM / 111000) * vExag 

        this.mesh.scale.set(widthDeg, heightDeg, depthScale)
        this.mesh.rotation.x = -Math.PI / 2
        this.mesh.position.y = -depthScale / 2

      } catch (err: any) {
        if (err.name !== 'AbortError') console.error(err)
      }
    }
  }

  dispose() {
    if (this.abortController) this.abortController.abort()
    if (this.mesh && this.scene) this.scene.remove(this.mesh)
    if (this.mesh?.geometry) this.mesh.geometry.dispose()
    if (this.material) this.material.dispose()
    if (this.texture) this.texture.dispose()
  }
}
