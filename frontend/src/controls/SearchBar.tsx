import React, { useState, useRef, useEffect } from 'react'
import { useTarangStore } from '../state/store'
import { geocodeRegion, GeocodeResult } from '../api/geocode'
import { fetchLastUpdated } from '../api/client'
import type { LastUpdatedEntry } from '../api/types'
import { useT } from '../i18n/useT'

// bbox as sent to the backend (see api/client.ts's bboxStr) — used to match a LastUpdatedEntry
// to the currently-selected region/source/var without needing the backend to echo it back.
function bboxKeyStr(bbox: [number, number, number, number]): string {
  return bbox.join(',')
}

function timeAgo(unixSeconds: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unixSeconds))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

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
  const mapSelectMode    = useTarangStore(s => s.mapSelectMode)
  const setMapSelectMode = useTarangStore(s => s.setMapSelectMode)
  const bbox             = useTarangStore(s => s.bbox)
  const activeSourceId   = useTarangStore(s => s.activeSourceId)
  const activeVar        = useTarangStore(s => s.activeVar)

  const [query, setQuery]       = useState('')
  const [results, setResults]   = useState<GeocodeResult[]>([])
  const [isSearching, setSearching] = useState(false)
  const [error, setError]       = useState<string | null>(null)
  const [showResults, setShowResults] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<LastUpdatedEntry[]>([])
  const abortRef = useRef<AbortController | null>(null)
  const t = useT()

  // Refresh cache-status metrics whenever a fetch finishes (isFetchingLayers flips false→true→false)
  // and once on mount, so "last updated" is accurate right when the loading spinner disappears.
  useEffect(() => {
    if (isFetchingLayers) return
    const controller = new AbortController()
    fetchLastUpdated(controller.signal).then(setLastUpdated).catch(() => {})
    return () => controller.abort()
  }, [isFetchingLayers, bbox, activeSourceId, activeVar])

  const currentEntry = lastUpdated.find(
    e => e.source === activeSourceId && e.var === activeVar && e.bbox === bboxKeyStr(bbox)
  )

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
      } else {
        // Always navigate to the best match right away — a submitted search must never leave a
        // stale region (e.g. a previous click/drag custom pick) on screen just because the query
        // was ambiguous. When there's more than one hit, keep the list open so the researcher can
        // refine, but the map has already moved to the top result.
        pick(found[0], { keepList: found.length > 1 })
        if (found.length > 1) {
          setResults(found)
          setShowResults(true)
        }
      }
    } catch (e: unknown) {
      if ((e as Error).name !== 'AbortError') {
        setError(t('searchFailed'))
      }
    } finally {
      setSearching(false)
    }
  }

  function pick(result: GeocodeResult, opts?: { keepList?: boolean }) {
    searchRegion(result.bbox, shortLabel(result.label))
    if (!opts?.keepList) {
      setShowResults(false)
      setResults([])
    }
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

      <div style={styles.pickRow}>
        <button
          id="map-select-click"
          style={{ ...styles.pickBtn, ...(mapSelectMode === 'click' ? styles.pickBtnActive : {}) }}
          onClick={() => setMapSelectMode(mapSelectMode === 'click' ? 'off' : 'click')}
          title={t('mapPickClickHint')}
        >
          📍 {t('mapPickClick')}
        </button>
        <button
          id="map-select-drag"
          style={{ ...styles.pickBtn, ...(mapSelectMode === 'drag' ? styles.pickBtnActive : {}) }}
          onClick={() => setMapSelectMode(mapSelectMode === 'drag' ? 'off' : 'drag')}
          title={t('mapPickDragHint')}
        >
          ▭ {t('mapPickDrag')}
        </button>
      </div>
      {mapSelectMode !== 'off' && (
        <div style={styles.pickHint}>
          {mapSelectMode === 'click' ? t('mapPickClickHint') : t('mapPickDragHint')}
        </div>
      )}

      {regionLabel
        ? <div style={styles.currentRegion}>📍 {regionLabel}</div>
        : <div style={styles.noRegion}>{t('noRegionSelected')}</div>}
      {isFetchingLayers && (
        <div style={styles.fetching}>
          ⏳ {t('fetchingData')}
          {currentEntry && (
            <span style={styles.lastUpdatedInline}>
              {' '}(previously updated {timeAgo(currentEntry.updated_at)})
            </span>
          )}
        </div>
      )}
      {!isFetchingLayers && currentEntry && (
        <div style={styles.lastUpdated} title={`${currentEntry.duration_ms}ms · ${currentEntry.cache_hit ? 'served from cache' : 'freshly fetched'}`}>
          🕒 Last updated {timeAgo(currentEntry.updated_at)}
          {currentEntry.cache_hit ? ' (cached)' : ''}
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
  pickRow: { display: 'flex', gap: '6px' },
  pickBtn: {
    flex: 1, background: 'rgba(0, 30, 60, 0.6)', border: '1px solid rgba(0, 180, 255, 0.2)',
    borderRadius: '6px', color: 'rgba(160, 196, 232, 0.8)', padding: '5px 8px',
    cursor: 'pointer', fontSize: '11px',
  },
  pickBtnActive: {
    background: 'rgba(0, 180, 255, 0.25)', border: '1px solid rgba(0, 212, 255, 0.6)', color: '#00d4ff',
  },
  pickHint: { fontSize: '10px', color: 'rgba(0, 212, 255, 0.8)', fontStyle: 'italic' },
  currentRegion: { fontSize: '11px', color: 'rgba(160, 196, 232, 0.7)' },
  noRegion: { fontSize: '11px', color: 'rgba(160, 196, 232, 0.5)', fontStyle: 'italic' },
  fetching: { fontSize: '11px', color: '#00d4ff', lineHeight: '1.4' },
  lastUpdatedInline: { color: 'rgba(0, 212, 255, 0.6)', fontStyle: 'italic' },
  lastUpdated: { fontSize: '11px', color: 'rgba(160, 196, 232, 0.6)' },
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
