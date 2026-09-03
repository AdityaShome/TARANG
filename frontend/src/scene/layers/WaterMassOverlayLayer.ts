import * as THREE from 'three'
import { Layer, LayerParams } from '../LayerManager'
import { fetchWaterMasses, WATER_MASS_COLORS } from '../../api/derived'
import { useTarangStore } from '../../state/store'

const EARTH_RADIUS = 200

function latLonToXYZ(lat: number, lon: number, r: number): THREE.Vector3 {
  const phi = (90 - lat) * (Math.PI / 180)
  const theta = (lon + 180) * (Math.PI / 180)
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
     r * Math.cos(phi),
     r * Math.sin(phi) * Math.sin(theta),
  )
}

/**
 * WaterMassOverlayLayer — globe version of the 2D-map water-mass overlay.
 * Renders the k-means class grid from /api/derived/water_masses as a cloud of
 * small colour-coded points hugging the sphere. Mirrors DeltaOverlayLayer.
 */
export class WaterMassOverlayLayer implements Layer {
  private mesh: THREE.InstancedMesh | null = null
  private scene: THREE.Scene | null = null
  private abort: AbortController | null = null
  private visible = true

  build(scene: THREE.Scene) { this.scene = scene }

  private clear() {
    if (this.mesh && this.scene) {
      this.scene.remove(this.mesh)
      this.mesh.geometry.dispose()
      ;(this.mesh.material as THREE.Material).dispose()
      this.mesh = null
    }
  }

  async update(params: Partial<LayerParams>) {
    if (!params.bbox || !params.source || params.timeIdx === undefined) return
    this.abort?.abort()
    this.abort = new AbortController()

    const depthLevels = useTarangStore.getState().depthLevels
    const depthM = depthLevels[params.depthIdx ?? 0] ?? 0

    try {
      const res = await fetchWaterMasses({
        source: params.source, time: params.timeIdx, depth: depthM, bbox: params.bbox, k: 4,
      }, this.abort.signal)
      if (this.abort.signal.aborted) return
      this.clear()

      const [latN, lonN] = res.shape
      const [loA, loB] = res.bounds.lon
      const [laA, laB] = res.bounds.lat

      // Subsample so the instance count stays GPU-friendly (~4k points max).
      const target = 4000
      const stride = Math.max(1, Math.ceil(Math.sqrt((latN * lonN) / target)))

      const positions: THREE.Vector3[] = []
      const colorIdx: number[] = []
      for (let i = 0; i < latN; i += stride) {
        for (let j = 0; j < lonN; j += stride) {
          const lbl = res.labels[i * lonN + j]
          if (lbl < 0) continue
          const lat = laA + (laB - laA) * (i / Math.max(1, latN - 1))
          const lon = loA + (loB - loA) * (j / Math.max(1, lonN - 1))
          positions.push(latLonToXYZ(lat, lon, EARTH_RADIUS * 1.008))
          colorIdx.push(lbl)
        }
      }
      if (positions.length === 0) return

      const geo = new THREE.SphereGeometry(0.5, 8, 8)
      const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.8 })
      const mesh = new THREE.InstancedMesh(geo, mat, positions.length)
      mesh.frustumCulled = false
      const dummy = new THREE.Object3D()
      const col = new THREE.Color()
      positions.forEach((p, n) => {
        dummy.position.copy(p); dummy.updateMatrix()
        mesh.setMatrixAt(n, dummy.matrix)
        col.set(WATER_MASS_COLORS[colorIdx[n] % WATER_MASS_COLORS.length])
        mesh.setColorAt(n, col)
      })
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      mesh.visible = this.visible

      this.scene?.add(mesh)
      this.mesh = mesh
    } catch (e: unknown) {
      if ((e as Error).name !== 'AbortError') console.warn('WaterMassOverlayLayer:', (e as Error).message)
    }
  }

  setVisible(visible: boolean) {
    this.visible = visible
    if (this.mesh) this.mesh.visible = visible
  }

  dispose() {
    this.abort?.abort()
    this.clear()
  }
}
