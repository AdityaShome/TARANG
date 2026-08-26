import * as THREE from 'three'
import { Layer, LayerParams } from '../LayerManager'
import { fetchInstruments } from '../../api/client'

// Must match SceneManager.tsx's EARTH_RADIUS / latLonToXYZ exactly — see the identical
// constants/fix in VolumeLayer.ts and IsosurfaceLayer.ts, which had this same bug: markers were
// placed at raw (lon-centerLon, lat-centerLat, 0.5) coordinates near the world origin instead of
// on the globe, so they rendered buried inside the opaque Earth sphere — invisible.
const EARTH_RADIUS = 200

function latLonToXYZ(lat: number, lon: number, r = EARTH_RADIUS): THREE.Vector3 {
  const phi = (90 - lat) * (Math.PI / 180)
  const theta = (lon + 180) * (Math.PI / 180)
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
     r * Math.cos(phi),
     r * Math.sin(phi) * Math.sin(theta),
  )
}

export class InstrumentMarkerLayer implements Layer {
  private mesh: THREE.InstancedMesh | null = null
  private scene: THREE.Scene | null = null
  private platformIds: string[] = []
  private abortController: AbortController | null = null
  private centerLon: number = 0
  private centerLat: number = 0

  build(scene: THREE.Scene) {
    this.scene = scene
  }

  async update(params: Partial<LayerParams>) {
    if (params.bbox) {
      if (this.abortController) this.abortController.abort()
      this.abortController = new AbortController()

      try {
        const { instruments } = await fetchInstruments({ bbox: params.bbox }, this.abortController.signal)
        
        if (this.mesh && this.scene) {
          this.scene.remove(this.mesh)
          this.mesh.geometry.dispose()
          ;(this.mesh.material as THREE.Material).dispose()
        }

        const count = instruments.length
        if (count === 0) return

        // Radius in world units, not degrees — visible at a glance against a 200-radius globe.
        const geometry = new THREE.SphereGeometry(1.6, 16, 16)
        const material = new THREE.MeshPhongMaterial({ color: 0xffcc00 })
        this.mesh = new THREE.InstancedMesh(geometry, material, count)
        this.mesh.frustumCulled = false // see the identical note in the other layers

        this.platformIds = []
        const dummy = new THREE.Object3D()

        this.centerLon = (params.bbox[0] + params.bbox[2]) / 2
        this.centerLat = (params.bbox[1] + params.bbox[3]) / 2

        instruments.forEach((inst, i) => {
          this.platformIds.push(inst.platform_id)
          // Sit slightly above the surface (matches DepthSliceLayer's 1.0025x / boundary box's
          // 1.006x radii) so markers aren't z-fighting with the globe or hidden under the slice.
          dummy.position.copy(latLonToXYZ(inst.lat, inst.lon, EARTH_RADIUS * 1.01))
          dummy.updateMatrix()
          this.mesh!.setMatrixAt(i, dummy.matrix)
        })

        this.mesh.instanceMatrix.needsUpdate = true
        this.scene!.add(this.mesh)
        
      } catch (e: any) {
        if (e.name !== 'AbortError') console.error(e)
      }
    }
  }

  // Basic hit test API for SceneManager to call on click
  getPlatformIdAt(instanceId: number): string | null {
    return this.platformIds[instanceId] || null
  }
  
  getMesh() {
    return this.mesh
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
