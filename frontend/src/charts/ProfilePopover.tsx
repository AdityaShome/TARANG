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
  const [profile, setProfile] = useState<DepthProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)

    fetchProfile(platformId, controller.signal)
      .then(data => { setProfile(data); setLoading(false) })
      .catch(e => {
        if (e.name !== 'AbortError') {
          setError(e.message)
          setLoading(false)
        }
      })

    return () => controller.abort()
  }, [platformId])

  // Lazy-load Plotly to avoid blocking initial render
  useEffect(() => {
    if (!profile) return
    import('plotly.js-dist-min').then(Plotly => {
      const tempDiv  = document.getElementById('tarang-profile-temp')
      const salDiv   = document.getElementById('tarang-profile-sal')
      if (!tempDiv || !salDiv) return

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
      }

      Plotly.newPlot(tempDiv, [{
        x: profile.temperature,
        y: profile.depth,
        type: 'scatter', mode: 'lines+markers',
        line: { color: '#ff6b6b', width: 2 },
        marker: { size: 4, color: '#ff6b6b' },
        name: `Temperature (${profile.units.temperature})`,
      }], {
        ...commonLayout,
        xaxis: { ...commonLayout.xaxis, title: { text: `Temperature (${profile.units.temperature})` } },
      }, { displayModeBar: false, responsive: true })

      Plotly.newPlot(salDiv, [{
        x: profile.salinity,
        y: profile.depth,
        type: 'scatter', mode: 'lines+markers',
        line: { color: '#4fc3f7', width: 2 },
        marker: { size: 4, color: '#4fc3f7' },
        name: `Salinity (${profile.units.salinity})`,
      }], {
        ...commonLayout,
        xaxis: { ...commonLayout.xaxis, title: { text: `Salinity (${profile.units.salinity})` } },
      }, { displayModeBar: false, responsive: true })
    })
  }, [profile])

  return (
    <div id="profile-popover" style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <div>
          <div style={styles.title}>Argo Float {platformId}</div>
          {profile && (
            <div style={styles.meta}>
              {profile.lat.toFixed(2)}°N, {profile.lon.toFixed(2)}°E
              {profile.time ? ` · ${profile.time.slice(0, 10)}` : ''}
            </div>
          )}
        </div>
        <button
          id="close-profile"
          style={styles.closeBtn}
          onClick={() => setSelectedPlatform(null)}
        >
          ✕
        </button>
      </div>

      {/* Body */}
      {loading && <div style={styles.loading}>Loading profile…</div>}
      {error   && <div style={styles.error}>{error}</div>}
      {profile && !loading && (
        <div style={styles.charts}>
          <div id="tarang-profile-temp" style={styles.chart} />
          <div id="tarang-profile-sal"  style={styles.chart} />
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    position:       'absolute',
    bottom:         '24px',
    left:           '24px',
    width:          '520px',
    background:     'rgba(5, 12, 28, 0.95)',
    backdropFilter: 'blur(20px)',
    border:         '1px solid rgba(0, 180, 255, 0.25)',
    borderRadius:   '14px',
    padding:        '20px',
    zIndex:         30,
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
  },
  chart: {
    flex:   1,
    height: '220px',
  },
}
