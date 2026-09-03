import React, { useMemo, useState, useEffect } from 'react'
import { useTarangStore, debounce } from '../state/store'
import { useT } from '../i18n/useT'
import type { TranslationKey } from '../i18n/translations'
import { colormapGradientCSS } from '../scene/colormaps'
import { fetchSources, uploadDataSource } from '../api/client'
import { prewarmTimeSteps } from '../api/prewarm'

// Grouped so the dropdown reads as a curated set, not a dump. cmocean palettes are
// the oceanography-standard choice (thermal→temperature, haline→salinity,
// balance/curl→anomalies, deep→depth); matplotlib set kept for familiarity.
const PALETTE_GROUPS: { label: string; names: string[] }[] = [
  { label: 'Ocean (cmocean)', names: ['thermal', 'haline', 'deep', 'dense', 'ice'] },
  { label: 'Diverging (anomalies)', names: ['balance', 'curl'] },
  { label: 'Perceptual', names: ['viridis', 'plasma', 'magma', 'inferno'] },
  { label: 'Other', names: ['jet', 'grayscale'] },
]

/**
 * ControlPanel — Container for all Forecaster Console controls.
 * Dispatches to the central Zustand store. Nothing here touches Three.js directly.
 */
export function ControlPanel() {
  const {
    sources, activeSourceId, setActiveSource,
    activeVar, setActiveVar, availableVariables, cfMetadata,
    activeDepthIdx, setActiveDepthIdx, depthLevels,
    activeTimeIdx, setActiveTimeIdx, timeSteps,
    renderMode, setRenderMode,
    isoThreshold, setIsoThreshold,
    colormap, setColormap, setColormapName,
    layerVisibility, toggleLayer,
    dataSourceMode, setDataSourceMode,
    setSources,
  } = useTarangStore()
  const t = useT()

  // Download the current source/variable, clipped to the searched region + time step,
  // as a CF-NetCDF via the OGC WCS GetCoverage endpoint (RangeSubset picks the variable).
  const [dl, setDl] = useState<{ busy: boolean; msg: string; err: boolean }>({ busy: false, msg: '', err: false })
  async function downloadCurrentView() {
    const bbox = useTarangStore.getState().bbox
    const [minLon, minLat, maxLon, maxLat] = bbox
    const qs = new URLSearchParams({
      SERVICE: 'WCS', VERSION: '2.0.1', REQUEST: 'GetCoverage',
      COVERAGEID: activeSourceId,
      RANGESUBSET: activeVar,
      'SUBSET[latitude]': `(${minLat},${maxLat})`,
      'SUBSET[longitude]': `(${minLon},${maxLon})`,
      'SUBSET[time]': `(${activeTimeIdx},${activeTimeIdx})`,
    })
    const base = import.meta.env.VITE_API_BASE_URL || '/api'
    setDl({ busy: true, msg: 'Preparing NetCDF…', err: false })
    try {
      const res = await fetch(`${base}/wcs?${qs}`)
      if (!res.ok) throw new Error(`server returned ${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${activeSourceId}_${activeVar}_t${activeTimeIdx}.nc`
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 4000)
      setDl({ busy: false, err: false, msg: `Downloaded ${(blob.size / 1024).toFixed(0)} KB` })
    } catch (e: any) {
      setDl({ busy: false, err: true, msg: `Download failed: ${e?.message || e}` })
    }
  }

  // ── Upload a NetCDF/CSV → new registry source ──────────────────────────────
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const [uploadState, setUploadState] = useState<{ busy: boolean; msg: string; err: boolean }>({
    busy: false, msg: '', err: false,
  })

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''  // allow re-selecting the same file later
    if (!file) return
    setUploadState({ busy: true, msg: `Uploading ${file.name}…`, err: false })
    try {
      const res = await uploadDataSource(file)
      setSources(await fetchSources())
      setActiveSource(res.id)
      setUploadState({
        busy: false, err: false,
        msg: `Added “${res.id}” — ${res.variable}, ${res.render_type}${res.depth_levels.length ? `, ${res.depth_levels.length} levels` : ''}`,
      })
    } catch (err: any) {
      setUploadState({ busy: false, err: true, msg: err?.message || 'Upload failed' })
    }
  }

  // Debounced depth/time slider handlers (150ms — §10)
  const debouncedDepth = useMemo(() => debounce(setActiveDepthIdx, 150), [])

  // Variable dropdown options, labelled with CF long_name + units when available.
  const variableOptions = useMemo(() => {
    const names = availableVariables.length ? availableVariables : (activeVar ? [activeVar] : [])
    return names.map(v => {
      const cf = cfMetadata[v]
      const label = cf?.long_name && cf.long_name !== v
        ? (cf.units && cf.units !== 'unknown' ? `${cf.long_name} (${cf.units})` : cf.long_name)
        : v
      return { value: v, label }
    })
  }, [availableVariables, cfMetadata, activeVar])
  const [isPlaying, setIsPlaying] = useState(false)

  // isoThreshold has no per-variable meaning on its own — a leftover threshold from a
  // temperature source (e.g. 20°C) is nonsensical for salinity (~28-36 PSU) or any other unit
  // range, and marching_cubes degenerates to a box/grid hugging the whole domain boundary when
  // the threshold sits entirely outside the actual data. Reset it (and seed colormap bounds as
  // an initial hint — DepthSliceLayer/VolumeLayer auto-stretch to real fetched data afterward)
  // to the midpoint of the now-active variable's real range whenever it changes, not just once
  // at bootstrap, since the variable dropdown lets the user switch at any time.
  useEffect(() => {
    const varMeta = cfMetadata[activeVar]
    if (!varMeta) return
    setColormap({ min: varMeta.valid_min, max: varMeta.valid_max })
    setIsoThreshold((varMeta.valid_min + varMeta.valid_max) / 2)
  }, [activeVar, cfMetadata, setColormap, setIsoThreshold])

  useEffect(() => {
    let interval: any
    if (isPlaying) {
      // Warm every frame in the background so playback advances into cached data.
      prewarmTimeSteps({
        source: activeSourceId,
        variable: activeVar,
        depth: depthLevels[activeDepthIdx] ?? 0,
        bbox: useTarangStore.getState().bbox,
        nSteps: timeSteps.length,
      })
      interval = setInterval(() => {
        if (timeSteps.length > 0) {
          const nextIdx = (activeTimeIdx + 1) % timeSteps.length
          setActiveTimeIdx(nextIdx)
        }
      }, 600)
    }
    return () => clearInterval(interval)
  }, [isPlaying, activeTimeIdx, timeSteps.length, setActiveTimeIdx, activeSourceId, activeVar, activeDepthIdx, depthLevels])

  const activeDepthM = depthLevels[activeDepthIdx] ?? 0

  return (
    <div id="control-panel-inner" style={styles.panel}>

      {/* ── Data Source Mode Toggle ─────────────────────────────────── */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
        <button
          id="mode-toggle-live"
          style={{
            flex: 1, padding: '8px', cursor: 'pointer',
            background: dataSourceMode === 'live' ? 'rgba(255, 51, 51, 0.2)' : 'transparent',
            color: dataSourceMode === 'live' ? '#ff3333' : '#666',
            border: `1px solid ${dataSourceMode === 'live' ? '#ff3333' : '#444'}`,
            borderRadius: '4px',
            fontWeight: 'bold', letterSpacing: '2px',
            textShadow: dataSourceMode === 'live' ? '0 0 10px rgba(255,51,51,0.8)' : 'none',
            boxShadow: dataSourceMode === 'live' ? 'inset 0 0 10px rgba(255,51,51,0.2)' : 'none',
            transition: 'all 0.3s ease',
          }}
          onClick={() => setDataSourceMode('live')}
        >
          🔴 LIVE
        </button>
        <button
          id="mode-toggle-cached"
          style={{
            flex: 1, padding: '8px', cursor: 'pointer',
            background: dataSourceMode === 'cached' ? 'rgba(0, 229, 255, 0.2)' : 'transparent',
            color: dataSourceMode === 'cached' ? '#00e5ff' : '#666',
            border: `1px solid ${dataSourceMode === 'cached' ? '#00e5ff' : '#444'}`,
            borderRadius: '4px',
            fontWeight: 'bold', letterSpacing: '2px',
            textShadow: dataSourceMode === 'cached' ? '0 0 10px rgba(0,229,255,0.8)' : 'none',
            boxShadow: dataSourceMode === 'cached' ? 'inset 0 0 10px rgba(0,229,255,0.2)' : 'none',
            transition: 'all 0.3s ease',
          }}
          onClick={() => setDataSourceMode('cached')}
        >
          ⚡ CACHED
        </button>
      </div>

      {/* ── Source Selector ─────────────────────────────────────────── */}
      <Section label={t('dataSource')}>
        <Select
          id="source-select"
          value={activeSourceId}
          onChange={e => setActiveSource(e.target.value)}
          options={sources.map(s => ({ value: s.id, label: s.label }))}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept=".nc,.nc4,.cdf,.netcdf,.csv,.txt,.tsv,.dat"
          onChange={handleUpload}
          style={{ display: 'none' }}
        />
        <button
          id="add-source-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploadState.busy}
          style={{
            width: '100%', padding: '6px 10px', marginTop: '2px',
            background: 'rgba(0, 30, 60, 0.6)', border: '1px dashed rgba(0, 180, 255, 0.35)',
            borderRadius: '6px', color: '#a0c4e8', fontSize: '12px',
            cursor: uploadState.busy ? 'wait' : 'pointer',
          }}
        >
          {uploadState.busy ? '⏳ ' + uploadState.msg : `＋ ${t('addSource')}`}
        </button>
        {!uploadState.busy && uploadState.msg && (
          <div style={{ fontSize: '11px', color: uploadState.err ? '#ff6b6b' : '#4caf88', lineHeight: 1.4 }}>
            {uploadState.msg}
          </div>
        )}
      </Section>

      {/* Variable Selector — one entry per variable the source exposes; disabled if only one. */}
      <Section label={t('variable')}>
        <Select
          id="var-select"
          value={activeVar}
          disabled={variableOptions.length <= 1}
          onChange={e => setActiveVar(e.target.value)}
          options={variableOptions}
        />
      </Section>

      {/* ── Render Mode ─────────────────────────────────────────────── */}
      <Section label={t('renderMode')}>
        <div style={styles.toggleGroup}>
          {(['slice', 'volume', 'isosurface', 'cube'] as const).map(mode => (
            <button
              key={mode}
              id={`render-mode-${mode}`}
              style={{ ...styles.toggle, ...(renderMode === mode ? styles.toggleActive : {}) }}
              onClick={() => setRenderMode(mode)}
            >
              {mode === 'slice'
                ? `⧞ ${t('modeSlice')}`
                : mode === 'volume'
                ? `🧥 ${t('modeVolume')}`
                : mode === 'isosurface'
                ? `🔵 ${t('modeIso')}`
                : `🗳️ ${t('modeCube')}`}
            </button>
          ))}
        </div>
        {renderMode === 'isosurface' && (
          <LabeledInput
            label={`${t('threshold')}: ${isoThreshold.toFixed(1)}`}
            id="iso-threshold"
            type="range"
            min={colormap.min}
            max={colormap.max}
            step={0.5}
            value={isoThreshold}
            onChange={e => setIsoThreshold(Number(e.target.value))}
          />
        )}
      </Section>

      {/* ── Depth Slider ─────────────────────────────────────────────── */}
      <Section label={`${t('depth')}: ${activeDepthM} m`}>
        {/* Slider indexes into depth_levels[], never raw meters (§20 Rule 4) */}
        <input
          id="depth-slider"
          type="range"
          min={0}
          max={Math.max(0, depthLevels.length - 1)}
          step={1}
          value={activeDepthIdx}
          onChange={e => debouncedDepth(Number(e.target.value))}
          style={styles.slider}
        />
        <div style={styles.sliderLabels}>
          <span>{depthLevels[0] ?? 0} m</span>
          <span>{depthLevels[depthLevels.length - 1] ?? 0} m</span>
        </div>
      </Section>

      {/* ── Time Slider ──────────────────────────────────────────────── */}
      <Section label={`${t('timeStep')}: ${timeSteps[activeTimeIdx] ?? 'T+0'}${timeSteps.length > 1 ? `  (${activeTimeIdx + 1}/${timeSteps.length})` : ''}`}>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button 
            onClick={() => setIsPlaying(!isPlaying)}
            style={{ padding: '2px 8px', cursor: 'pointer', background: '#333', color: '#fff', border: '1px solid #555' }}
          >
            {isPlaying ? '⏸' : '▶'}
          </button>
          <input
            id="time-slider"
            type="range"
            min={0}
            max={Math.max(0, timeSteps.length - 1)}
            step={1}
            value={activeTimeIdx}
            onChange={e => setActiveTimeIdx(Number(e.target.value))}
            style={styles.slider}
          />
        </div>
        {timeSteps.length > 1 && (
          <div style={styles.sliderLabels}>
            <span>{timeSteps[0]}</span>
            <span>{timeSteps[timeSteps.length - 1]}</span>
          </div>
        )}
      </Section>

      {/* ── Colormap ─────────────────────────────────────────────────── */}
      <Section label={t('colormap')}>
        <select
          id="colormap-select"
          value={colormap.name}
          onChange={e => setColormapName(e.target.value as any)}
          style={styles.select}
        >
          {PALETTE_GROUPS.map(g => (
            <optgroup key={g.label} label={g.label} style={{ background: '#001e3c' }}>
              {g.names.map(n => (
                <option key={n} value={n} style={{ background: '#001e3c', color: '#a0c4e8' }}>
                  {n.charAt(0).toUpperCase() + n.slice(1)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {/* Live gradient preview — reflects palette choice + reverse toggle */}
        <div
          style={{
            height: '12px', borderRadius: '3px', marginTop: '2px',
            border: '1px solid rgba(255,255,255,0.15)',
            background: colormapGradientCSS(colormap.name, colormap.reversed, 'to right'),
          }}
        />
        <label style={styles.checkRow}>
          <input
            id="reverse-palette-toggle"
            type="checkbox"
            checked={colormap.reversed}
            onChange={() => setColormap({ reversed: !colormap.reversed })}
            style={{ accentColor: '#00d4ff' }}
          />
          <span style={{ color: '#a0c4e8', fontSize: '13px' }}>{t('reversePalette')}</span>
        </label>
        <label style={styles.checkRow}>
          <input
            id="log-scale-toggle"
            type="checkbox"
            checked={colormap.logScale}
            onChange={() => setColormap({ logScale: !colormap.logScale })}
            style={{ accentColor: '#00d4ff' }}
          />
          <span style={{ color: '#a0c4e8', fontSize: '13px' }}>{t('logScale')}</span>
        </label>
        <div style={styles.row}>
          <LabeledInput
            label={`${t('min')}: ${colormap.min.toFixed(1)}`}
            id="colormap-min"
            type="range"
            min={-5} max={colormap.max} step={0.5}
            value={colormap.min}
            onChange={e => setColormap({ min: Number(e.target.value) })}
          />
          <LabeledInput
            label={`${t('max')}: ${colormap.max.toFixed(1)}`}
            id="colormap-max"
            type="range"
            min={colormap.min} max={45} step={0.5}
            value={colormap.max}
            onChange={e => setColormap({ max: Number(e.target.value) })}
          />
        </div>
        <LabeledInput
          label={`${t('opacity')}: ${(colormap.opacity * 100).toFixed(0)}%`}
          id="opacity-slider"
          type="range"
          min={0.1} max={1} step={0.05}
          value={colormap.opacity}
          onChange={e => setColormap({ opacity: Number(e.target.value) })}
        />
        <LabeledInput
          label={`${t('vertExaggeration')}: ${colormap.verticalExaggeration}×`}
          id="vert-exag-slider"
          type="range"
          min={1} max={200} step={5}
          value={colormap.verticalExaggeration}
          onChange={e => setColormap({ verticalExaggeration: Number(e.target.value) })}
        />
      </Section>

      {/* ── Layer Visibility ─────────────────────────────────────────── */}
      <Section label={t('layers')}>
        {Object.entries(layerVisibility).map(([id, visible]) => (
          <label key={id} style={styles.checkRow}>
            <input
              id={`layer-${id}`}
              type="checkbox"
              checked={visible}
              onChange={() => toggleLayer(id)}
              style={{ accentColor: '#00d4ff' }}
            />
            <span style={{ color: '#a0c4e8', fontSize: '13px', textTransform: 'capitalize' }}>
              {t(`layer${id.charAt(0).toUpperCase()}${id.slice(1)}` as TranslationKey)}
            </span>
          </label>
        ))}
      </Section>

      {/* ── Export ──────────────────────────────────────────────────── */}
      <Section label={t('export')}>
        <button
          id="download-view-btn"
          onClick={downloadCurrentView}
          disabled={dl.busy}
          style={{
            width: '100%', padding: '7px 10px',
            background: 'rgba(0, 30, 60, 0.6)', border: '1px solid rgba(0, 180, 255, 0.25)',
            borderRadius: '6px', color: '#a0c4e8', fontSize: '12px',
            cursor: dl.busy ? 'wait' : 'pointer',
          }}
        >
          {dl.busy ? `⏳ ${dl.msg}` : `⭳ ${t('downloadView')}`}
        </button>
        {!dl.busy && dl.msg && (
          <div style={{ fontSize: '11px', color: dl.err ? '#ff6b6b' : '#4caf88', lineHeight: 1.4 }}>{dl.msg}</div>
        )}
      </Section>

    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={styles.section}>
      <div style={styles.sectionLabel}>{label}</div>
      {children}
    </div>
  )
}

function Select({ id, value, onChange, options, disabled }: {
  id: string; value: string;
  onChange: React.ChangeEventHandler<HTMLSelectElement>
  options: { value: string; label: string }[]
  disabled?: boolean
}) {
  return (
    <select
      id={id}
      value={value}
      onChange={onChange}
      disabled={disabled}
      style={{ ...styles.select, ...(disabled ? { opacity: 0.6, cursor: 'not-allowed' } : {}) }}
    >
      {options.map(o => (
        <option 
          key={o.value} 
          value={o.value} 
          style={{ background: '#001e3c', color: '#a0c4e8' }}
        >
          {o.label}
        </option>
      ))}
    </select>
  )
}

function LabeledInput({ label, id, ...props }: { label: string; id: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div style={{ width: '100%' }}>
      <div style={styles.inputLabel}>{label}</div>
      <input id={id} {...props} style={styles.slider} />
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles: Record<string, React.CSSProperties> = {
  panel:       { display: 'flex', flexDirection: 'column', gap: '4px' },
  section:     { borderTop: '1px solid rgba(0, 180, 255, 0.1)', paddingTop: '12px', display: 'flex', flexDirection: 'column', gap: '8px' },
  sectionLabel: { fontSize: '10px', fontWeight: '600', color: 'rgba(0, 180, 255, 0.7)', textTransform: 'uppercase', letterSpacing: '0.1em' },
  select:      { width: '100%', background: 'rgba(0, 30, 60, 0.8)', border: '1px solid rgba(0, 180, 255, 0.2)', borderRadius: '6px', color: '#a0c4e8', padding: '6px 10px', fontSize: '13px' },
  slider:      { width: '100%', accentColor: '#00d4ff', cursor: 'pointer' },
  sliderLabels: { display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'rgba(160, 196, 232, 0.5)', marginTop: '2px' },
  toggleGroup: { display: 'flex', gap: '4px' },
  toggle:      { flex: 1, padding: '6px 4px', background: 'rgba(0, 30, 60, 0.6)', border: '1px solid rgba(0, 180, 255, 0.2)', borderRadius: '6px', color: '#a0c4e8', cursor: 'pointer', fontSize: '12px', fontWeight: '500' },
  toggleActive: { background: 'rgba(0, 180, 255, 0.2)', border: '1px solid #00d4ff', color: '#00d4ff' },
  row:         { display: 'flex', gap: '8px' },
  checkRow:    { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' },
  inputLabel:  { fontSize: '11px', color: 'rgba(160, 196, 232, 0.6)', marginBottom: '4px' },
}
