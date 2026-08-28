import * as THREE from 'three'
import { Layer, LayerParams } from '../LayerManager'
import { fetchEddyDetection } from '../../api/eddy'

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

const TYPE_COLORS: Record<string, number> = {
  warm:  0xff8c00, // orange
  cold:  0x00e5ff, // teal
  front: 0xffd700, // yellow
}

export class EddyOverlayLayer implements Layer {
  private meshes: THREE.InstancedMesh[] = []
  private scene: THREE.Scene | null = null
  private abortController: AbortController | null = null

  build(scene: THREE.Scene) {
    this.scene = scene
  }

  private clearMeshes() {
    if (!this.scene) return
    for (const mesh of this.meshes) {
      this.scene.remove(mesh)
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
    this.meshes = []
  }

  async update(params: Partial<LayerParams>) {
    // Requires source, bbox, timeIdx
    if (params.bbox && params.source && params.timeIdx !== undefined) {
      if (this.abortController) this.abortController.abort()
      this.abortController = new AbortController()

      try {
        const cells = await fetchEddyDetection({
          source: params.source,
          time: params.timeIdx,
          bbox: params.bbox,
        }, this.abortController.signal)

        this.clearMeshes()
        if (cells.length === 0) return

        const byType = new Map<string, typeof cells>()
        for (const cell of cells) {
          const list = byType.get(cell.type) ?? []
          list.push(cell)
          byType.set(cell.type, list)
        }

        const dummy = new THREE.Object3D()

        for (const [type, group] of byType) {
          const geometry = new THREE.CircleGeometry(0.5, 16)
          const material = new THREE.MeshBasicMaterial({ 
            color: TYPE_COLORS[type] ?? 0xffffff,
            transparent: true,
            opacity: 0.7,
            side: THREE.DoubleSide
          })
          const mesh = new THREE.InstancedMesh(geometry, material, group.length)
          mesh.frustumCulled = false

          group.forEach((cell, i) => {
            const pos = latLonToXYZ(cell.lat, cell.lon, EARTH_RADIUS * 1.008)
            dummy.position.copy(pos)
            // Look away from center so Z is normal to the surface
            dummy.lookAt(pos.clone().multiplyScalar(2)) 
            dummy.updateMatrix()
            mesh.setMatrixAt(i, dummy.matrix)
          })

          mesh.instanceMatrix.needsUpdate = true
          this.meshes.push(mesh)
          this.scene!.add(mesh)
        }
      } catch (e: any) {
        if (e.name !== 'AbortError') console.error(e)
      }
    }
  }

  setVisible(visible: boolean) {
    for (const mesh of this.meshes) mesh.visible = visible
  }

  dispose() {
    if (this.abortController) this.abortController.abort()
    this.clearMeshes()
  }
}
