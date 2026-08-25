import * as THREE from 'three'
import { Layer, LayerParams } from '../LayerManager'
import { fetchInstruments } from '../../api/client'

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
          this.mesh.dispose()
        }

        const count = instruments.length
        if (count === 0) return

        const geometry = new THREE.SphereGeometry(0.3, 16, 16)
        const material = new THREE.MeshPhongMaterial({ color: 0xffcc00 })
        this.mesh = new THREE.InstancedMesh(geometry, material, count)
        
        this.platformIds = []
        const dummy = new THREE.Object3D()
        
        this.centerLon = (params.bbox[0] + params.bbox[2]) / 2
        this.centerLat = (params.bbox[1] + params.bbox[3]) / 2

        instruments.forEach((inst, i) => {
          this.platformIds.push(inst.platform_id)
          // For now, place relative to the center of the bounding box
          dummy.position.set(inst.lon - this.centerLon, inst.lat - this.centerLat, 0.5)
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
      this.mesh.dispose()
    }
  }
}
