import React, { useMemo, useState, useEffect } from 'react'
import { useTarangStore, debounce } from '../state/store'

/**
 * ControlPanel — Container for all Forecaster Console controls.
 * Dispatches to the central Zustand store. Nothing here touches Three.js directly.
 */
export function ControlPanel() {
  const {
    sources, activeSourceId, setActiveSource,
    activeVar, setActiveVar,
    activeDepthIdx, setActiveDepthIdx, depthLevels,
    activeTimeIdx, setActiveTimeIdx, timeSteps,
    renderMode, setRenderMode,
    isoThreshold, setIsoThreshold,
    colormap, setColormap, setColormapName,
    layerVisibility, toggleLayer,
  } = useTarangStore()

  // Debounced depth/time slider handlers (150ms — §10)
  const debouncedDepth = useMemo(() => debounce(setActiveDepthIdx, 150), [])
  const [isPlaying, setIsPlaying] = useState(false)

  useEffect(() => {
    let interval: any
    if (isPlaying) {
      interval = setInterval(() => {
        if (timeSteps.length > 0) {
          const nextIdx = (activeTimeIdx + 1) % timeSteps.length
          setActiveTimeIdx(nextIdx)
        }
      }, 500)
    }
    return () => clearInterval(interval)
  }, [isPlaying, activeTimeIdx, timeSteps.length, setActiveTimeIdx])

  const activeDepthM = depthLevels[activeDepthIdx] ?? 0

  return (
    <div id="control-panel-inner" style={styles.panel}>

      {/* ── Source Selector ─────────────────────────────────────────── */}
      <Section label="Data Source">
        <Select
          id="source-select"
          value={activeSourceId}
          onChange={e => setActiveSource(e.target.value)}
          options={sources.map(s => ({ value: s.id, label: s.label }))}
        />
      </Section>

      {/* ── Variable Selector ───────────────────────────────────────── */}
      <Section label="Variable">
        <Select
          id="var-select"
          value={activeVar}
          onChange={e => setActiveVar(e.target.value)}
          options={[{ value: activeVar, label: activeVar }]}
        />
      </Section>

      {/* ── Render Mode ─────────────────────────────────────────────── */}
      <Section label="Render Mode">
        <div style={styles.toggleGroup}>
          {(['slice', 'volume', 'isosurface'] as const).map(mode => (
            <button
              key={mode}
              id={`render-mode-${mode}`}
              style={{ ...styles.toggle, ...(renderMode === mode ? styles.toggleActive : {}) }}
              onClick={() => setRenderMode(mode)}
            >
              {mode === 'slice' ? '⬜ Slice' : mode === 'volume' ? '🧊 Volume' : '🔵 Iso'}
            </button>
          ))}
        </div>
        {renderMode === 'isosurface' && (
          <LabeledInput
            label={`Threshold: ${isoThreshold.toFixed(1)}`}
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
      <Section label={`Depth: ${activeDepthM} m`}>
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
      <Section label={`Time Step: ${timeSteps[activeTimeIdx] ?? 'T+0'}`}>
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
      </Section>

      {/* ── Colormap ─────────────────────────────────────────────────── */}
      <Section label="Colormap">
        <Select
          id="colormap-select"
          value={colormap.name}
          onChange={e => setColormapName(e.target.value as any)}
          options={[
            { value: 'viridis', label: 'Viridis' },
            { value: 'plasma',  label: 'Plasma'  },
            { value: 'magma',   label: 'Magma'   },
            { value: 'inferno', label: 'Inferno' },
            { value: 'jet',     label: 'Jet'     },
          ]}
        />
        <div style={styles.row}>
          <LabeledInput
            label={`Min: ${colormap.min.toFixed(1)}`}
            id="colormap-min"
            type="range"
            min={-5} max={colormap.max} step={0.5}
            value={colormap.min}
            onChange={e => setColormap({ min: Number(e.target.value) })}
          />
          <LabeledInput
            label={`Max: ${colormap.max.toFixed(1)}`}
            id="colormap-max"
            type="range"
            min={colormap.min} max={45} step={0.5}
            value={colormap.max}
            onChange={e => setColormap({ max: Number(e.target.value) })}
          />
        </div>
        <LabeledInput
          label={`Opacity: ${(colormap.opacity * 100).toFixed(0)}%`}
          id="opacity-slider"
          type="range"
          min={0.1} max={1} step={0.05}
          value={colormap.opacity}
          onChange={e => setColormap({ opacity: Number(e.target.value) })}
        />
        <LabeledInput
          label={`Vert. Exaggeration: ${colormap.verticalExaggeration}×`}
          id="vert-exag-slider"
          type="range"
          min={1} max={200} step={5}
          value={colormap.verticalExaggeration}
          onChange={e => setColormap({ verticalExaggeration: Number(e.target.value) })}
        />
      </Section>

      {/* ── Layer Visibility ─────────────────────────────────────────── */}
      <Section label="Layers">
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
              {id}
            </span>
          </label>
        ))}
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

function Select({ id, value, onChange, options }: {
  id: string; value: string;
  onChange: React.ChangeEventHandler<HTMLSelectElement>
  options: { value: string; label: string }[]
}) {
  return (
    <select id={id} value={value} onChange={onChange} style={styles.select}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
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
