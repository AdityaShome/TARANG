import React, { useState, useRef } from 'react'
import { useTarangStore } from '../state/store'
import { geocodeRegion, GeocodeResult } from '../api/geocode'
import { useT } from '../i18n/useT'

/**
 * SearchBar — lets a researcher search for any sea/region by name instead of being
 * stuck with whatever bbox the app happened to start on. Resolves the query via
 * Nominatim, then hands the result bbox to store.searchRegion(), which every layer's
 * data-fetch effect already reacts to (SceneManager.tsx) and which SceneManager also
 * consumes to fly the camera there.
 */
export function SearchBar() {
  const searchRegion     = useTarangStore(s => s.searchRegion)
  const regionLabel      = useTarangStore(s => s.regionLabel)
  const isFetchingLayers = useTarangStore(s => s.isFetchingLayers)

  const [query, setQuery]       = useState('')
  const [results, setResults]   = useState<GeocodeResult[]>([])
  const [isSearching, setSearching] = useState(false)
  const [error, setError]       = useState<string | null>(null)
  const [showResults, setShowResults] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const t = useT()

  async function runSearch() {
    if (!query.trim()) return
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setSearching(true)
    setError(null)
    try {
      const found = await geocodeRegion(query.trim(), controller.signal)
      if (found.length === 0) {
        setError(t('noMatch', { query }))
        setResults([])
      } else if (found.length === 1) {
        pick(found[0])
      } else {
        setResults(found)
        setShowResults(true)
      }
    } catch (e: unknown) {
      if ((e as Error).name !== 'AbortError') {
        setError(t('searchFailed'))
      }
    } finally {
      setSearching(false)
    }
  }

  function pick(result: GeocodeResult) {
    searchRegion(result.bbox, shortLabel(result.label))
    setShowResults(false)
    setResults([])
  }

  return (
    <div style={styles.wrap}>
      <div style={styles.row}>
        <input
          id="region-search-input"
          style={styles.input}
          placeholder={t('searchPlaceholder')}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') runSearch() }}
        />
        <button id="region-search-button" style={styles.button} onClick={runSearch} disabled={isSearching}>
          {isSearching ? '…' : '🔍'}
        </button>
      </div>

      {regionLabel
        ? <div style={styles.currentRegion}>📍 {regionLabel}</div>
        : <div style={styles.noRegion}>{t('noRegionSelected')}</div>}
      {isFetchingLayers && (
        <div style={styles.fetching}>
          ⏳ {t('fetchingData')}
        </div>
      )}
      {error && <div style={styles.error}>{error}</div>}

      {showResults && results.length > 0 && (
        <div style={styles.resultsList}>
          {results.map((r, i) => (
            <div key={i} style={styles.resultItem} onClick={() => pick(r)}>
              {shortLabel(r.label)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// Nominatim's display_name is a full address chain ("Arabian Sea, Indian Ocean") —
// keep just the first couple of segments so it fits the panel.
function shortLabel(displayName: string): string {
  return displayName.split(',').slice(0, 2).join(',').trim()
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { display: 'flex', flexDirection: 'column', gap: '6px', position: 'relative' },
  row: { display: 'flex', gap: '6px' },
  input: {
    flex: 1, background: 'rgba(0, 30, 60, 0.8)', border: '1px solid rgba(0, 180, 255, 0.2)',
    borderRadius: '6px', color: '#a0c4e8', padding: '6px 10px', fontSize: '13px',
  },
  button: {
    background: 'rgba(0, 180, 255, 0.15)', border: '1px solid rgba(0, 180, 255, 0.3)',
    borderRadius: '6px', color: '#00d4ff', padding: '6px 12px', cursor: 'pointer', fontSize: '13px',
  },
  currentRegion: { fontSize: '11px', color: 'rgba(160, 196, 232, 0.7)' },
  noRegion: { fontSize: '11px', color: 'rgba(160, 196, 232, 0.5)', fontStyle: 'italic' },
  fetching: { fontSize: '11px', color: '#00d4ff', lineHeight: '1.4' },
  error: { fontSize: '11px', color: '#ff6b6b' },
  resultsList: {
    position: 'absolute', top: '36px', left: 0, right: 0, zIndex: 200,
    background: 'rgba(8, 15, 30, 0.97)', border: '1px solid rgba(0, 180, 255, 0.3)',
    borderRadius: '8px', overflow: 'hidden',
  },
  resultItem: {
    padding: '8px 10px', fontSize: '12px', color: '#a0c4e8', cursor: 'pointer',
    borderBottom: '1px solid rgba(0, 180, 255, 0.1)',
  },
}
