import * as THREE from 'three'
import { Layer, LayerParams } from '../LayerManager'
import { fetchVolume } from '../../api/client'
import { useTarangStore } from '../../state/store'

import vertShader from '../shaders/volumeVert.glsl?raw'
import fragShader from '../shaders/volumeFrag_v2.glsl?raw'
import type { ColormapName } from '../../api/types'

// Must match the u_colormap branches in colormapFrag.glsl / volumeFrag_v2.glsl exactly.
const COLORMAP_INDEX: Record<ColormapName, number> = {
  viridis: 0, plasma: 1, magma: 2, inferno: 3, jet: 4,
}

// Must match SceneManager.tsx's EARTH_RADIUS / latLonToXYZ exactly — this layer places its
// box mesh in the SAME spherical globe scene those build, not a standalone coordinate space.
const EARTH_RADIUS = 200
const DEG_TO_WORLD = (Math.PI * EARTH_RADIUS) / 180 // arc length (world units) per degree of lat/lon

function latLonToXYZ(lat: number, lon: number, r = EARTH_RADIUS): THREE.Vector3 {
  const phi = (90 - lat) * (Math.PI / 180)
  const theta = (lon + 180) * (Math.PI / 180)
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
     r * Math.cos(phi),
     r * Math.sin(phi) * Math.sin(theta),
  )
}

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
        u_iso_threshold: { value: 20.0 },
        u_colormap: { value: 0 },
        u_log_scale: { value: 0 },
      },
      transparent: true,
      side: THREE.BackSide,
      glslVersion: THREE.GLSL3
    })

    this.mesh = new THREE.Mesh(geometry, this.material)
    // Placed far from the origin (on the EARTH_RADIUS=200 globe's surface) in update() below —
    // disable frustum culling so Three.js doesn't cull it based on the tiny 1x1x1 pre-transform
    // bounding sphere (see the identical comment in DepthSliceLayer.ts for the full mechanism).
    this.mesh.frustumCulled = false
    // Hidden until update() below positions it with real bounds and data — see the identical
    // comment in DepthSliceLayer.ts. Before that, it sits at the origin at unit scale, which
    // happens to be buried inside the opaque Earth sphere either way, but this also fixes a
    // separate real bug: the "Volume" layer checkbox only gates whether update() gets called,
    // not this mesh's own visibility, so without this it could still render once a region IS
    // searched even with that checkbox off.
    this.mesh.visible = false
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
          // NearestFilter, not Linear — see DepthSliceLayer.ts for why: linear filtering on a
          // FloatType texture needs OES_texture_float_linear, which isn't guaranteed on every
          // GPU. Missing it doesn't throw, it just silently breaks the render (blown-out/white).
          this.texture.minFilter = THREE.NearestFilter
          this.texture.magFilter = THREE.NearestFilter
          this.texture.unpackAlignment = 1
          this.texture.needsUpdate = true
          this.material.uniforms.u_data.value = this.texture
        } else {
          this.texture.image.data = data
          this.texture.needsUpdate = true
        }
        this.mesh.visible = true

        const state = useTarangStore.getState()
        const userClim = [state.colormap.min, state.colormap.max]
        this.material.uniforms.u_clim.value.set(userClim[0], userClim[1])
        this.material.uniforms.u_missing.value = header.missing_value
        this.material.uniforms.u_colormap.value = COLORMAP_INDEX[state.colormap.name] ?? 0
        this.material.uniforms.u_log_scale.value = state.colormap.logScale ? 1 : 0

        const widthDeg = header.bounds.lon[1] - header.bounds.lon[0]
        const heightDeg = header.bounds.lat[1] - header.bounds.lat[0]

        const maxDepthM = Math.max(...header.depth_levels)
        const vExag = state.colormap.verticalExaggeration || 50
        // Same depth-to-world-units calibration the original code used (111000 m/deg of
        // latitude as a rough deg-to-metres constant); depthScale is in the same "one world
        // unit per degree-equivalent" space as DEG_TO_WORLD converts lon/lat degrees into.
        const depthScale = (maxDepthM / 111000) * vExag

        // Box is built in DEGREES of lon/lat width/height and a depth "thickness" in that same
        // unit — but the scene's globe is EARTH_RADIUS=200 world units in *radius*, not degrees.
        // Scale each axis into real world units before sizing the box, or it renders as a speck.
        this.mesh.scale.set(widthDeg * DEG_TO_WORLD, heightDeg * DEG_TO_WORLD, depthScale * DEG_TO_WORLD)

        // Place the box tangent to the globe surface at the region's centre lat/lon, with its
        // outward face (surface, depth=0) sitting ON the sphere and the rest extending inward
        // (toward the sphere's centre) to represent depth — instead of the old flat rotation.x
        // that left it sitting at the world origin, i.e. inside the opaque Earth sphere.
        const centerLat = (header.bounds.lat[0] + header.bounds.lat[1]) / 2
        const centerLon = (header.bounds.lon[0] + header.bounds.lon[1]) / 2
        const outward = latLonToXYZ(centerLat, centerLon, 1) // unit outward normal at region centre
        const surfacePoint = outward.clone().multiplyScalar(EARTH_RADIUS)

        this.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), outward)
        this.mesh.position.copy(surfacePoint)
          .addScaledVector(outward, -(depthScale * DEG_TO_WORLD) / 2)

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
