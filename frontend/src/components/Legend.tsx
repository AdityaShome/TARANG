import React from 'react'
import { useTarangStore } from '../state/store'
import type { ColormapName } from '../api/types'

// Same 5 stops as colormapFrag.glsl/volumeFrag_v2.glsl's palette functions — kept in sync so the
// legend actually shows the gradient that's rendering, not a fixed unrelated one (previously this
// was a single hardcoded CSS gradient that never changed regardless of which palette was picked).
const PALETTE_STOPS: Record<ColormapName, string[]> = {
  viridis: ['rgb(68,1,84)', 'rgb(59,82,139)', 'rgb(33,145,140)', 'rgb(94,201,98)', 'rgb(253,231,37)'],
  plasma:  ['rgb(13,8,135)', 'rgb(126,3,168)', 'rgb(204,71,120)', 'rgb(248,149,65)', 'rgb(240,249,33)'],
  magma:   ['rgb(0,0,4)', 'rgb(59,15,112)', 'rgb(140,41,129)', 'rgb(222,73,104)', 'rgb(252,253,191)'],
  inferno: ['rgb(0,0,4)', 'rgb(66,10,104)', 'rgb(147,38,103)', 'rgb(221,81,58)', 'rgb(252,255,164)'],
  jet:     ['rgb(0,0,127)', 'rgb(0,255,255)', 'rgb(127,255,127)', 'rgb(255,255,0)', 'rgb(127,0,0)'],
}

export function Legend() {
  const colormap = useTarangStore(s => s.colormap)
  const activeVar = useTarangStore(s => s.activeVar)

  if (!activeVar || !colormap) return null

  // Format numbers to 1 decimal place
  const min = colormap.min.toFixed(1)
  const max = colormap.max.toFixed(1)
  const mid = ((colormap.min + colormap.max) / 2).toFixed(1)
  const stops = PALETTE_STOPS[colormap.name] ?? PALETTE_STOPS.viridis
  const gradient = `linear-gradient(to top, ${stops.join(', ')})`

  return (
    <div style={styles.container}>
      <div style={styles.title}>
        {activeVar.replace('_', ' ').toUpperCase()}
        {colormap.logScale && <span style={styles.logBadge}> (log)</span>}
      </div>

      <div style={styles.legendWrapper}>
        <div style={styles.labels}>
          <span>{max}</span>
          <span>{mid}</span>
          <span>{min}</span>
        </div>

        <div style={{ ...styles.gradientBar, background: gradient }} />
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: 'absolute',
    bottom: '40px',
    right: '40px',
    width: '120px',
    padding: '16px',
    background: 'rgba(8, 15, 30, 0.8)',
    backdropFilter: 'blur(12px)',
    border: '1px solid rgba(0, 180, 255, 0.3)',
    borderRadius: '12px',
    color: '#fff',
    fontFamily: "'Inter', sans-serif",
    zIndex: 100,
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    boxShadow: '0 8px 32px rgba(0,0,0,0.5)'
  },
  title: {
    fontSize: '11px',
    fontWeight: '600',
    color: '#00d4ff',
    textAlign: 'center',
    letterSpacing: '0.05em'
  },
  logBadge: {
    color: 'rgba(160, 196, 232, 0.7)',
    fontWeight: '400',
  },
  legendWrapper: {
    display: 'flex',
    flexDirection: 'row',
    height: '150px',
    gap: '12px'
  },
  labels: {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    fontSize: '10px',
    color: 'rgba(255,255,255,0.7)',
    textAlign: 'right',
    flex: 1
  },
  gradientBar: {
    width: '16px',
    borderRadius: '4px',
    // background set inline per-render from PALETTE_STOPS[colormap.name] above
    border: '1px solid rgba(255,255,255,0.1)'
  }
}
