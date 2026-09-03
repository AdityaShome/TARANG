import * as THREE from 'three'
import { Layer, LayerParams } from '../LayerManager'
import { fetchSlice } from '../../api/client'
import { useTarangStore } from '../../state/store'
import { computeDataRange } from './dataStats'
import { getOrFetchPreview, peekPreview, cropPreview } from './previewCache'

import vertShader from '../shaders/depthSliceVert.glsl?raw'
import fragShader from '../shaders/colormapFrag.glsl?raw'
import { buildColormapLUT } from '../colormaps'

export class DepthSliceLayer implements Layer {
  private mesh: THREE.Mesh | null = null
  private texture: THREE.DataTexture | null = null
  private material: THREE.ShaderMaterial | null = null
  private scene: THREE.Scene | null = null
  private abortController: AbortController | null = null
  private wantVisible = true   // setVisible() intent; ANDed with hasData
  private hasData = false
  // Bumped on every update() call; a stale preview/real result whose token no longer matches
  // the latest request is discarded instead of clobbering a newer selection (region picked
  // twice quickly, or the preview crop resolving after the real fetch already landed).
  private requestToken = 0
  // The request whose REAL (non-preview) result has already been applied — a late-arriving
  // preview crop for that same request must not regress the mesh back to a dim placeholder.
  private realLandedToken = -1
  // True while the mesh shows the coarse preview crop rather than the real regional fetch —
  // SceneManager/UI can read this to show a "preview" hint if desired.
  isPreview = false
  // The real opacity requested via update({opacity}) — the preview crop renders dimmed
  // (fraction of this) so it visibly reads as "loading placeholder", not final data.
  private baseOpacity = 1.0
  private static readonly PREVIEW_OPACITY_FACTOR = 0.45

  build(scene: THREE.Scene) {
    this.scene = scene
    // High-segment plane so it can bend smoothly onto the sphere
    const geometry = new THREE.PlaneGeometry(1, 1, 128, 128)
    
    this.material = new THREE.ShaderMaterial({
      vertexShader: vertShader,
      fragmentShader: fragShader,
      uniforms: {
        u_data: { value: null },
        u_clim: { value: new THREE.Vector2(0, 1) },
        u_opacity: { value: 1.0 },
        u_missing: { value: 99999.0 },
        u_bounds: { value: new THREE.Vector4(-180, 180, -90, 90) },
        u_colormap: { value: 0 },
        u_log_scale: { value: 0 },
        u_cmap: { value: buildColormapLUT('viridis', false) },
      },
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false
    })

    this.mesh = new THREE.Mesh(geometry, this.material)
    this.mesh.frustumCulled = false   // vertex shader displaces onto the sphere; bounds are wrong
    this.mesh.visible = false          // until update() has real data
    scene.add(this.mesh)
  }

  // Shared by both the instant preview crop and the real fetch — pushes a (lat, lon) grid onto
  // the mesh's texture/uniforms/bounds. `missing`/`validMin`/`validMax` fall back to sane
  // preview-grid defaults since a cropped preview doesn't carry a full CF header.
  private applyGrid(
    data: Float32Array, lonSize: number, latSize: number,
    bounds: { lat: [number, number]; lon: [number, number] },
    missing: number, validMin: number, validMax: number,
  ) {
    if (!this.mesh || !this.material) return

    if (!this.texture || this.texture.image.width !== lonSize || this.texture.image.height !== latSize) {
      if (this.texture) this.texture.dispose()
      this.texture = new THREE.DataTexture(data as unknown as Float32Array<ArrayBuffer>, lonSize, latSize, THREE.RedFormat, THREE.FloatType)
      // NearestFilter: linear on a float texture needs OES_texture_float_linear.
      this.texture.minFilter = THREE.NearestFilter
      this.texture.magFilter = THREE.NearestFilter
      this.texture.needsUpdate = true
      this.material.uniforms.u_data.value = this.texture
    } else {
      this.texture.image.data = data as any
      this.texture.needsUpdate = true
    }
    this.hasData = true
    this.mesh.visible = this.wantVisible
    this.material.uniforms.u_opacity.value = this.isPreview
      ? this.baseOpacity * DepthSliceLayer.PREVIEW_OPACITY_FACTOR
      : this.baseOpacity

    const state = useTarangStore.getState()
    // Auto-contrast-stretch to the actual fetched data's range, not the dataset's global
    // valid_min/valid_max — see dataStats.ts for why (a small region's real variance is a
    // sliver of the full range, so the colormap would otherwise read as flat/uncolored).
    const [dataMin, dataMax] = computeDataRange(data, missing, validMin, validMax)
    this.material.uniforms.u_clim.value.set(dataMin, dataMax)
    useTarangStore.getState().setColormap({ min: dataMin, max: dataMax })
    this.material.uniforms.u_missing.value = missing ?? -9999.0
    this.material.uniforms.u_cmap.value = buildColormapLUT(state.colormap.name, state.colormap.reversed)
    this.material.uniforms.u_log_scale.value = state.colormap.logScale ? 1 : 0

    // Pass bounds to vertex shader to warp onto sphere (1 scene unit = 1 degree)
    this.material.uniforms.u_bounds.value.set(bounds.lon[0], bounds.lon[1], bounds.lat[0], bounds.lat[1])

    // Ensure mesh is at origin with scale 1, since shader handles everything
    this.mesh.position.set(0, 0, 0)
    this.mesh.rotation.set(0, 0, 0)
    this.mesh.scale.set(1, 1, 1)
  }

  async update(params: Partial<LayerParams>) {
    if (!this.mesh || !this.material) return

    if (params.opacity !== undefined) {
      this.baseOpacity = params.opacity
      this.material.uniforms.u_opacity.value = this.isPreview
        ? this.baseOpacity * DepthSliceLayer.PREVIEW_OPACITY_FACTOR
        : this.baseOpacity
    }

    if (
      params.source &&
      params.variable &&
      params.bbox &&
      params.timeIdx !== undefined &&
      params.depthIdx !== undefined
    ) {
      const { source, variable, bbox, timeIdx } = params as {
        source: string; variable: string; bbox: [number, number, number, number]; timeIdx: number
      }
      const myToken = ++this.requestToken

      // Instant placeholder: crop this source/var's cached full-extent preview to the newly
      // picked region and paint it immediately, so the researcher sees SOMETHING the moment
      // they pick a region instead of a stale previous-region gradient or a blank layer while
      // the real (possibly slow, e.g. live Copernicus) fetch is in flight.
      const cached = peekPreview(source, variable, timeIdx)
      const applyPreview = (preview: typeof cached) => {
        if (!preview || myToken !== this.requestToken || this.realLandedToken === myToken) return
        const cropped = cropPreview(preview, bbox)
        if (!cropped) {
          // No placeholder available here (region outside the preview's coverage). Don't leave
          // the PREVIOUS region's overlay on screen while the real fetch runs — clear now; the
          // real fetch will either fill it or (if it too has no data) leave it cleared.
          this.clearData()
          return
        }
        this.isPreview = true
        this.applyGrid(
          cropped.data, cropped.width, cropped.height, cropped.bounds,
          preview.header.missing_value, preview.header.valid_min, preview.header.valid_max,
        )
      }
      if (cached) {
        applyPreview(cached)
      } else {
        getOrFetchPreview(source, variable, timeIdx).then(applyPreview)
      }

      // Cancel previous real fetch if still in flight
      if (this.abortController) {
        this.abortController.abort()
      }
      this.abortController = new AbortController()

      try {
        const state = useTarangStore.getState()
        const depth_m = state.depthLevels[params.depthIdx] || 0

        const { header, data } = await fetchSlice({
          source, var: variable, depth: depth_m, time: timeIdx, bbox,
        }, this.abortController.signal)

        if (myToken !== this.requestToken) return   // a newer selection superseded this one

        // The real answer for this request is now known (data, nothing, or an error) — a
        // late-arriving preview crop for it must no longer touch the mesh.
        this.realLandedToken = myToken

        const [latSize, lonSize] = header.shape
        // Degenerate grid → the backend has no data covering this bbox (common offline: a
        // drag/click outside the pre-cached fixture extent). The backend still 200s with a
        // 0-width array; applying it either throws or shows a broken/stale overlay. Bail and
        // let the UI say "no data for this region" instead.
        if (lonSize < 2 || latSize < 2 || data.length < lonSize * latSize) {
          this.clearData()
          useTarangStore.getState().setRegionDataMissing(true)
          return
        }

        this.isPreview = false
        this.applyGrid(
          data, lonSize, latSize, header.bounds,
          header.missing_value, header.valid_min, header.valid_max,
        )
        useTarangStore.getState().setRegionDataMissing(false)
      } catch (err: any) {
        if (err.name === 'AbortError') {
          // Ignore aborts — a newer selection cancelled this one.
        } else {
          console.error("DepthSliceLayer fetch error:", err)
          if (myToken === this.requestToken) {
            this.realLandedToken = myToken
            this.clearData()
            useTarangStore.getState().setRegionDataMissing(true)
          }
        }
      }
    }
  }

  // Drop the current overlay entirely — used when a region change lands somewhere with no
  // usable slice data (offline + nothing cached for that bbox, or a fetch error). Without this
  // the previous region's texture stays on screen: markers and the outline box update but the
  // coloured overlay still shows the old landmass, which reads as "wrong data", not "no data".
  private clearData() {
    this.hasData = false
    this.isPreview = false
    if (this.mesh) this.mesh.visible = false
    if (this.texture) { this.texture.dispose(); this.texture = null }
    if (this.material) this.material.uniforms.u_data.value = null
  }

  setVisible(visible: boolean) {
    this.wantVisible = visible
    if (this.mesh) this.mesh.visible = visible && this.hasData
  }

  dispose() {
    if (this.abortController) this.abortController.abort()
    if (this.mesh && this.scene) {
      this.scene.remove(this.mesh)
    }
    if (this.mesh?.geometry) this.mesh.geometry.dispose()
    if (this.material) this.material.dispose()
    if (this.texture) this.texture.dispose()
  }
}
