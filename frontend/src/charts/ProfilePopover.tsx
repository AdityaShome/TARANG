import React, { useEffect, useState } from 'react'
import { useTarangStore } from '../state/store'
import { fetchProfile } from '../api/client'
import type { DepthProfile } from '../api/types'

/**
 * ProfilePopover — Depth-vs-variable chart for a selected Argo float.
 *
 * Shown when selectedPlatformId !== null.
 * Fetches /api/profile and renders depth-vs-temperature + depth-vs-salinity
 * using Plotly.js. CF units come from the API response — never hardcoded. (§20 Rule 2)
 */
interface ProfilePopoverProps {
  platformId: string
}

export function ProfilePopover({ platformId }: ProfilePopoverProps) {
  const setSelectedPlatform = useTarangStore(s => s.setSelectedPlatform)
  const activeSourceId = useTarangStore(s => s.activeSourceId)
  const activeTimeIdx = useTarangStore(s => s.activeTimeIdx)
  const [profile, setProfile] = useState<DepthProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)
  const [showDelta, setShowDelta] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)

    fetchProfile(platformId, showDelta ? activeSourceId : undefined, showDelta ? activeTimeIdx : undefined, controller.signal)
      .then(data => { setProfile(data); setLoading(false) })
      .catch(e => {
        if (e.name !== 'AbortError') {
          setError(e.message)
          setLoading(false)
        }
      })

    return () => controller.abort()
  }, [platformId, showDelta, activeSourceId, activeTimeIdx])

  const hasTS = !!(profile?.temperature && profile.temperature.some(v => v != null))

  // Extra (non-T/S) panels — BGC biogeochemistry + ADCP currents. Rendered from
  // whatever the API actually returned, so new variables need no popover changes.
  const extraPanels = React.useMemo(() => {
    if (!profile) return [] as { id: string; label: string; values: number[]; unit: string; color: string }[]
    const defs: [keyof typeof profile & string, string, string][] = [
      ['chlorophyll', 'Chlorophyll', '#7cfc7c'],
      ['oxygen', 'Dissolved O₂', '#4dd0e1'],
      ['nitrate', 'Nitrate', '#ffb74d'],
      ['ph', 'pH', '#ce93d8'],
      ['current_speed', 'Current speed', '#b388ff'],
    ]
    const unitFor = (k: string) => (profile.units as Record<string, string | undefined>)[k] ?? ''
    return defs
      .map(([k, label, color]) => ({ id: k, label, color, unit: unitFor(k), values: (profile as any)[k] as number[] | undefined }))
      .filter(p => p.values && p.values.some(v => v != null)) as { id: string; label: string; values: number[]; unit: string; color: string }[]
  }, [profile])

  const panelCount = (hasTS ? 2 : 0) + extraPanels.length

  // Lazy-load Plotly to avoid blocking initial render
  useEffect(() => {
    if (!profile) return
    import('plotly.js-dist-min').then(Plotly => {
      const tempDiv  = document.getElementById('tarang-profile-temp')
      const salDiv   = document.getElementById('tarang-profile-sal')

      const commonLayout = {
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor:  'rgba(0,0,0,0)',
        font:          { color: '#a0c4e8', size: 11 },
        margin:        { t: 20, r: 10, b: 40, l: 50 },
        xaxis:         { gridcolor: 'rgba(255,255,255,0.08)', color: '#a0c4e8' },
        yaxis:         {
          gridcolor:  'rgba(255,255,255,0.08)',
          color:      '#a0c4e8',
          autorange:  'reversed' as const,
          title:      { text: `Depth (${profile.units.depth})` },
        },
        showlegend:    showDelta,
        legend:        { x: 0, y: 1.1, orientation: 'h' as const, font: { size: 10 } }
      }

      if (tempDiv && hasTS) {
        const tempTraces: any[] = [{
          x: profile.temperature,
          y: profile.depth,
          type: 'scatter', mode: 'lines+markers',
          line: { color: '#ff6b6b', width: 2 },
          marker: { size: 4, color: '#ff6b6b' },
          name: `Obs`,
        }]
        if (showDelta && profile.model_temperature) {
          tempTraces.push({
            x: profile.model_temperature,
            y: profile.depth,
            type: 'scatter', mode: 'lines',
            line: { color: '#ffd166', width: 2, dash: 'dash' },
            name: `Model`,
          })
        }
        Plotly.newPlot(tempDiv, tempTraces, {
          ...commonLayout,
          xaxis: { ...commonLayout.xaxis, title: { text: `Temperature (${profile.units.temperature})` } },
        }, { displayModeBar: false, responsive: true })
      }

      if (salDiv && hasTS) {
        const salTraces: any[] = [{
          x: profile.salinity,
          y: profile.depth,
          type: 'scatter', mode: 'lines+markers',
          line: { color: '#4fc3f7', width: 2 },
          marker: { size: 4, color: '#4fc3f7' },
          name: `Obs`,
        }]
        if (showDelta && profile.model_salinity) {
          salTraces.push({
            x: profile.model_salinity,
            y: profile.depth,
            type: 'scatter', mode: 'lines',
            line: { color: '#00d4ff', width: 2, dash: 'dash' },
            name: `Model`,
          })
        }
        Plotly.newPlot(salDiv, salTraces, {
          ...commonLayout,
          xaxis: { ...commonLayout.xaxis, title: { text: `Salinity (${profile.units.salinity})` } },
        }, { displayModeBar: false, responsive: true })
      }

      // BGC (chlorophyll / oxygen / nitrate / pH) + ADCP current-speed panels.
      for (const panel of extraPanels) {
        const div = document.getElementById(`tarang-profile-${panel.id}`)
        if (!div) continue
        Plotly.newPlot(div, [{
          x: panel.values,
          y: profile.depth,
          type: 'scatter', mode: 'lines+markers',
          line: { color: panel.color, width: 2 },
          marker: { size: 4, color: panel.color },
          name: panel.label,
        }], {
          ...commonLayout,
          xaxis: { ...commonLayout.xaxis, title: { text: `${panel.label}${panel.unit ? ` (${panel.unit})` : ''}` } },
        }, { displayModeBar: false, responsive: true })
      }
    })
  }, [profile, showDelta, hasTS, extraPanels])

  return (
    <div id="profile-popover" style={{ ...styles.container, width: Math.max(260, panelCount * 240) }}>
      {/* Header */}
      <div style={styles.header}>
        <div>
          <div style={styles.title}>{INSTRUMENT_LABEL[profile?.instrument_type ?? ''] ?? 'Instrument'} {platformId}</div>
          {profile && (
            <div style={styles.meta}>
              {profile.lat.toFixed(2)}°N, {profile.lon.toFixed(2)}°E
              {profile.time ? ` · ${profile.time.slice(0, 10)}` : ''}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <label style={{ fontSize: '12px', color: '#a0c4e8', display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
            <input 
              type="checkbox" 
              checked={showDelta} 
              onChange={e => setShowDelta(e.target.checked)}
              style={{ accentColor: '#00d4ff' }}
            />
            Show model delta
          </label>
          <button
            id="close-profile"
            style={styles.closeBtn}
            onClick={() => setSelectedPlatform(null)}
          >
            ✕
          </button>
        </div>
      </div>

      {/* Body */}
      {loading && <div style={styles.loading}>Loading profile…</div>}
      {error   && <div style={styles.error}>{error}</div>}
      {profile && !loading && (
        <div style={styles.charts}>
          {hasTS && <div id="tarang-profile-temp" style={styles.chart} />}
          {hasTS && <div id="tarang-profile-sal"  style={styles.chart} />}
          {extraPanels.map(p => <div key={p.id} id={`tarang-profile-${p.id}`} style={styles.chart} />)}
          {panelCount === 0 && <div style={styles.loading}>No profile variables available.</div>}
        </div>
      )}
    </div>
  )
}

const INSTRUMENT_LABEL: Record<string, string> = {
  argo: 'Argo Float', glider: 'Glider', ctd: 'CTD Cast', bgc: 'BGC Float',
  mooring: 'Mooring', adcp: 'ADCP',
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    position:       'absolute',
    bottom:         '24px',
    // Clear of the colour-bar (left 20, w120) and the instrument legend (left 156, w178).
    left:           '360px',
    maxWidth:       'calc(100vw - 420px)',
    width:          '520px',
    background:     'rgba(5, 12, 28, 0.95)',
    backdropFilter: 'blur(20px)',
    border:         '1px solid rgba(0, 180, 255, 0.25)',
    borderRadius:   '14px',
    padding:        '20px',
    // Must float above the VolumeIsoWorkspace modal and the 2D India map — clicking a marker in
    // either still opens this same popover (the PS's co-visualization requirement).
    zIndex:         1600,
    boxShadow:      '0 8px 48px rgba(0, 80, 180, 0.3)',
    fontFamily:     "'Inter', sans-serif",
  },
  header: {
    display:        'flex',
    justifyContent: 'space-between',
    alignItems:     'flex-start',
    marginBottom:   '16px',
  },
  title: {
    fontSize:   '16px',
    fontWeight: '600',
    color:      '#e0f0ff',
  },
  meta: {
    fontSize: '12px',
    color:    'rgba(160, 196, 232, 0.7)',
    marginTop: '4px',
  },
  closeBtn: {
    background:   'transparent',
    border:       'none',
    color:        'rgba(160, 196, 232, 0.6)',
    fontSize:     '18px',
    cursor:       'pointer',
    padding:      '0 4px',
    lineHeight:   1,
  },
  loading: { color: '#a0c4e8', fontSize: '14px', textAlign: 'center', padding: '20px' },
  error:   { color: '#ff6b6b', fontSize: '13px', textAlign: 'center', padding: '16px' },
  charts: {
    display: 'flex',
    gap:     '8px',
    overflowX: 'auto',
  },
  chart: {
    flex:      '1 0 200px',
    minWidth:  '200px',
    height: '220px',
  },
}
