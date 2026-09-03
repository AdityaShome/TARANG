
import React from 'react'
import { useTarangStore } from '../state/store'
import { colormapGradientCSS } from '../scene/colormaps'

export function Legend() {
  const colormap = useTarangStore(s => s.colormap)
  const activeVar = useTarangStore(s => s.activeVar)

  if (!activeVar || !colormap) return null

  const min = colormap.min.toFixed(1)
  const max = colormap.max.toFixed(1)
  const mid = ((colormap.min + colormap.max) / 2).toFixed(1)

  const gradient = colormapGradientCSS(colormap.name, colormap.reversed, 'to top')

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
    bottom: '30px',
    left: '20px',
    width: '120px',
    padding: '16px',
    background: 'rgba(8, 15, 30, 0.8)',
    backdropFilter: 'blur(12px)',
    border: '1px solid rgba(0, 180, 255, 0.3)',
    borderRadius: '12px',
    color: '#fff',
    fontFamily: "'Inter', sans-serif",
    zIndex: 15,
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
  },

  title: {
    fontSize: '11px',
    fontWeight: '600',
    color: '#00d4ff',
    textAlign: 'center',
    letterSpacing: '0.05em',
  },

  logBadge: {
    color: 'rgba(160, 196, 232, 0.7)',
    fontWeight: '400',
  },

  legendWrapper: {
    display: 'flex',
    flexDirection: 'row',
    height: '150px',
    gap: '12px',
  },

  labels: {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    fontSize: '10px',
    color: 'rgba(255,255,255,0.7)',
    textAlign: 'right',
    flex: 1,
  },

  gradientBar: {
    width: '16px',
    borderRadius: '4px',
    // Background is set inline per-render from PALETTE_STOPS[colormap.name].
    border: '1px solid rgba(255,255,255,0.1)',
  },
}