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

        // COPY verts/normals before handing them to geometry — geometry.translate() below
        // mutates the position attribute's backing array in place, and `verts` is the exact
        // Float32Array returned by fetchIsosurface(). client.ts dedupes identical in-flight
        // requests, so when renderMode is 'isosurface' this layer AND VolumeIsoWorkspace get
        // the SAME array back; mutating it here corrupted the workspace's copy (its iso mesh
        // rendered at 2x scale, offset out of its box). slice() gives this layer its own buffer.
        geometry.setAttribute('position', new THREE.BufferAttribute(verts.slice(), 3))
        geometry.translate(0, -latSize / 2, -lonSize / 2)
        geometry.setAttribute('normal', new THREE.BufferAttribute(normals.slice(), 3))
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

        // Single source of truth for placement: the lat/lon extent the BACKEND loaded
        // (header.bounds), exactly as VolumeLayer does — NOT params.bbox. If the backend ever
        // snaps/clips the requested box (live sources, partial coverage), the two layers must
        // still agree on where the region is, or Volume and Iso render the same region at
        // different places. header.bounds is [min, max] for each axis.
        const [lonMin, lonMax] = header.bounds.lon
        const [latMin, latMax] = header.bounds.lat
        const widthDeg  = lonMax - lonMin
        const heightDeg = latMax - latMin

        const maxDepthM = Math.max(...header.depth_levels)
        const vExag = state.colormap.verticalExaggeration || 50
        const depthScale = (maxDepthM / 111000) * vExag

        // Scale voxel-index axes to world units (per-voxel size × voxel count = full extent).
        this.mesh.scale.set(
          (depthScale * DEG_TO_WORLD) / depthSize,
          (heightDeg * DEG_TO_WORLD) / latSize,
          (widthDeg * DEG_TO_WORLD) / lonSize,
        )

        const centerLat = (latMin + latMax) / 2
        const centerLon = (lonMin + lonMax) / 2
        const { east, north, outward } = surfaceBasis(centerLat, centerLon)
        // Iso verts are voxel indices in (depth, lat, lon) order → local X=depth, Y=lat, Z=lon.
        // We map them to the SAME world directions VolumeLayer maps its (lon, lat, depth) axes to:
        //   lat → north,  lon → east,  increasing depth (voxel index) → INWARD (−outward).
        // So the basis columns (localX, localY, localZ) = (−outward, north, east).
        //   - det(−outward, north, east) = +1  → a PROPER right-handed rotation. The previous
        //     (outward, north, east) had det = −1 (a reflection); THREE.Quaternion
        //     .setFromRotationMatrix() assumes a pure rotation and produced an unpredictable
        //     orientation for it — that is why Iso appeared rotated/mirrored relative to Volume.
        //   - depth → −outward means index 0 (surface) sits on the globe surface and the column
        //     sinks inward, matching VolumeLayer's box (which also extends inward from radius R).
        //     The old +outward made the isosurface float ABOVE the globe.
        // VolumeLayer writes makeBasis(east, north, outward) for its own (lon, lat, depth) local
        // axes — different argument order, identical geographic mapping. See sphereUtils.ts.
        const inward = outward.clone().negate()
        this.mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(inward, north, east))
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
