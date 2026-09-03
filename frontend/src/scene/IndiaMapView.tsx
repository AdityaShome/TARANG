import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

import { useTarangStore } from '../state/store'
import { fetchSlice, fetchInstruments, fetchProfile } from '../api/client'
import { fetchEddyDetection, fetchFrontDetection } from '../api/eddy'
import { clampRegionSpan, REGION_MAX_PICK_SPAN_DEG } from '../api/geocode'
import { computeDataRange } from './layers/dataStats'
import { PALETTES, samplePalette } from './colormaps'
import { fetchWaterMasses, WATER_MASS_COLORS } from '../api/derived'
import { startFlowField, type FlowFieldHandle } from './flowField'
import landGeo from '../assets/ne_110m_land.json'

// Independent overlays share the globe's conventions: currents from a currents source, eddies
// from a model source with u/v — NOT the active scalar "Data Source".
// Vectors + animated flow: Copernicus Marine uo/vo (40 depth levels) so they track the depth
// slider through the water column. Eddies stay on INCOIS NIO-HOOFS (surface diagnostic).
const VECTOR_SOURCE = 'copernicus_marine'
const EDDY_SOURCE = 'incois_ocean'
const EDDY_COLORS: Record<string, string> = { warm: '#ff8c00', cold: '#00e5ff', front: '#ffd700' }

/**
 * IndiaMapView — the "India" view scope: a dedicated flat (equirectangular) map of the
 * Arabian Sea + Bay of Bengal, NOT the 3D globe. Renders exactly the same store-driven data
 * as the globe's DepthSliceLayer / InstrumentMarkerLayer (slice overlay + instrument markers +
 * the searched-region box), but click/drag region picking is done in 2D pixel space — no sphere
 * raycasting — so it is reliable. Volume/Iso still open the shared VolumeIsoWorkspace modal.
 *
 * "Globe" scope renders <SceneManager/> instead (see ForecasterConsole).
 */

// The map's home extent — the Arabian Sea + Bay of Bengal (a touch wider than the EEZ so the
// basins don't look clipped). fitBounds adds its own small padding.
const INDIA_BOUNDS = L.latLngBounds([-4, 50], [30, 102])
// The India-ocean area of interest, drawn as a persistent reference frame on the map.
const INDIA_AOI: L.LatLngBoundsExpression = [[-2, 55], [26, 100]]

// Palette stops come from scene/colormaps.ts — one source of truth shared with the
// globe shaders and the HTML legend.

// Slice grid (lat,lon row-major, row 0 = south) → RGBA canvas (row 0 = north). Land / missing
// cells render transparent so the basemap land shows through.
function gridToDataURL(
  data: Float32Array, lonSize: number, latSize: number,
  missing: number, min: number, max: number, paletteName: string, reversed: boolean,
): string {
  const stops = PALETTES[paletteName as keyof typeof PALETTES] ?? PALETTES.viridis
  const canvas = document.createElement('canvas')
  canvas.width = lonSize
  canvas.height = latSize
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(lonSize, latSize)
  const missTol = Math.abs(missing) * 0.01 + 1e-6
  const span = max - min || 1
  for (let y = 0; y < latSize; y++) {
    const srcRow = (latSize - 1 - y) * lonSize   // flip: south→bottom
    for (let x = 0; x < lonSize; x++) {
      const v = data[srcRow + x]
      const di = (y * lonSize + x) * 4
      if (!Number.isFinite(v) || Math.abs(v - missing) < missTol || v < -1e4 || v > 1e4) {
        img.data[di + 3] = 0
        continue
      }
      const norm = (v - min) / span
      const [r, g, b] = samplePalette(stops, reversed ? 1 - norm : norm)
      img.data[di] = r; img.data[di + 1] = g; img.data[di + 2] = b; img.data[di + 3] = 235
    }
  }
  ctx.putImageData(img, 0, 0)
  return canvas.toDataURL()
}

export function IndiaMapView() {
  const mountRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const overlayRef = useRef<L.ImageOverlay | null>(null)
  const boxRef = useRef<L.Rectangle | null>(null)
  const markersRef = useRef<L.LayerGroup | null>(null)
  const dragPreviewRef = useRef<L.Rectangle | null>(null)
  const sliceAbortRef = useRef<AbortController | null>(null)
  const markerAbortRef = useRef<AbortController | null>(null)
  const overlaysRef = useRef<L.LayerGroup | null>(null)
  const overlaysRendererRef = useRef<L.SVG | null>(null)
  const overlaysAbortRef = useRef<AbortController | null>(null)
  const waterMassOverlayRef = useRef<L.ImageOverlay | null>(null)
  const waterMassLegendRef = useRef<L.Control | null>(null)
  const waterMassAbortRef = useRef<AbortController | null>(null)
  const flowRef = useRef<FlowFieldHandle | null>(null)
  const flowCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const flowAbortRef = useRef<AbortController | null>(null)

  const bbox = useTarangStore(s => s.bbox)
  const hasSearchedRegion = useTarangStore(s => s.hasSearchedRegion)
  const activeSourceId = useTarangStore(s => s.activeSourceId)
  const activeVar = useTarangStore(s => s.activeVar)
  const activeDepthIdx = useTarangStore(s => s.activeDepthIdx)
  const activeTimeIdx = useTarangStore(s => s.activeTimeIdx)
  const colormapName = useTarangStore(s => s.colormap.name)
  const colormapReversed = useTarangStore(s => s.colormap.reversed)
  const layerVisibility = useTarangStore(s => s.layerVisibility)
  const instrumentColors = useTarangStore(s => s.instrumentColors)
  const selectedPlatformId = useTarangStore(s => s.selectedPlatformId)
  const renderMode = useTarangStore(s => s.renderMode)

  // ── Mount: build the map + pick handlers ────────────────────────────────
  useEffect(() => {
    const el = mountRef.current
    if (!el) return

    const map = L.map(el, {
      crs: L.CRS.EPSG4326,
      center: [12, 78],
      zoom: 4,
      minZoom: 3,
      maxZoom: 8,
      zoomControl: true,
      attributionControl: false,
      maxBounds: [[-18, 40], [42, 108]],
      maxBoundsViscosity: 0.85,
      worldCopyJump: false,
    })
    mapRef.current = map
    map.fitBounds(INDIA_BOUNDS)

    map.createPane('land')
    map.getPane('land')!.style.zIndex = '250'
    map.createPane('data')
    map.getPane('data')!.style.zIndex = '350'
    map.createPane('overlays')
    map.getPane('overlays')!.style.zIndex = '450'   // above the slice raster, below instrument markers
    // Path layers only honour a custom `pane` if they render through a renderer bound to it.
    overlaysRendererRef.current = L.svg({ pane: 'overlays' })
    map.addLayer(overlaysRendererRef.current)
    overlaysRef.current = L.layerGroup().addTo(map)

    L.geoJSON(landGeo as any, {
      pane: 'land',
      style: { fillColor: '#1b2a3d', fillOpacity: 1, color: '#41607f', weight: 1 },
      interactive: false,
    }).addTo(map)

    // Persistent India-ocean reference frame — makes the mode read as a bounded map, not a
    // borderless slab.
    L.rectangle(INDIA_AOI, {
      color: '#2f6d97', weight: 1.5, dashArray: '6 6', fill: false, interactive: false,
    }).addTo(map)

    markersRef.current = L.layerGroup().addTo(map)

    // ── Click / drag region picking (2D — no raycast) ────────────────────
    const PICK_HALF_SPAN = 12   // → a 24° box, same as the globe's click pick

    function boxAround(lat: number, lon: number, half: number): [number, number, number, number] {
      return [
        Math.max(lon - half, -180), Math.max(lat - half, -90),
        Math.min(lon + half, 180), Math.min(lat + half, 90),
      ]
    }
    function clearDragPreview() {
      if (dragPreviewRef.current) { dragPreviewRef.current.remove(); dragPreviewRef.current = null }
    }

    function onMapClick(e: L.LeafletMouseEvent) {
      if (useTarangStore.getState().mapSelectMode !== 'click') return
      const { lat, lng } = e.latlng
      useTarangStore.getState().searchRegion(
        clampRegionSpan(boxAround(lat, lng, PICK_HALF_SPAN), REGION_MAX_PICK_SPAN_DEG),
        `Custom point (${lat.toFixed(1)}, ${lng.toFixed(1)})`,
      )
      useTarangStore.getState().setMapSelectMode('off')
    }

    let dragStart: L.LatLng | null = null
    function onMouseDown(e: L.LeafletMouseEvent) {
      if (useTarangStore.getState().mapSelectMode !== 'drag') return
      dragStart = e.latlng
      map.dragging.disable()
    }
    function onMouseMove(e: L.LeafletMouseEvent) {
      if (!dragStart) return
      const b = L.latLngBounds(dragStart, e.latlng)
      if (dragPreviewRef.current) dragPreviewRef.current.setBounds(b)
      else dragPreviewRef.current = L.rectangle(b, { color: '#00d4ff', weight: 1.5, dashArray: '4 4', fill: false }).addTo(map)
    }
    function onMouseUp(e: L.LeafletMouseEvent) {
      if (!dragStart) return
      const a = dragStart, c = e.latlng
      dragStart = null
      map.dragging.enable()
      clearDragPreview()
      const raw: [number, number, number, number] = [
        Math.min(a.lng, c.lng), Math.min(a.lat, c.lat), Math.max(a.lng, c.lng), Math.max(a.lat, c.lat),
      ]
      const region = (raw[2] - raw[0] < 0.5 || raw[3] - raw[1] < 0.5)
        ? boxAround(c.lat, c.lng, PICK_HALF_SPAN)             // barely moved → treat as a click
        : clampRegionSpan(raw, REGION_MAX_PICK_SPAN_DEG)
      const cLat = (region[1] + region[3]) / 2, cLon = (region[0] + region[2]) / 2
      useTarangStore.getState().searchRegion(region, `Custom region (${cLat.toFixed(1)}, ${cLon.toFixed(1)})`)
      useTarangStore.getState().setMapSelectMode('off')
    }

    map.on('click', onMapClick)
    map.on('mousedown', onMouseDown)
    map.on('mousemove', onMouseMove)
    map.on('mouseup', onMouseUp)

    // Keep the cursor honest while a pick mode is armed.
    const unsub = useTarangStore.subscribe(s => s.mapSelectMode, (mode) => {
      el.style.cursor = mode === 'off' ? '' : 'crosshair'
    })

    return () => {
      unsub()
      map.off('click', onMapClick)
      map.off('mousedown', onMouseDown)
      map.off('mousemove', onMouseMove)
      map.off('mouseup', onMouseUp)
      sliceAbortRef.current?.abort()
      markerAbortRef.current?.abort()
      overlaysAbortRef.current?.abort()
      map.remove()
      mapRef.current = null
      overlayRef.current = null
      boxRef.current = null
      markersRef.current = null
      overlaysRef.current = null
    }
  }, [])

  // ── Slice overlay — re-render on any slice input change ─────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    if (!hasSearchedRegion || !activeVar || renderMode !== 'slice' || !layerVisibility['slice']) {
      if (overlayRef.current) { overlayRef.current.remove(); overlayRef.current = null }
      return
    }

    sliceAbortRef.current?.abort()
    const ctl = new AbortController()
    sliceAbortRef.current = ctl

    const depthM = useTarangStore.getState().depthLevels[activeDepthIdx] ?? 0

    ;(async () => {
      // One retry on a transient failure (a 5xx from the 2-worker backend under load) before
      // concluding "no data" — a network hiccup shouldn't flip the map to the empty state.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const { header, data } = await fetchSlice(
            { source: activeSourceId, var: activeVar, depth: depthM, time: activeTimeIdx, bbox },
            ctl.signal,
          )
          if (ctl.signal.aborted) return
          const [latSize, lonSize] = header.shape
          if (lonSize < 2 || latSize < 2 || data.length < lonSize * latSize) {
            // Genuinely no data covering this bbox (200 with a 0-width grid) — clear the overlay
            // and let the UI say so (same contract as DepthSliceLayer on the globe).
            if (overlayRef.current) { overlayRef.current.remove(); overlayRef.current = null }
            useTarangStore.getState().setRegionDataMissing(true)
            return
          }
          const [dMin, dMax] = computeDataRange(data, header.missing_value, header.valid_min, header.valid_max)
          useTarangStore.getState().setColormap({ min: dMin, max: dMax })
          useTarangStore.getState().setRegionDataMissing(false)

          const url = gridToDataURL(data, lonSize, latSize, header.missing_value, dMin, dMax, colormapName, colormapReversed)
          const b = L.latLngBounds([header.bounds.lat[0], header.bounds.lon[0]], [header.bounds.lat[1], header.bounds.lon[1]])
          if (overlayRef.current) overlayRef.current.remove()
          overlayRef.current = L.imageOverlay(url, b, { pane: 'data', opacity: 0.92, interactive: false }).addTo(map)
          return
        } catch (err: any) {
          if (err?.name === 'AbortError' || ctl.signal.aborted) return
          if (attempt === 0) { await new Promise(r => setTimeout(r, 1500)); continue }
          console.error('IndiaMapView slice error:', err)
          if (overlayRef.current) { overlayRef.current.remove(); overlayRef.current = null }
          useTarangStore.getState().setRegionDataMissing(true)
        }
      }
    })()
  // colormapName / colormapReversed included so a palette change re-renders the raster
  }, [bbox, hasSearchedRegion, activeSourceId, activeVar, activeDepthIdx, activeTimeIdx, colormapName, colormapReversed, layerVisibility, renderMode])

  // ── Region box + instrument markers ────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    // boundary rectangle
    if (boxRef.current) { boxRef.current.remove(); boxRef.current = null }
    if (hasSearchedRegion) {
      const [minLon, minLat, maxLon, maxLat] = bbox
      boxRef.current = L.rectangle([[minLat, minLon], [maxLat, maxLon]], {
        color: '#00d4ff', weight: 2, fill: false, interactive: false,
      }).addTo(map)
      // Frame the region, but keep generous surrounding context and a modest max zoom so a
      // small open-ocean pick never fills the view with empty background.
      map.fitBounds([[minLat, minLon], [maxLat, maxLon]], { padding: [130, 130], maxZoom: 5, animate: true })
    } else {
      map.fitBounds(INDIA_BOUNDS)
    }

    // markers
    const group = markersRef.current
    if (!group) return
    group.clearLayers()
    if (!hasSearchedRegion || !layerVisibility['markers']) {
      useTarangStore.getState().setInstrumentsInView([])
      return
    }

    markerAbortRef.current?.abort()
    const ctl = new AbortController()
    markerAbortRef.current = ctl
    fetchInstruments({ bbox }, ctl.signal)
      .then(({ instruments }) => {
        if (ctl.signal.aborted) return
        const colors = useTarangStore.getState().instrumentColors
        const selId = useTarangStore.getState().selectedPlatformId
        const counts = new Map<string, number>()
        for (const inst of instruments) {
          counts.set(inst.type, (counts.get(inst.type) ?? 0) + 1)
          const isSel = inst.platform_id === selId
          L.circleMarker([inst.lat, inst.lon], {
            radius: isSel ? 9 : 4,
            fillColor: colors[inst.type] ?? colors.other ?? '#ffffff',
            color: isSel ? '#ffffff' : '#04121f',
            weight: isSel ? 2.5 : 1,
            fillOpacity: 0.95,
          })
            .on('click', () => useTarangStore.getState().setSelectedPlatform(inst.platform_id))
            .addTo(group)
        }
        useTarangStore.getState().setInstrumentsInView(
          [...counts.entries()].map(([type, count]) => ({ type, count })),
        )

        // Draw a surface current arrow at each ADCP / mooring station from its own
        // profile — the PS asks for ADCP shown as a current-vector, not just a dot.
        const currentStations = instruments.filter(i => i.type === 'adcp' || i.type === 'mooring').slice(0, 16)
        for (const st of currentStations) {
          fetchProfile(st.platform_id, undefined, undefined, ctl.signal)
            .then(p => {
              if (ctl.signal.aborted) return
              const u = p.current_u?.[0], v = p.current_v?.[0]
              if (u == null || v == null) return
              const spd = Math.hypot(u, v)
              if (spd < 1e-3) return
              const ang = Math.atan2(v, u)
              const len = Math.min(1.2, 0.3 + spd * 2.2)   // degrees
              const tip: [number, number] = [st.lat + Math.sin(ang) * len, st.lon + Math.cos(ang) * len]
              const barb = len * 0.35
              group.addLayer(L.polyline([
                [st.lat, st.lon], tip,
                [tip[0] - Math.sin(ang - 0.5) * barb, tip[1] - Math.cos(ang - 0.5) * barb], tip,
                [tip[0] - Math.sin(ang + 0.5) * barb, tip[1] - Math.cos(ang + 0.5) * barb],
              ], { color: colors[st.type] ?? '#b388ff', weight: 2, opacity: 0.95, interactive: false }))
            })
            .catch(() => { /* station without a current profile — just leave the dot */ })
        }
      })
      .catch(err => { if (err?.name !== 'AbortError') console.error(err) })
  }, [bbox, hasSearchedRegion, layerVisibility, instrumentColors, selectedPlatformId])

  // ── Current vectors / fronts / eddies — the same overlays the globe has ─
  useEffect(() => {
    const group = overlaysRef.current
    if (!group) return
    group.clearLayers()
    overlaysAbortRef.current?.abort()
    if (!hasSearchedRegion) return

    const ctl = new AbortController()
    overlaysAbortRef.current = ctl
    const rend = overlaysRendererRef.current ?? undefined
    const [minLon, minLat, maxLon, maxLat] = bbox
    const lonSpan = maxLon - minLon, latSpan = maxLat - minLat

    // Retry once on a transient 5xx (2-worker backend under load) before giving up on an overlay.
    const retry = async <T,>(fn: () => Promise<T>): Promise<T> => {
      try { return await fn() }
      catch (e: any) {
        if (ctl.signal.aborted || e?.name === 'AbortError') throw e
        await new Promise(r => setTimeout(r, 1400))
        return await fn()
      }
    }

    // Run the overlays sequentially, not in parallel — 4+ concurrent heavy fetches 502 the backend.
    void (async () => {
    if (layerVisibility['vectors']) {
      const vDepthM = useTarangStore.getState().depthLevels[activeDepthIdx] ?? 0
      await retry(() => Promise.all([
        fetchSlice({ source: VECTOR_SOURCE, var: 'uo', depth: vDepthM, time: activeTimeIdx, bbox }, ctl.signal),
        fetchSlice({ source: VECTOR_SOURCE, var: 'vo', depth: vDepthM, time: activeTimeIdx, bbox }, ctl.signal),
      ])).then(([uR, vR]) => {
        if (ctl.signal.aborted) return
        const [latN, lonN] = uR.header.shape
        const u = uR.data, v = vR.data
        const [loA, loB] = uR.header.bounds.lon, [laA, laB] = uR.header.bounds.lat
        // aim for ~12 arrows across each axis, regardless of the source grid resolution
        const stepJ = Math.max(1, Math.ceil(lonN / 12))
        const stepI = Math.max(1, Math.ceil(latN / 12))
        const cellDeg = Math.min(lonSpan / lonN * stepJ, latSpan / latN * stepI)
        for (let i = 0; i < latN; i += stepI) {
          for (let j = 0; j < lonN; j += stepJ) {
            const uu = u[i * lonN + j], vv = v[i * lonN + j]
            const spd = Math.hypot(uu, vv)
            if (!isFinite(spd) || spd < 1e-3 || spd > 50) continue
            const lat = laA + (laB - laA) * (i / Math.max(1, latN - 1))
            const lon = loA + (loB - loA) * (j / Math.max(1, lonN - 1))
            const ang = Math.atan2(vv, uu)   // vv = north, uu = east
            const len = Math.min(cellDeg * 0.95, cellDeg * (0.35 + spd * 10))
            const tip: [number, number] = [lat + Math.sin(ang) * len, lon + Math.cos(ang) * len]
            const barb = len * 0.4
            group.addLayer(L.polyline([
              [lat, lon], tip,
              [tip[0] - Math.sin(ang - 0.5) * barb, tip[1] - Math.cos(ang - 0.5) * barb], tip,
              [tip[0] - Math.sin(ang + 0.5) * barb, tip[1] - Math.cos(ang + 0.5) * barb],
            ], { color: '#00e5ff', weight: 1.3, opacity: 0.8, pane: 'overlays', renderer: rend, interactive: false }))
          }
        }
      }).catch((e: any) => { if (e?.name !== 'AbortError') console.warn('vectors:', e?.message) })
    }

    if (layerVisibility['fronts'] && activeVar) {
      await retry(() => fetchFrontDetection({ source: activeSourceId, var: activeVar, time: activeTimeIdx, bbox }, ctl.signal))
        .then(cells => {
          if (ctl.signal.aborted) return
          const stride = Math.max(1, Math.ceil(cells.length / 400))   // cap the dots
          for (let k = 0; k < cells.length; k += stride) {
            const c = cells[k]
            group.addLayer(L.circleMarker([c.lat, c.lon], {
              radius: 1.6, color: '#ff3df5', weight: 0, fillColor: '#ff3df5', fillOpacity: 0.75,
              pane: 'overlays', renderer: rend, interactive: false,
            }))
          }
        }).catch((e: any) => { if (e?.name !== 'AbortError') console.warn('fronts:', e?.message) })
    }

    if (layerVisibility['eddy']) {
      await retry(() => fetchEddyDetection({ source: EDDY_SOURCE, time: activeTimeIdx, bbox }, ctl.signal))
        .then(cells => {
          if (ctl.signal.aborted) return
          for (const c of cells) {
            const rKm = Math.max(30, Math.min(250, (c as any).radius_km || 60))
            group.addLayer(L.circle([c.lat, c.lon], {
              radius: rKm * 1000,   // metres
              color: EDDY_COLORS[c.type] ?? '#fff', weight: 2, fillColor: EDDY_COLORS[c.type],
              fillOpacity: 0.08, opacity: 0.9, pane: 'overlays', renderer: rend, interactive: false,
            }))
          }
        }).catch((e: any) => { if (e?.name !== 'AbortError') console.warn('eddies:', e?.message) })
    }
    })()
  }, [bbox, hasSearchedRegion, activeSourceId, activeVar, activeTimeIdx, activeDepthIdx, layerVisibility])

  // ── Water-mass classification overlay (derived ML product) ─────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    const clear = () => {
      if (waterMassOverlayRef.current) { waterMassOverlayRef.current.remove(); waterMassOverlayRef.current = null }
      if (waterMassLegendRef.current) { waterMassLegendRef.current.remove(); waterMassLegendRef.current = null }
    }
    waterMassAbortRef.current?.abort()
    if (!hasSearchedRegion || !layerVisibility['waterMasses']) { clear(); return }

    const ctl = new AbortController()
    waterMassAbortRef.current = ctl
    const depthM = useTarangStore.getState().depthLevels[activeDepthIdx] ?? 0

    fetchWaterMasses({ source: activeSourceId, time: activeTimeIdx, depth: depthM, bbox, k: 4 }, ctl.signal)
      .then(res => {
        if (ctl.signal.aborted) return
        clear()
        const [latN, lonN] = res.shape
        const canvas = document.createElement('canvas')
        canvas.width = lonN; canvas.height = latN
        const ctx = canvas.getContext('2d')!
        const img = ctx.createImageData(lonN, latN)
        for (let y = 0; y < latN; y++) {
          const srcRow = (latN - 1 - y) * lonN   // flip south→bottom
          for (let x = 0; x < lonN; x++) {
            const lbl = res.labels[srcRow + x]
            const di = (y * lonN + x) * 4
            if (lbl < 0) { img.data[di + 3] = 0; continue }
            const hex = WATER_MASS_COLORS[lbl % WATER_MASS_COLORS.length]
            img.data[di] = parseInt(hex.slice(1, 3), 16)
            img.data[di + 1] = parseInt(hex.slice(3, 5), 16)
            img.data[di + 2] = parseInt(hex.slice(5, 7), 16)
            img.data[di + 3] = 200
          }
        }
        ctx.putImageData(img, 0, 0)
        const [loA, loB] = res.bounds.lon, [laA, laB] = res.bounds.lat
        waterMassOverlayRef.current = L.imageOverlay(canvas.toDataURL(), [[laA, loA], [laB, loB]], {
          pane: 'data', opacity: 0.75, interactive: false,
        }).addTo(map)

        const legend = new L.Control({ position: 'bottomright' })
        legend.onAdd = () => {
          const div = L.DomUtil.create('div')
          div.style.cssText = 'background:rgba(8,15,30,0.85);padding:8px 10px;border-radius:8px;color:#cfe;font:11px Inter,sans-serif;border:1px solid rgba(0,180,255,0.3)'
          div.innerHTML = `<b style="color:#00d4ff">Water masses (k-means)</b><br/>` +
            res.centroids.map(c =>
              `<span style="display:inline-block;width:10px;height:10px;background:${WATER_MASS_COLORS[c.label % WATER_MASS_COLORS.length]};margin-right:5px;border-radius:2px"></span>` +
              `${c.temperature.toFixed(1)}°C / ${c.salinity.toFixed(1)} PSU · ${(c.fraction * 100).toFixed(0)}%`
            ).join('<br/>')
          return div
        }
        legend.addTo(map)
        waterMassLegendRef.current = legend
      })
      .catch((e: any) => { if (e?.name !== 'AbortError') console.warn('water_masses:', e?.message) })

    return () => { ctl.abort() }
  }, [bbox, hasSearchedRegion, activeSourceId, activeDepthIdx, activeTimeIdx, layerVisibility])

  // ── Animated current-flow layer (particle advection over uo/vo) ────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    let zooming = false
    const onZoomStart = () => { zooming = true }
    const onZoomEnd = () => { zooming = false; flowRef.current?.resize() }
    const onResize = () => flowRef.current?.resize()

    const teardown = () => {
      flowAbortRef.current?.abort()
      flowRef.current?.stop(); flowRef.current = null
      map.off('zoomstart', onZoomStart); map.off('zoomend', onZoomEnd); map.off('resize', onResize)
      if (flowCanvasRef.current) { flowCanvasRef.current.remove(); flowCanvasRef.current = null }
    }
    teardown()
    if (!hasSearchedRegion || !layerVisibility['flow']) return

    const ctl = new AbortController()
    flowAbortRef.current = ctl
    const depthM = useTarangStore.getState().depthLevels[activeDepthIdx] ?? 0

    Promise.all([
      fetchSlice({ source: VECTOR_SOURCE, var: 'uo', depth: depthM, time: activeTimeIdx, bbox }, ctl.signal),
      fetchSlice({ source: VECTOR_SOURCE, var: 'vo', depth: depthM, time: activeTimeIdx, bbox }, ctl.signal),
    ]).then(([uR, vR]) => {
      if (ctl.signal.aborted) return
      const [nlat, nlon] = uR.header.shape
      const [lonA, lonB] = uR.header.bounds.lon
      const [latA, latB] = uR.header.bounds.lat

      const canvas = document.createElement('canvas')
      canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:440'
      map.getContainer().appendChild(canvas)
      flowCanvasRef.current = canvas

      map.on('zoomstart', onZoomStart); map.on('zoomend', onZoomEnd); map.on('resize', onResize)

      flowRef.current = startFlowField({
        canvas,
        grid: { u: uR.data, v: vR.data, nlat, nlon, lonA, lonB, latA, latB },
        project: (lat, lon) => {
          const p = map.latLngToContainerPoint([lat, lon])
          return { x: p.x, y: p.y }
        },
        paused: () => zooming,
      })
    }).catch((e: any) => { if (e?.name !== 'AbortError') console.warn('flow:', e?.message) })

    return teardown
  }, [bbox, hasSearchedRegion, activeTimeIdx, activeDepthIdx, layerVisibility])

  return <div ref={mountRef} id="india-map" style={{ position: 'absolute', inset: 0, background: '#04121f' }} />
}
