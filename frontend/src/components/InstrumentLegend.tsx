import React from 'react'
import { useTarangStore } from '../state/store'
import { INSTRUMENT_TYPE_LABELS } from '../state/store'

/**
 * InstrumentLegend — reads AND edits.
 *
 * Lists every instrument type currently on the map with its colour, a human label and a live
 * count, so the operator can tell what each coloured dot means. Each colour swatch is an
 * <input type="color">: changing it recolours that type's markers everywhere (globe + 2D map)
 * and persists to localStorage. "Reset" restores the defaults.
 *
 * Only renders when the Markers layer is on and there is at least one instrument in view.
 */
export function InstrumentLegend() {
  const rows            = useTarangStore(s => s.instrumentsInView)
  const colors          = useTarangStore(s => s.instrumentColors)
  const setColor        = useTarangStore(s => s.setInstrumentColor)
  const reset           = useTarangStore(s => s.resetInstrumentColors)
  const markersOn       = useTarangStore(s => s.layerVisibility['markers'])

  if (!markersOn || rows.length === 0) return null

  const sorted = [...rows].sort((a, b) => b.count - a.count)

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.title}>Instruments</span>
        <button style={styles.reset} onClick={reset} title="Restore default colours">reset</button>
      </div>

      <div style={styles.list}>
        {sorted.map(({ type, count }) => (
          <label key={type} style={styles.row} title="Click the swatch to recolour this type">
            <input
              type="color"
              value={colors[type] ?? '#ffffff'}
              onChange={e => setColor(type, e.target.value)}
              style={styles.swatch}
            />
            <span style={styles.label}>{INSTRUMENT_TYPE_LABELS[type] ?? type}</span>
            <span style={styles.count}>{count}</span>
          </label>
        ))}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: 'absolute',
    bottom: '30px',
    left: '156px',   // immediately right of the thermal Legend (20px + 120px + gap)
    width: '178px',
    padding: '12px 14px',
    background: 'rgba(8, 15, 30, 0.8)',
    backdropFilter: 'blur(12px)',
    border: '1px solid rgba(0, 180, 255, 0.3)',
    borderRadius: '12px',
    color: '#fff',
    fontFamily: "'Inter', sans-serif",
    zIndex: 15,
    boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
    maxHeight: 'calc(100vh - 60px)',
    overflowY: 'auto',
  },
  header: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginBottom: '8px',
  },
  title: {
    fontSize: '11px',
    fontWeight: 600,
    color: '#00d4ff',
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
  },
  reset: {
    background: 'transparent',
    border: 'none',
    color: 'rgba(160, 196, 232, 0.7)',
    fontSize: '10px',
    cursor: 'pointer',
    padding: 0,
    textDecoration: 'underline',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    cursor: 'pointer',
  },
  swatch: {
    width: '16px',
    height: '16px',
    padding: 0,
    border: '1px solid rgba(255,255,255,0.25)',
    borderRadius: '4px',
    background: 'transparent',
    cursor: 'pointer',
    flexShrink: 0,
  },
  label: {
    fontSize: '11px',
    color: 'rgba(255,255,255,0.85)',
    flex: 1,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  count: {
    fontSize: '10px',
    color: 'rgba(160, 196, 232, 0.65)',
    fontVariantNumeric: 'tabular-nums',
  },
}
