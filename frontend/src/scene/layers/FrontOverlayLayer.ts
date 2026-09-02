import * as THREE from 'three'
import { Layer, LayerParams } from '../LayerManager'
import { fetchFrontDetection } from '../../api/eddy'

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

export class FrontOverlayLayer implements Layer {
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
    if (params.bbox && params.source && params.variable && params.timeIdx !== undefined) {
      if (this.abortController) this.abortController.abort()
      this.abortController = new AbortController()

      try {
        const cells = await fetchFrontDetection({
          source: params.source,
          var: params.variable,
          time: params.timeIdx,
          bbox: params.bbox,
        }, this.abortController.signal)

        this.clearMeshes()
        if (cells.length === 0) return

        // Thin dense front fields so the globe doesn't turn into a magenta smear.
        const stride = Math.max(1, Math.ceil(cells.length / 500))
        const shown = cells.filter((_, i) => i % stride === 0)

        const dummy = new THREE.Object3D()

        const geometry = new THREE.CircleGeometry(0.28, 6)
        const material = new THREE.MeshBasicMaterial({
          color: 0xff00ff, // magenta for fronts
          transparent: true,
          opacity: 0.8,
          side: THREE.DoubleSide
        })
        const mesh = new THREE.InstancedMesh(geometry, material, shown.length)
        mesh.frustumCulled = false

        shown.forEach((cell, i) => {
          const pos = latLonToXYZ(cell.lat, cell.lon, EARTH_RADIUS * 1.009)
          dummy.position.copy(pos)
          dummy.lookAt(pos.clone().multiplyScalar(2))
          dummy.updateMatrix()
          mesh.setMatrixAt(i, dummy.matrix)
        })

        mesh.instanceMatrix.needsUpdate = true
        this.meshes.push(mesh)
        this.scene!.add(mesh)
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
