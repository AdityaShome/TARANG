import * as THREE from 'three'
import { Layer, LayerParams } from '../LayerManager'
import { fetchDeltaOverlay } from '../../api/delta'

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

export class DeltaOverlayLayer implements Layer {
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
    if (params.bbox && params.source && params.timeIdx !== undefined) {
      if (this.abortController) this.abortController.abort()
      this.abortController = new AbortController()

      try {
        const cells = await fetchDeltaOverlay({
          source: params.source,
          timeIdx: params.timeIdx,
          bbox: params.bbox,
        }, this.abortController.signal)

        this.clearMeshes()
        if (cells.length === 0) return

        const dummy = new THREE.Object3D()

        // We will map delta values to a color gradient:
        // Blue (negative delta -> model colder than obs) to Red (positive delta -> model hotter than obs)
        const geometry = new THREE.SphereGeometry(0.3, 16, 16)
        const material = new THREE.MeshBasicMaterial({ 
          color: 0xffffff,
          transparent: true,
          opacity: 0.9,
        })
        const mesh = new THREE.InstancedMesh(geometry, material, cells.length)
        mesh.frustumCulled = false

        const color = new THREE.Color()

        cells.forEach((cell, i) => {
          const pos = latLonToXYZ(cell.lat, cell.lon, EARTH_RADIUS * 1.01)
          dummy.position.copy(pos)
          dummy.updateMatrix()
          mesh.setMatrixAt(i, dummy.matrix)

          // Clamp delta between -2 and 2 for color mapping
          const val = Math.max(-2, Math.min(2, cell.delta))
          // map -2 to 2 into 0 to 1
          const t = (val + 2) / 4
          
          // Interpolate from Blue to White to Red
          if (t < 0.5) {
            color.setRGB(2 * t, 2 * t, 1) // Blue to White
          } else {
            color.setRGB(1, 2 * (1 - t), 2 * (1 - t)) // White to Red
          }

          mesh.setColorAt(i, color)
        })

        mesh.instanceMatrix.needsUpdate = true
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
        
        if (this.scene) {
          this.scene.add(mesh)
          this.meshes.push(mesh)
        }
      } catch (e: unknown) {
        if ((e as Error).name !== 'AbortError') console.error('DeltaOverlayLayer failed:', e)
      }
    }
  }

  setVisible(visible: boolean) {
    for (const mesh of this.meshes) {
      mesh.visible = visible
    }
  }

  dispose() {
    if (this.abortController) this.abortController.abort()
    this.clearMeshes()
  }
}
