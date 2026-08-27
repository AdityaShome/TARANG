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

// One color per sensor type so the overlay actually reads as "multiple kinds of instruments",
// not a single undifferentiated cloud of dots — matches the PS's "unified display of Argo
// float and Glider profile data ... alongside model fields" requirement, extended to whatever
// types a deployment's PostGIS data actually contains (falls back to TYPE_COLORS.default).
const TYPE_COLORS: Record<string, number> = {
  argo:    0xffcc00, // yellow
  glider:  0x00e5ff, // cyan
  ctd:     0xff6b6b, // red
  bgc:     0x7cfc7c, // green
  mooring: 0xff8c00, // orange
  adcp:    0xb388ff, // violet
  default: 0xffffff,
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
    this.platformIdsByMesh.clear()
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

        const dummy = new THREE.Object3D()

        for (const [type, group] of byType) {
          // Radius in world units, not degrees — visible at a glance against a 200-radius globe.
          const geometry = new THREE.SphereGeometry(1.6, 16, 16)
          const material = new THREE.MeshPhongMaterial({ color: TYPE_COLORS[type] ?? TYPE_COLORS.default })
          const mesh = new THREE.InstancedMesh(geometry, material, group.length)
          mesh.frustumCulled = false // see the identical note in the other layers

          const platformIds: string[] = []
          group.forEach((inst, i) => {
            platformIds.push(inst.platform_id)
            // Sit slightly above the surface (matches DepthSliceLayer's 1.0025x / boundary box's
            // 1.006x radii) so markers aren't z-fighting with the globe or hidden under the slice.
            dummy.position.copy(latLonToXYZ(inst.lat, inst.lon, EARTH_RADIUS * 1.01))
            dummy.updateMatrix()
            mesh.setMatrixAt(i, dummy.matrix)
          })

          mesh.instanceMatrix.needsUpdate = true
          this.platformIdsByMesh.set(mesh, platformIds)
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

  dispose() {
    if (this.abortController) this.abortController.abort()
    this.clearMeshes()
  }
}
