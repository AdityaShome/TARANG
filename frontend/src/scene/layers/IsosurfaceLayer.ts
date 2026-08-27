import * as THREE from 'three'
import { Layer, LayerParams } from '../LayerManager'
import { fetchIsosurface } from '../../api/client'
import { useTarangStore } from '../../state/store'

// Must match SceneManager.tsx's EARTH_RADIUS / latLonToXYZ exactly — see the identical
// constants in VolumeLayer.ts, which had (and was fixed for) this exact same bug: a mesh
// positioned at the world origin instead of on the searched region's patch of the globe.
const EARTH_RADIUS = 200
const DEG_TO_WORLD = (Math.PI * EARTH_RADIUS) / 180

function latLonToXYZ(lat: number, lon: number, r = EARTH_RADIUS): THREE.Vector3 {
  const phi = (90 - lat) * (Math.PI / 180)
  const theta = (lon + 180) * (Math.PI / 180)
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
     r * Math.cos(phi),
     r * Math.sin(phi) * Math.sin(theta),
  )
}

export class IsosurfaceLayer implements Layer {
  private mesh: THREE.Mesh | null = null
  private scene: THREE.Scene | null = null
  private abortController: AbortController | null = null

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

        // marching_cubes verts are indexed into the (depth, lat, lon) voxel array it ran on —
        // x=depth index, y=lat index, z=lon index, each 0..(axis size - 1). volume_shape (added
        // to the backend header specifically for this) gives those actual axis sizes; without it
        // there's nothing to scale/position verts by (this used to reference undefined variables
        // and crash on every isosurface request — see git history).
        const [depthSize, latSize, lonSize] = header.volume_shape

        // Centre the lat/lon axes on the geometry's own origin (they start at index 0, i.e. one
        // corner, not centred) so the patch ends up centred under the region rather than offset
        // to one side. Depth is deliberately left un-centred: index 0 = shallowest = the globe
        // surface, and we want that at the mesh's local origin so positioning below is simple.
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
        this.mesh.frustumCulled = false // see the identical note in VolumeLayer.ts/DepthSliceLayer.ts

        const [minLon, minLat, maxLon, maxLat] = params.bbox!
        const widthDeg = maxLon - minLon
        const heightDeg = maxLat - minLat

        const maxDepthM = Math.max(...header.depth_levels)
        const vExag = state.colormap.verticalExaggeration || 50
        const depthScale = (maxDepthM / 111000) * vExag

        // Same spherical placement as VolumeLayer.ts: scale each voxel-index axis into real
        // world units, then align the mesh's local +X (the depth axis) with the outward normal
        // at the region's centre so it sits tangent to the globe surface with depth going inward.
        this.mesh.scale.set(
          (depthScale * DEG_TO_WORLD) / depthSize,
          (heightDeg * DEG_TO_WORLD) / latSize,
          (widthDeg * DEG_TO_WORLD) / lonSize,
        )

        const centerLat = (minLat + maxLat) / 2
        const centerLon = (minLon + maxLon) / 2
        const outward = latLonToXYZ(centerLat, centerLon, 1)
        this.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), outward)
        this.mesh.position.copy(outward).multiplyScalar(EARTH_RADIUS)
        const [depthSize, latSize, lonSize] = header.volume_shape

        this.scene!.add(this.mesh)
        
      } catch (err: any) {
        if (err.name !== 'AbortError') console.error(err)
      }
    }
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
