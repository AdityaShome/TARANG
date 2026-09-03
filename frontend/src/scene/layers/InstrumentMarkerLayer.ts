import * as THREE from 'three'
import { Layer, LayerParams } from '../LayerManager'
import { fetchInstruments } from '../../api/client'
import { useTarangStore } from '../../state/store'

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

// Per-sensor-type colours are user-customizable and live in the store (InstrumentLegend edits
// them, localStorage persists them). Read fresh on every update() so a recolour takes effect.
function colorFor(type: string): number {
  const hex = useTarangStore.getState().instrumentColors[type]
    ?? useTarangStore.getState().instrumentColors.other
    ?? '#ffffff'
  return new THREE.Color(hex).getHex()
}

// One InstancedMesh per sensor type, each with a plain solid-color material, rather than a
// single InstancedMesh using per-instance vertexColors/setColorAt. On this stack's WebGL
// backend (ANGLE→D3D11 on Windows), MeshPhongMaterial/MeshBasicMaterial with vertexColors:true
// on an InstancedMesh renders every instance pure black — verified the instanceColor buffer's
// CPU-side data is correct (RGB floats match TYPE_COLORS exactly) but the fragment output is
// always (0,0,0) regardless of base material.color, so it's a driver/shader-translation bug in
// the USE_INSTANCING_COLOR path, not an application bug. A solid material.color per mesh
// (proven to render correctly) sidesteps it entirely.
export class InstrumentMarkerLayer implements Layer {
  private meshes: THREE.InstancedMesh[] = []
  private platformIdsByMesh: Map<THREE.InstancedMesh, string[]> = new Map()
  private positionsByMesh: Map<THREE.InstancedMesh, THREE.Vector3[]> = new Map()
  private scene: THREE.Scene | null = null
  private abortController: AbortController | null = null
  private markerScale = 1
  private readonly _dummy = new THREE.Object3D()

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
    this.platformIdsByMesh.clear()
    this.positionsByMesh.clear()
  }

  /**
   * Keep markers a roughly constant apparent size as the camera dogs in/out. Called from the
   * render loop with the camera distance to the globe centre; a fixed world-radius sphere
   * otherwise balloons into a blob on close zoom. Throttled by the caller (only re-applies on a
   * meaningful change) since it rewrites every instance matrix.
   */
  setCameraDistance(distance: number) {
    // At the default framing (~2.4 R) markers are scale 1; closer in they shrink toward 0.25x,
    // further out they grow up to 3x so they stay pickable on a whole-globe view.
    const s = THREE.MathUtils.clamp(distance / (EARTH_RADIUS * 2.4), 0.25, 3)
    if (Math.abs(s - this.markerScale) < 0.04) return
    this.markerScale = s
    for (const mesh of this.meshes) {
      const positions = this.positionsByMesh.get(mesh)
      if (!positions) continue
      positions.forEach((pos, i) => {
        this._dummy.position.copy(pos)
        this._dummy.scale.setScalar(s)
        this._dummy.updateMatrix()
        mesh.setMatrixAt(i, this._dummy.matrix)
      })
      mesh.instanceMatrix.needsUpdate = true
    }
  }

  async update(params: Partial<LayerParams>) {
    if (params.bbox) {
      if (this.abortController) this.abortController.abort()
      this.abortController = new AbortController()

      try {
        const { instruments } = await fetchInstruments({ bbox: params.bbox }, this.abortController.signal)

        this.clearMeshes()
        if (instruments.length === 0) return

        const byType = new Map<string, typeof instruments>()
        for (const inst of instruments) {
          const list = byType.get(inst.type) ?? []
          list.push(inst)
          byType.set(inst.type, list)
        }

        useTarangStore.getState().setInstrumentsInView(
          [...byType.entries()].map(([type, list]) => ({ type, count: list.length })),
        )

        const dummy = new THREE.Object3D()

        for (const [type, group] of byType) {
          // Radius in world units, not degrees — visible at a glance against a 200-radius globe.
          const geometry = new THREE.SphereGeometry(1.6, 16, 16)
          const material = new THREE.MeshPhongMaterial({ color: colorFor(type) })
          const mesh = new THREE.InstancedMesh(geometry, material, group.length)
          mesh.frustumCulled = false // see the identical note in the other layers

          const platformIds: string[] = []
          const positions: THREE.Vector3[] = []
          group.forEach((inst, i) => {
            platformIds.push(inst.platform_id)
            // Sit slightly above the surface (matches DepthSliceLayer's 1.0025x / boundary box's
            // 1.006x radii) so markers aren't z-fighting with the globe or hidden under the slice.
            const pos = latLonToXYZ(inst.lat, inst.lon, EARTH_RADIUS * 1.01)
            positions.push(pos)
            dummy.position.copy(pos)
            dummy.scale.setScalar(this.markerScale)
            dummy.updateMatrix()
            mesh.setMatrixAt(i, dummy.matrix)
          })

          mesh.instanceMatrix.needsUpdate = true
          this.platformIdsByMesh.set(mesh, platformIds)
          this.positionsByMesh.set(mesh, positions)
          this.meshes.push(mesh)
          this.scene!.add(mesh)
        }
      } catch (e: any) {
        if (e.name !== 'AbortError') console.error(e)
      }
    }
  }

  // Basic hit test API for SceneManager to call on click
  getPlatformIdAt(mesh: THREE.InstancedMesh, instanceId: number): string | null {
    return this.platformIdsByMesh.get(mesh)?.[instanceId] ?? null
  }

  getMeshes() {
    return this.meshes
  }

  setVisible(visible: boolean) {
    for (const mesh of this.meshes) mesh.visible = visible
  }

  dispose() {
    if (this.abortController) this.abortController.abort()
    this.clearMeshes()
  }
}
