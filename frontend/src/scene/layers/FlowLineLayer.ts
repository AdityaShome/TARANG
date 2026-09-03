import * as THREE from 'three'
import { Layer, LayerParams } from '../LayerManager'
import { fetchSlice } from '../../api/client'
import { useTarangStore } from '../../state/store'

const EARTH_RADIUS = 200
// Depth-resolved uo/vo (40 levels) so streamlines follow the depth slider, not just the surface.
const FLOW_SOURCE = 'copernicus_marine'

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
 * FlowLineLayer — globe streamlines with a travelling pulse.
 *
 * Integrates seed points through the bilinearly-sampled uo/vo field to build
 * streamline polylines, then renders them as one LineSegments mesh. A shader
 * animates a bright pulse along each line (per-vertex arc-length `aT` + `uTime`)
 * so the direction and relative speed of the current read at a glance — the
 * thing a static arrow-glyph layer can't convey.
 */
export class FlowLineLayer implements Layer {
  private mesh: THREE.LineSegments | null = null
  private scene: THREE.Scene | null = null
  private abort: AbortController | null = null
  private visible = true
  private mat: THREE.ShaderMaterial | null = null

  build(scene: THREE.Scene) { this.scene = scene }

  private clear() {
    if (this.mesh && this.scene) {
      this.scene.remove(this.mesh)
      this.mesh.geometry.dispose()
      ;(this.mesh.material as THREE.Material).dispose()
      this.mesh = null
      this.mat = null
    }
  }

  animate(elapsed: number) {
    if (this.mat) this.mat.uniforms.uTime.value = elapsed
  }

  async update(params: Partial<LayerParams>) {
    if (!params.bbox || params.timeIdx === undefined) return
    this.abort?.abort()
    this.abort = new AbortController()

    const depthLevels = useTarangStore.getState().depthLevels
    const depthM = depthLevels[params.depthIdx ?? 0] ?? 0
    const [minLon, minLat, maxLon, maxLat] = params.bbox

    try {
      const [uR, vR] = await Promise.all([
        fetchSlice({ source: FLOW_SOURCE, var: 'uo', depth: depthM, time: params.timeIdx, bbox: params.bbox }, this.abort.signal),
        fetchSlice({ source: FLOW_SOURCE, var: 'vo', depth: depthM, time: params.timeIdx, bbox: params.bbox }, this.abort.signal),
      ])
      if (this.abort.signal.aborted) return
      this.clear()

      const [nlat, nlon] = uR.header.shape
      const [loA, loB] = uR.header.bounds.lon
      const [laA, laB] = uR.header.bounds.lat
      const u = uR.data, v = vR.data

      const sampleUV = (lat: number, lon: number): [number, number] | null => {
        if (lon < loA || lon > loB || lat < laA || lat > laB) return null
        const fx = ((lon - loA) / (loB - loA)) * (nlon - 1)
        const fy = ((lat - laA) / (laB - laA)) * (nlat - 1)
        const x0 = Math.floor(fx), y0 = Math.floor(fy)
        const x1 = Math.min(x0 + 1, nlon - 1), y1 = Math.min(y0 + 1, nlat - 1)
        const tx = fx - x0, ty = fy - y0
        const at = (yy: number, xx: number, arr: Float32Array) => arr[yy * nlon + xx]
        const uu = (at(y0, x0, u) * (1 - tx) + at(y0, x1, u) * tx) * (1 - ty) + (at(y1, x0, u) * (1 - tx) + at(y1, x1, u) * tx) * ty
        const vv = (at(y0, x0, v) * (1 - tx) + at(y0, x1, v) * tx) * (1 - ty) + (at(y1, x0, v) * (1 - tx) + at(y1, x1, v) * tx) * ty
        if (!Number.isFinite(uu) || !Number.isFinite(vv) || Math.abs(uu) > 50 || Math.abs(vv) > 50) return null
        return [uu, vv]
      }

      // Seed a jittered grid of streamlines.
      const SEEDS_X = 26, SEEDS_Y = 20, STEPS = 34, DT = 0.12
      const positions: number[] = []
      const arcT: number[] = []
      for (let sy = 0; sy < SEEDS_Y; sy++) {
        for (let sx = 0; sx < SEEDS_X; sx++) {
          let lat = minLat + (maxLat - minLat) * ((sx % 2 ? sy + 0.5 : sy) / SEEDS_Y)
          let lon = minLon + (maxLon - minLon) * ((sx + Math.random() * 0.6) / SEEDS_X)
          const pts: THREE.Vector3[] = []
          for (let k = 0; k < STEPS; k++) {
            const vel = sampleUV(lat, lon)
            if (!vel) break
            pts.push(latLonToXYZ(lat, lon, EARTH_RADIUS * 1.006))
            lat += vel[1] * DT
            lon += vel[0] * DT
          }
          for (let k = 0; k + 1 < pts.length; k++) {
            positions.push(pts[k].x, pts[k].y, pts[k].z, pts[k + 1].x, pts[k + 1].y, pts[k + 1].z)
            arcT.push(k / STEPS, (k + 1) / STEPS)
          }
        }
      }
      if (positions.length === 0) return

      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
      geo.setAttribute('aT', new THREE.Float32BufferAttribute(arcT, 1))

      this.mat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: { uTime: { value: 0 } },
        vertexShader: `
          attribute float aT;
          varying float vT;
          void main() {
            vT = aT;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `
          precision highp float;
          uniform float uTime;
          varying float vT;
          void main() {
            float base = 0.18;
            float pulse = fract(vT * 3.0 - uTime * 0.5);
            float bright = smoothstep(0.85, 1.0, pulse) * 0.9;
            vec3 col = mix(vec3(0.30, 0.75, 0.95), vec3(0.75, 0.98, 1.0), bright);
            gl_FragColor = vec4(col, base + bright);
          }`,
      })

      const mesh = new THREE.LineSegments(geo, this.mat)
      mesh.frustumCulled = false
      mesh.renderOrder = 5
      mesh.visible = this.visible
      this.scene?.add(mesh)
      this.mesh = mesh
    } catch (e: unknown) {
      if ((e as Error).name !== 'AbortError') console.warn('FlowLineLayer:', (e as Error).message)
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
