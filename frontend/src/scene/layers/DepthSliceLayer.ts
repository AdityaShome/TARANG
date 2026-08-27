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
    // We do NOT rotate or scale the mesh physically. The vertex shader handles the spherical projection.
    // Three.js computes frustum-culling bounds from the UNDISPLACED geometry (a flat 1x1 plane
    // near the origin) — it has no idea the vertex shader pushes every vertex out onto a
    // radius-200 sphere. From the camera's actual orbit distance, that tiny origin-centered
    // bounding sphere reads as off-screen, so the mesh gets silently culled every frame despite
    // its shader-displaced geometry being squarely in view. Disable culling for it.
    this.mesh.frustumCulled = false
    // Hidden until update() below has real data. Without this, the mesh sits at its default
    // uniforms — u_bounds spans the WHOLE globe (-180..180, -90..90) and u_data is null, which
    // the fragment shader (colormapFrag.glsl) resolves to a solid, flat colormap(0) fill — i.e.
    // a giant, uniformly-colored plane wrapping the entire sphere, visible from any angle since
    // frustumCulled is off. That's what a researcher would see before ever searching a region.
    this.mesh.visible = false
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
          // NearestFilter, not Linear: sampling a FloatType texture with linear filtering
          // requires the OES_texture_float_linear WebGL extension, which isn't guaranteed on
          // every GPU/driver (notably software/virtualized ones). Where it's missing, the
          // texture silently becomes "incomplete" instead of throwing — no console error, just
          // a blown-out/white render. Nearest works on every WebGL2 implementation.
          this.texture.minFilter = THREE.NearestFilter
          this.texture.magFilter = THREE.NearestFilter
          this.texture.needsUpdate = true
          this.material.uniforms.u_data.value = this.texture
        } else {
          this.texture.image.data = data
          this.texture.needsUpdate = true
        }
        this.mesh.visible = true

        // Apply config from state/params
        const userClim = [state.colormap.min, state.colormap.max]
        this.material.uniforms.u_clim.value.set(userClim[0], userClim[1])
        this.material.uniforms.u_missing.value = header.missing_value
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
