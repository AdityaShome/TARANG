/**
 * OceanCubeLayer — 3D translucent cuboid ocean section
 *
 * TARANG SIH 2026 · PS 26067 · MoES/INCOIS
 *
 * Renders the selected bbox as a Three.js BoxGeometry cube showing:
 *   1. Deep-blue to teal gradient from seabed to surface
 *   2. Dark rocky seabed solid face (uvw.z ≈ 0)
 *   3. Volume data (temperature / salinity) tinted onto the gradient
 *   4. Argo surface floats as red drop-pins on the cube top face
 *   5. Underwater gliders as cyan spheres inside the cube at 30% depth
 *   6. Eddy current rings as animated torus meshes (warm=orange / cold=cyan)
 *      with arrow-cone indicators for rotation direction
 *
 * animate(dt) MUST be called every frame by SceneManager to spin eddy rings.
 */

import * as THREE from 'three'
import { Layer, LayerParams } from '../LayerManager'
import { fetchVolume } from '../../api/client'
import { fetchInstruments } from '../../api/client'
import { fetchEddyDetection } from '../../api/eddy'
import { useTarangStore } from '../../state/store'
import { EARTH_RADIUS, latLonToXYZ, surfaceBasis } from './sphereUtils'
import { computeDataRange } from './dataStats'

import vertShader from '../shaders/oceanCubeVert.glsl?raw'
import fragShader from '../shaders/oceanCubeFrag.glsl?raw'

// ── Constants ─────────────────────────────────────────────────────────────────

const DEG_TO_WORLD = (Math.PI * EARTH_RADIUS) / 180
// Fixed vertical exaggeration for cube mode — inherits from store's verticalExaggeration
const CUBE_OPACITY = 0.80

// Seabed: dark rocky brown
const SEABED_COLOR  = new THREE.Color(0x1a1208)
// Deep ocean: near-black midnight blue
const DEEP_COLOR    = new THREE.Color(0x001428)
// Surface: ocean teal/cyan
const SURFACE_COLOR = new THREE.Color(0x006b8a)

// Eddy ring spin speed (radians per second) — warm eddies spin faster
const WARM_SPIN = 0.6
const COLD_SPIN = -0.4

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── OceanCubeLayer ────────────────────────────────────────────────────────────

export class OceanCubeLayer implements Layer {
  // ── Three.js objects ──────────────────────────────────────────────────────
  private scene:    THREE.Scene | null = null
  private cubeMesh: THREE.Mesh  | null = null
  private cubeMat:  THREE.ShaderMaterial | null = null
  private cubeGeo:  THREE.BoxGeometry    | null = null
  private cubeTexture: THREE.Data3DTexture | null = null

  // Instrument markers
  private argoMeshes:   THREE.InstancedMesh[] = []
  private gliderMeshes: THREE.InstancedMesh[] = []

  // Eddy rings: torus + arrow cones per eddy
  private eddyRings: Array<{
    torus:  THREE.Mesh
    arrows: THREE.InstancedMesh
    spin:   number  // radians/sec (sign encodes warm/cold)
  }> = []

  // ── State ─────────────────────────────────────────────────────────────────
  private wantVisible = true
  private hasData     = false
  private abortCtrl:  AbortController | null = null

  // Cached geometry for re-use across update() calls
  private lastBounds: { lat: [number, number]; lon: [number, number] } | null = null
  private boxScale  = new THREE.Vector3(1, 1, 1)
  private halfDepth = 0

  // ── Layer interface ───────────────────────────────────────────────────────

  build(scene: THREE.Scene) {
    this.scene = scene

    // BoxGeometry: 2×2×2 segments so each face normal is correct on both sides
    this.cubeGeo = new THREE.BoxGeometry(1, 1, 1, 2, 2, 2)

    this.cubeMat = new THREE.ShaderMaterial({
      vertexShader:   vertShader,
      fragmentShader: fragShader,
      uniforms: {
        u_data:         { value: null },
        u_hasData:      { value: 0 },
        u_clim:         { value: new THREE.Vector2(0, 1) },
        u_missing:      { value: 99999.0 },
        u_opacity:      { value: CUBE_OPACITY },
        u_seabedColor:  { value: SEABED_COLOR },
        u_deepColor:    { value: DEEP_COLOR },
        u_surfaceColor: { value: SURFACE_COLOR },
      },
      transparent: true,
      side:        THREE.DoubleSide,   // visible from inside AND below (seabed view)
      depthWrite:  false,
      depthTest:   false,              // sits over the globe; no depth testing
      glslVersion: THREE.GLSL3,
    })

    this.cubeMesh = new THREE.Mesh(this.cubeGeo, this.cubeMat)
    this.cubeMesh.renderOrder  = 4    // on top of other data layers
    this.cubeMesh.frustumCulled = false
    this.cubeMesh.visible       = false
    scene.add(this.cubeMesh)
  }

  async update(params: Partial<LayerParams>) {
    if (!this.cubeMesh || !this.cubeMat) return

    if (params.opacity !== undefined) {
      this.cubeMat.uniforms.u_opacity.value = params.opacity
    }

    if (
      params.source && params.variable &&
      params.bbox   && params.timeIdx !== undefined
    ) {
      if (this.abortCtrl) this.abortCtrl.abort()
      this.abortCtrl = new AbortController()

      const { source, variable, bbox, timeIdx } = params as {
        source: string; variable: string;
        bbox: [number, number, number, number]; timeIdx: number
      }

      // ── Fetch in parallel ──────────────────────────────────────────────
      const [volumeResult, instrumentsResult, eddyResult] = await Promise.allSettled([
        fetchVolume({ source, var: variable, time: timeIdx, bbox }, this.abortCtrl.signal),
        fetchInstruments({ bbox }, this.abortCtrl.signal),
        fetchEddyDetection({ source, time: timeIdx, bbox }, this.abortCtrl.signal),
      ])

      // ── Position and size the cube box ────────────────────────────────
      const [minLon, minLat, maxLon, maxLat] = bbox
      const widthDeg  = maxLon - minLon
      const heightDeg = maxLat - minLat
      const centerLat = (minLat + maxLat) / 2
      const centerLon = (minLon + maxLon) / 2

      const state      = useTarangStore.getState()
      const vExag      = state.colormap.verticalExaggeration || 50
      const maxDepthM  = (() => {
        if (volumeResult.status === 'fulfilled') {
          return Math.max(...volumeResult.value.header.depth_levels)
        }
        return 1000
      })()
      const depthScale = (maxDepthM / 111000) * vExag

      this.boxScale.set(
        widthDeg  * DEG_TO_WORLD,
        heightDeg * DEG_TO_WORLD,
        depthScale * DEG_TO_WORLD,
      )
      this.halfDepth = (depthScale * DEG_TO_WORLD) / 2

      const { east, north, outward } = surfaceBasis(centerLat, centerLon)
      const surfacePoint = outward.clone().multiplyScalar(EARTH_RADIUS)

      // Orient cube: X=lon(east), Y=lat(north), Z=depth(outward)
      this.cubeMesh.quaternion.setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(east, north, outward)
      )
      this.cubeMesh.scale.copy(this.boxScale)
      // Position: centre of cube sits at the midpoint between surface and seabed
      this.cubeMesh.position.copy(surfacePoint)
        .addScaledVector(outward, -this.halfDepth)

      this.cubeMesh.updateMatrixWorld(true)

      this.lastBounds = {
        lat: [minLat, maxLat],
        lon: [minLon, maxLon],
      }

      // ── Apply volume data ────────────────────────────────────────────
      if (volumeResult.status === 'fulfilled') {
        const { header, data } = volumeResult.value
        const [depthSize, latSize, lonSize] = header.shape

        if (
          !this.cubeTexture ||
          this.cubeTexture.image.width  !== lonSize ||
          this.cubeTexture.image.height !== latSize ||
          this.cubeTexture.image.depth  !== depthSize
        ) {
          if (this.cubeTexture) this.cubeTexture.dispose()
          this.cubeTexture = new THREE.Data3DTexture(data as unknown as Float32Array<ArrayBuffer>, lonSize, latSize, depthSize)
          this.cubeTexture.format    = THREE.RedFormat
          this.cubeTexture.type      = THREE.FloatType
          this.cubeTexture.minFilter = THREE.NearestFilter
          this.cubeTexture.magFilter = THREE.NearestFilter
          this.cubeTexture.unpackAlignment = 1
          this.cubeTexture.needsUpdate = true
          this.cubeMat.uniforms.u_data.value = this.cubeTexture
        } else {
          this.cubeTexture.image.data = data as any
          this.cubeTexture.needsUpdate = true
        }

        const [dataMin, dataMax] = computeDataRange(
          data, header.missing_value, header.valid_min, header.valid_max
        )
        this.cubeMat.uniforms.u_clim.value.set(dataMin, dataMax)
        this.cubeMat.uniforms.u_missing.value = header.missing_value ?? -9999.0
        this.cubeMat.uniforms.u_hasData.value = 1

        useTarangStore.getState().setColormap({ min: dataMin, max: dataMax })
        this.hasData = true
      }

      this.cubeMesh.visible = this.wantVisible

      // ── Instrument markers ───────────────────────────────────────────
      this.clearMarkers()

      if (instrumentsResult.status === 'fulfilled') {
        const { instruments } = instrumentsResult.value
        const argos   = instruments.filter(i => i.type === 'argo')
        const gliders = instruments.filter(i => i.type === 'glider')
        const others  = instruments.filter(i => i.type !== 'argo' && i.type !== 'glider')

        if (argos.length > 0) {
          this.buildArgoPins(argos)
        }
        if (gliders.length > 0) {
          this.buildGliderSpheres(gliders)
        }
        // Other instrument types (CTD, BGC, mooring, ADCP) on the surface too
        if (others.length > 0) {
          this.buildOtherMarkers(others)
        }
      }

      // ── Eddy rings ───────────────────────────────────────────────────
      this.clearEddyRings()

      if (eddyResult.status === 'fulfilled') {
        const cells = eddyResult.value
        const warm  = cells.filter(c => c.type === 'warm')
        const cold  = cells.filter(c => c.type === 'cold')

        for (const cell of warm) this.buildEddyRing(cell.lat, cell.lon, 'warm')
        for (const cell of cold) this.buildEddyRing(cell.lat, cell.lon, 'cold')
      }
    }
  }

  // ── Argo drop-pin markers (red inverted cones on the cube top face) ───────
  private buildArgoPins(instruments: Array<{ lat: number; lon: number }>) {
    if (!this.scene || !this.lastBounds) return

    // Inverted cone = pin shape. Tip at the surface, base up.
    const coneGeo  = new THREE.ConeGeometry(0.6, 3.5, 8)
    // Rotate so the tip points downward (−Y in cone local space)
    coneGeo.rotateX(Math.PI)

    const coneMat = new THREE.MeshPhongMaterial({
      color:   0xff2222,   // vivid red
      emissive: 0x660000,
      shininess: 80,
    })

    const mesh = new THREE.InstancedMesh(coneGeo, coneMat, instruments.length)
    mesh.frustumCulled = false
    mesh.renderOrder   = 5

    const dummy = new THREE.Object3D()
    instruments.forEach((inst, i) => {
      // Place pin at the exact top surface of the cube; cone points down into the water
      const pos = latLonToXYZ(inst.lat, inst.lon, EARTH_RADIUS * 1.013)
      dummy.position.copy(pos)
      // Orient tip toward globe centre so cone sits vertically on the sphere
      dummy.lookAt(pos.clone().multiplyScalar(1.8))
      dummy.rotateX(Math.PI)
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
    })

    mesh.instanceMatrix.needsUpdate = true
    this.argoMeshes.push(mesh)
    this.scene.add(mesh)
  }

  // ── Glider spheres (cyan, inside cube at 30% depth) ───────────────────────
  private buildGliderSpheres(instruments: Array<{ lat: number; lon: number }>) {
    if (!this.scene || !this.lastBounds) return

    const sphereGeo = new THREE.SphereGeometry(1.0, 12, 12)
    const sphereMat = new THREE.MeshPhongMaterial({
      color:     0x00e5ff,
      emissive:  0x004466,
      shininess: 100,
      transparent: true,
      opacity: 0.9,
    })

    const mesh = new THREE.InstancedMesh(sphereGeo, sphereMat, instruments.length)
    mesh.frustumCulled = false
    mesh.renderOrder   = 5

    const dummy = new THREE.Object3D()
    instruments.forEach((inst, i) => {
      // 30% depth from bottom = 30% of depth scale above seabed
      // In world space: position is (surfacePoint - halfDepth*outward) + 0.3 * scale.z * outward
      // Simpler: put at EARTH_RADIUS with a slight inward offset representing depth
      const r = EARTH_RADIUS * 1.013 - this.halfDepth * 2 * 0.7   // 70% from surface = 30% from seabed
      const pos = latLonToXYZ(inst.lat, inst.lon, Math.max(r, EARTH_RADIUS * 1.002))
      dummy.position.copy(pos)
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
    })

    mesh.instanceMatrix.needsUpdate = true
    this.gliderMeshes.push(mesh)
    this.scene.add(mesh)
  }

  // ── Other instrument types (white small spheres on surface) ───────────────
  private buildOtherMarkers(instruments: Array<{ lat: number; lon: number; type: string }>) {
    if (!this.scene) return
    const TYPE_COLORS: Record<string, number> = {
      ctd:     0xff6b6b,
      bgc:     0x7cfc7c,
      mooring: 0xff8c00,
      adcp:    0xb388ff,
    }
    const byType = new Map<string, typeof instruments>()
    for (const inst of instruments) {
      const list = byType.get(inst.type) ?? []
      list.push(inst)
      byType.set(inst.type, list)
    }
    for (const [type, group] of byType) {
      const geo = new THREE.SphereGeometry(1.2, 8, 8)
      const mat = new THREE.MeshPhongMaterial({ color: TYPE_COLORS[type] ?? 0xffffff })
      const mesh = new THREE.InstancedMesh(geo, mat, group.length)
      mesh.frustumCulled = false
      mesh.renderOrder = 5
      const dummy = new THREE.Object3D()
      group.forEach((inst, i) => {
        dummy.position.copy(latLonToXYZ(inst.lat, inst.lon, EARTH_RADIUS * 1.013))
        dummy.updateMatrix()
        mesh.setMatrixAt(i, dummy.matrix)
      })
      mesh.instanceMatrix.needsUpdate = true
      this.argoMeshes.push(mesh)   // reuse argoMeshes array for generic cleanup
      this.scene.add(mesh)
    }
  }

  // ── Eddy ring builder ──────────────────────────────────────────────────────
  private buildEddyRing(lat: number, lon: number, type: 'warm' | 'cold') {
    if (!this.scene) return

    const isWarm     = type === 'warm'
    const ringColor  = isWarm ? 0xff8c00 : 0x00e5ff   // orange / cyan
    const spinSpeed  = isWarm ? WARM_SPIN : COLD_SPIN
    const radius     = 3.5

    const center = latLonToXYZ(lat, lon, EARTH_RADIUS * 1.009)
    const { east, north, outward } = surfaceBasis(lat, lon)

    // ── Torus (ring) ────────────────────────────────────────────────────────
    const torusGeo = new THREE.TorusGeometry(radius, 0.25, 8, 32)
    const torusMat = new THREE.MeshPhongMaterial({
      color:       ringColor,
      emissive:    new THREE.Color(ringColor).multiplyScalar(0.3),
      transparent: true,
      opacity:     0.85,
      shininess:   60,
    })
    const torus = new THREE.Mesh(torusGeo, torusMat)
    torus.frustumCulled = false
    torus.renderOrder   = 6

    // Orient torus flat against the sphere surface (rotate so torus plane = tangent plane)
    torus.quaternion.setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(east, north, outward)
    )
    // torusGeometry lies in XY plane by default → rotate 90° around the outward-mapped local X
    torus.rotateOnWorldAxis(east, Math.PI / 2)
    torus.position.copy(center)
    this.scene.add(torus)

    // ── Arrow cones (8 evenly spaced around the ring) ──────────────────────
    const ARROW_COUNT = 8
    const coneGeo  = new THREE.ConeGeometry(0.3, 1.2, 6)
    const coneMat  = new THREE.MeshPhongMaterial({
      color: ringColor,
      emissive: new THREE.Color(ringColor).multiplyScalar(0.4),
    })
    const arrows = new THREE.InstancedMesh(coneGeo, coneMat, ARROW_COUNT)
    arrows.frustumCulled = false
    arrows.renderOrder   = 7

    const dummy = new THREE.Object3D()

    for (let k = 0; k < ARROW_COUNT; k++) {
      const angle = (k / ARROW_COUNT) * Math.PI * 2
      const offset = east.clone().multiplyScalar(Math.cos(angle) * radius)
        .addScaledVector(north, Math.sin(angle) * radius)
      dummy.position.copy(center).add(offset)

      // Arrow points in the tangential direction (cross of outward × radial offset)
      const radial = offset.clone().normalize()
      const tangDir = outward.clone().cross(radial)
      if (!isWarm) tangDir.negate()  // cold = opposite rotation

      dummy.lookAt(dummy.position.clone().add(tangDir))
      dummy.rotateX(Math.PI / 2)  // cone tip forward
      dummy.updateMatrix()
      arrows.setMatrixAt(k, dummy.matrix)
    }

    arrows.instanceMatrix.needsUpdate = true
    this.scene.add(arrows)

    this.eddyRings.push({ torus, arrows, spin: spinSpeed })
  }

  // ── Cleanup helpers ────────────────────────────────────────────────────────
  private clearMarkers() {
    if (!this.scene) return
    for (const mesh of [...this.argoMeshes, ...this.gliderMeshes]) {
      this.scene.remove(mesh)
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
    this.argoMeshes   = []
    this.gliderMeshes = []
  }

  private clearEddyRings() {
    if (!this.scene) return
    for (const { torus, arrows } of this.eddyRings) {
      this.scene.remove(torus)
      this.scene.remove(arrows)
      torus.geometry.dispose()
      ;(torus.material as THREE.Material).dispose()
      arrows.geometry.dispose()
      ;(arrows.material as THREE.Material).dispose()
    }
    this.eddyRings = []
  }

  // ── Animation tick (called every frame by SceneManager) ────────────────────
  animate(dt: number) {
    for (const ring of this.eddyRings) {
      const { torus, spin } = ring
      // Rotate the torus around the sphere's outward normal at that point
      // The torus.rotation.z in torus-local space corresponds to in-plane spin.
      torus.rotateOnWorldAxis(torus.position.clone().normalize(), spin * dt)
    }
  }

  // ── Visibility ─────────────────────────────────────────────────────────────
  setVisible(visible: boolean) {
    this.wantVisible = visible
    if (this.cubeMesh) this.cubeMesh.visible = visible && this.hasData
    for (const mesh of [...this.argoMeshes, ...this.gliderMeshes]) {
      mesh.visible = visible
    }
    for (const { torus, arrows } of this.eddyRings) {
      torus.visible   = visible
      arrows.visible  = visible
    }
  }

  // ── Dispose ────────────────────────────────────────────────────────────────
  dispose() {
    if (this.abortCtrl) this.abortCtrl.abort()
    this.clearMarkers()
    this.clearEddyRings()
    if (this.scene && this.cubeMesh) this.scene.remove(this.cubeMesh)
    this.cubeGeo?.dispose()
    this.cubeMat?.dispose()
    this.cubeTexture?.dispose()
  }
}
