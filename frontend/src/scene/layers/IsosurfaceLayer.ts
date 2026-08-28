import * as THREE from 'three'
import { Layer, LayerParams } from '../LayerManager'
import { fetchIsosurface } from '../../api/client'
import { useTarangStore } from '../../state/store'
import { EARTH_RADIUS, surfaceBasis } from './sphereUtils'

const DEG_TO_WORLD = (Math.PI * EARTH_RADIUS) / 180

export class IsosurfaceLayer implements Layer {
  private mesh: THREE.Mesh | null = null
  private scene: THREE.Scene | null = null
  private abortController: AbortController | null = null
  private wantVisible = true

  build(scene: THREE.Scene) {
    this.scene = scene
  }

  async update(params: Partial<LayerParams>) {
    const state = useTarangStore.getState()
    const threshold = state.isoThreshold
    
    if (params.source && params.variable && params.bbox && params.timeIdx !== undefined) {
      if (this.abortController) this.abortController.abort()
      this.abortController = new AbortController()

      try {
        const { header, verts, normals, faces } = await fetchIsosurface({
          source: params.source,
          var: params.variable,
          time: params.timeIdx,
          bbox: params.bbox,
          threshold: threshold
        }, this.abortController.signal)
        
        if (this.mesh && this.scene) {
          this.scene.remove(this.mesh)
          this.mesh.geometry.dispose()
          ;(this.mesh.material as THREE.Material).dispose()
        }

        const geometry = new THREE.BufferGeometry()

        // marching_cubes verts are voxel indices into a (depth, lat, lon) grid.
        const [depthSize, latSize, lonSize] = header.volume_shape

        // Centre lat/lon; leave depth un-centred (index 0 = surface = local origin).
        geometry.setAttribute('position', new THREE.BufferAttribute(verts, 3))
        geometry.translate(0, -latSize / 2, -lonSize / 2)
        geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
        geometry.setIndex(new THREE.BufferAttribute(faces, 1))

        const material = new THREE.MeshPhongMaterial({
          color: 0x00d4ff, // Cyan for isosurface
          side: THREE.DoubleSide,
          transparent: true,
          opacity: params.opacity ?? 0.8,
          shininess: 60
        })

        this.mesh = new THREE.Mesh(geometry, material)
        this.mesh.frustumCulled = false
        this.mesh.visible = this.wantVisible   // a render-mode switch may have landed mid-fetch

        const [minLon, minLat, maxLon, maxLat] = params.bbox!
        const widthDeg = maxLon - minLon
        const heightDeg = maxLat - minLat

        const maxDepthM = Math.max(...header.depth_levels)
        const vExag = state.colormap.verticalExaggeration || 50
        const depthScale = (maxDepthM / 111000) * vExag

        // Scale voxel-index axes to world units; align local +X (depth) with the outward normal.
        this.mesh.scale.set(
          (depthScale * DEG_TO_WORLD) / depthSize,
          (heightDeg * DEG_TO_WORLD) / latSize,
          (widthDeg * DEG_TO_WORLD) / lonSize,
        )

        const centerLat = (minLat + maxLat) / 2
        const centerLon = (minLon + maxLon) / 2
        const { east, north, outward } = surfaceBasis(centerLat, centerLon)
        // Local X=depth, Y=lat(height), Z=lon(width) — same shared basis VolumeLayer uses, just
        // with depth mapped to local X instead of Z (forced by marching_cubes' voxel index
        // order). See sphereUtils.ts for why this must be a full three-axis basis.
        this.mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(outward, north, east))
        this.mesh.position.copy(outward).multiplyScalar(EARTH_RADIUS)

        this.scene!.add(this.mesh)
        
      } catch (err: any) {
        if (err.name !== 'AbortError') console.error(err)
      }
    }
  }

  setVisible(visible: boolean) {
    this.wantVisible = visible
    if (this.mesh) this.mesh.visible = visible
  }

  dispose() {
    if (this.abortController) this.abortController.abort()
    if (this.mesh && this.scene) {
      this.scene.remove(this.mesh)
      this.mesh.geometry.dispose()
      ;(this.mesh.material as THREE.Material).dispose()
    }
  }
}
