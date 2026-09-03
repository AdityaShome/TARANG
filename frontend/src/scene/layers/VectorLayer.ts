import * as THREE from 'three'
import { Layer, LayerParams } from '../LayerManager'
import { fetchSlice } from '../../api/client'
import { useTarangStore } from '../../state/store'

// Must match SceneManager.tsx's EARTH_RADIUS / latLonToXYZ exactly — same convention as every
// other layer that places geometry on the globe surface.
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

// Registry source this layer always reads from — vectors aren't picked via the main "Data
// Source" dropdown (that's a single scalar variable at a time); like markers, this is an
// independent overlay that's simply on or off via the "Vectors" layer checkbox.
// Copernicus Marine carries the depth-resolved (3D) uo/vo field (40 levels), so the arrows
// follow the depth slider through the full water column — not just the surface. (INCOIS
// NIO-HOOFS is surface-only; it still backs the eddy detector, which is a surface diagnostic.)
const VECTOR_SOURCE = 'copernicus_marine'
const U_VAR = 'uo'
const V_VAR = 'vo'

export class VectorLayer implements Layer {
  private group: THREE.Group | null = null
  private mesh: THREE.InstancedMesh | null = null
  private scene: THREE.Scene | null = null
  private abortController: AbortController | null = null

  build(scene: THREE.Scene) {
    this.scene = scene
    this.group = new THREE.Group()
    scene.add(this.group)
  }

  async update(params: Partial<LayerParams>) {
    if (!this.group || !params.bbox || params.timeIdx === undefined) return

    if (this.abortController) this.abortController.abort()
    this.abortController = new AbortController()
    const signal = this.abortController.signal

    // Resolve the depth-level index to metres the same way DepthSliceLayer does, so the
    // vector field is sampled at the depth the user is currently viewing.
    const depthLevels = useTarangStore.getState().depthLevels
    const depth_m = depthLevels[params.depthIdx ?? 0] ?? 0

    try {
      const [uResult, vResult] = await Promise.all([
        fetchSlice({ source: VECTOR_SOURCE, var: U_VAR, depth: depth_m, time: params.timeIdx, bbox: params.bbox }, signal),
        fetchSlice({ source: VECTOR_SOURCE, var: V_VAR, depth: depth_m, time: params.timeIdx, bbox: params.bbox }, signal),
      ])

      if (this.mesh) {
        this.group.remove(this.mesh)
        this.mesh.geometry.dispose()
        ;(this.mesh.material as THREE.Material).dispose()
        this.mesh = null
      }

      const [latSize, lonSize] = uResult.header.shape
      const u = uResult.data
      const v = vResult.data
      const { lon: [minLon, maxLon], lat: [minLat, maxLat] } = uResult.header.bounds

      const count = latSize * lonSize
      // A thin cone doubles as a simple arrow glyph: point = direction, base = tail.
      const geometry = new THREE.ConeGeometry(0.3, 1.6, 6)
      const material = new THREE.MeshPhongMaterial({ color: 0x00e5ff, opacity: params.opacity ?? 0.9, transparent: true })
      this.mesh = new THREE.InstancedMesh(geometry, material, count)
      this.mesh.frustumCulled = false

      const dummy = new THREE.Object3D()
      const refUp = new THREE.Vector3(0, 1, 0)
      let idx = 0

      for (let i = 0; i < latSize; i++) {
        const lat = minLat + (maxLat - minLat) * (i / (latSize - 1))
        for (let j = 0; j < lonSize; j++) {
          const lon = minLon + (maxLon - minLon) * (j / (lonSize - 1))
          const uVal = u[i * lonSize + j]
          const vVal = v[i * lonSize + j]
          const speed = Math.hypot(uVal, vVal)

          // Skip missing/degenerate cells rather than drawing a zero-length arrow at the origin.
          if (!isFinite(speed) || speed < 1e-4 || speed > 100) {
            dummy.position.set(0, 0, 0)
            dummy.scale.set(0, 0, 0)
            dummy.updateMatrix()
            this.mesh.setMatrixAt(idx, dummy.matrix)
            idx++
            continue
          }

          const surfacePoint = latLonToXYZ(lat, lon, EARTH_RADIUS * 1.012)

          // Local East/North basis via finite difference on the same projection every other
          // layer uses, rather than hand-deriving partial derivatives of latLonToXYZ (easy to
          // get a sign wrong) — numerically sampling two nearby points is trivially correct
          // regardless of the exact underlying spherical convention.
          const eps = 0.05
          const east  = latLonToXYZ(lat, lon + eps, EARTH_RADIUS * 1.012).sub(surfacePoint).normalize()
          const north = latLonToXYZ(lat + eps, lon, EARTH_RADIUS * 1.012).sub(surfacePoint).normalize()

          const worldDir = east.clone().multiplyScalar(uVal).add(north.clone().multiplyScalar(vVal)).normalize()

          dummy.position.copy(surfacePoint)
          dummy.quaternion.setFromUnitVectors(refUp, worldDir)
          // Scale arrow length with speed (clamped so a strong current doesn't dwarf the globe)
          // but keep a small visible floor so slow currents don't disappear entirely.
          const lengthScale = Math.min(0.4 + speed * 3.0, 3.0)
          dummy.scale.set(1, lengthScale, 1)
          dummy.updateMatrix()
          this.mesh.setMatrixAt(idx, dummy.matrix)
          idx++
        }
      }

      this.mesh.instanceMatrix.needsUpdate = true
      this.group.add(this.mesh)
    } catch (err: any) {
      if (err?.name !== 'AbortError') console.error('VectorLayer fetch error:', err)
    }
  }

  setVisible(visible: boolean) {
    if (this.group) this.group.visible = visible
  }

  dispose() {
    if (this.abortController) this.abortController.abort()
    if (this.mesh && this.group) {
      this.group.remove(this.mesh)
      this.mesh.geometry.dispose()
      ;(this.mesh.material as THREE.Material).dispose()
    }
    if (this.group && this.scene) this.scene.remove(this.group)
  }
}
