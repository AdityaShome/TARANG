import React from 'react'

import { SceneManager } from '../../scene/SceneManager'
import { IndiaMapView } from '../../scene/IndiaMapView'
import { ControlPanel } from '../../controls/ControlPanel'
import { SearchBar } from '../../controls/SearchBar'
import { useTarangStore } from '../../state/store'
import { ProfilePopover } from '../../charts/ProfilePopover'
import { Legend } from '../../components/Legend'
import { LanguageSwitcher } from '../../components/LanguageSwitcher'
import { useT } from '../../i18n/useT'
import { GlossaryPanel } from '../../components/GlossaryPanel'
import { useState } from 'react'
import { OceanCopilot } from '../../components/OceanCopilot/OceanCopilot'
import { VolumeIsoWorkspace } from '../../scene/workspace/VolumeIsoWorkspace'

/**
 * Forecaster Console — Power-user UI mode
 *
 * Layout: full-screen 3D scene + glassmorphic control sidebar.
 * All controls are visible simultaneously.
 * Instrument profile popover appears on float click.
 *
 * Ocean Copilot provides natural-language interaction with TARANG.
 */
export function ForecasterConsole() {
  const selectedPlatformId = useTarangStore(s => s.selectedPlatformId)
  const hasSearchedRegion  = useTarangStore(s => s.hasSearchedRegion)
  const setUIMode          = useTarangStore(s => s.setUIMode)
  const renderMode         = useTarangStore(s => s.renderMode)
  const setRenderMode      = useTarangStore(s => s.setRenderMode)
  const viewScope          = useTarangStore(s => s.viewScope)
  const setViewScope       = useTarangStore(s => s.setViewScope)
  const regionDataMissing  = useTarangStore(s => s.regionDataMissing)
  const t = useT()
  const [showGlossary, setShowGlossary] = useState(false)

  // Volume/Iso open a dedicated 3D depth workspace instead of rendering on the globe (Slice
  // stays on the globe, unchanged). Only once a region exists — before that there's nothing to
  // show; closing returns to 'slice' so the globe/search view is always what's left underneath.
  const showVolumeIsoWorkspace = hasSearchedRegion && renderMode !== 'slice'

  return (
    <div id="forecaster-console" style={styles.container}>
      {/* ── View: 2D India map, or the 3D globe ─────────────────────── */}
      <div style={styles.sceneWrapper}>
        {viewScope === 'india' ? <IndiaMapView /> : <SceneManager />}
        {!hasSearchedRegion && (
          <div id="search-hint" style={styles.searchHint}>
            {t('searchHint')}
          </div>
        )}
        {hasSearchedRegion && regionDataMissing && renderMode === 'slice' && (
          <div id="no-data-banner" style={styles.noDataBanner}>
            No model data for this region.{' '}
            {viewScope === 'india'
              ? 'Pick a point over open water in the Arabian Sea or Bay of Bengal.'
              : 'This spot has no cached data — search a named sea instead.'}
          </div>
        )}
      </div>

      {/* ── AI Ocean Copilot ─────────────────────────────────────────── */}
      <OceanCopilot />

      {/* ── Control Sidebar ──────────────────────────────────────────── */}
      <aside id="control-panel" style={styles.sidebar}>
        <div style={styles.brandHeader}>
          <div style={styles.brandRow}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={styles.brandText}>TARANG</span>
              <button 
                onClick={() => setShowGlossary(true)}
                style={{ background: 'rgba(0, 212, 255, 0.1)', border: '1px solid rgba(0, 212, 255, 0.3)', color: '#00d4ff', borderRadius: '50%', width: '22px', height: '22px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontSize: '12px' }}
                title="Glossary"
              >
                ?
              </button>
            </div>
            <LanguageSwitcher />
          </div>

          <span style={styles.brandSub}>{t('brandSub')}</span>
        </div>

        {/* ── View scope: India (default, primary) vs. the full Globe ── */}
        <div style={styles.scopeToggle} role="group" aria-label="View scope">
          <button
            id="view-scope-india"
            style={{ ...styles.scopeBtn, ...(viewScope === 'india' ? styles.scopeBtnActive : {}) }}
            onClick={() => setViewScope('india')}
            title="Arabian Sea + Bay of Bengal — the primary demo view"
          >
            India
          </button>
          <button
            id="view-scope-globe"
            style={{ ...styles.scopeBtn, ...(viewScope === 'globe' ? styles.scopeBtnActive : {}) }}
            onClick={() => setViewScope('globe')}
            title="Full rotating globe — search any sea worldwide"
          >
            Globe
          </button>
        </div>

        <SearchBar />

        <ControlPanel />

        {/* Mode switch button */}
        <button
          id="switch-to-explorer"
          style={styles.modeBtn}
          onClick={() => setUIMode('explorer')}
        >
          ✦ {t('explorerModeBtn')}
        </button>

        {/* Attribution (§17 — dataset licensing) */}
        <div style={styles.attribution}>
          Data: HYCOM · Argo GDAC · INCOIS
          <br />
          SIH 2026 · PS 26067
        </div>
      </aside>

      {/* ── Profile Popover (visible when a float is selected) ───────── */}
      {selectedPlatformId && (
        <ProfilePopover platformId={selectedPlatformId} />
      )}

      {/* ── Thermal Legend (hidden while the slice overlay has no data to describe) ── */}
      {!(regionDataMissing && renderMode === 'slice') && <Legend />}
      
      {/* ── Glossary Panel ────────────────────────────────────────────── */}
      {showGlossary && <GlossaryPanel onClose={() => setShowGlossary(false)} />}

      {/* ── Volume/Isosurface 3D Depth Workspace ─────────────────────── */}
      {showVolumeIsoWorkspace && (
        <VolumeIsoWorkspace
          mode={renderMode as 'volume' | 'isosurface'}
          onClose={() => setRenderMode('slice')}
        />
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    width: '100vw',
    height: '100vh',
    background: '#050a14',
    fontFamily: "'Inter', sans-serif",
    position: 'relative',
  },

  sceneWrapper: {
    flex: 1,
    position: 'relative',
    overflow: 'hidden',
    // Trap Leaflet's internal pane z-indexes (200–700) in their own stacking context so the
    // 2D map can never render over the Volume/Iso modal or the ProfilePopover.
    isolation: 'isolate',
  },
  searchHint: {
    position:       'absolute',
    top:            '20px',
    left:           '50%',
    transform:      'translateX(-50%)',
    padding:        '10px 20px',
    background:     'rgba(8, 15, 30, 0.85)',
    backdropFilter: 'blur(10px)',
    border:         '1px solid rgba(0, 180, 255, 0.3)',
    borderRadius:   '8px',
    color:          '#00d4ff',
    fontSize:       '13px',
    fontWeight:     '500',
    pointerEvents:  'none',
    zIndex:         1200,   // above Leaflet's controls/panes in India view
  },
  noDataBanner: {
    position:       'absolute',
    top:            '20px',
    left:           '50%',
    transform:      'translateX(-50%)',
    maxWidth:       '520px',
    padding:        '10px 20px',
    background:     'rgba(40, 20, 8, 0.9)',
    backdropFilter: 'blur(10px)',
    border:         '1px solid rgba(255, 170, 60, 0.45)',
    borderRadius:   '8px',
    color:          '#ffcc80',
    fontSize:       '13px',
    fontWeight:     '500',
    textAlign:      'center',
    pointerEvents:  'none',
    zIndex:         1210,
  },
  scopeToggle: {
    display: 'flex',
    gap: '4px',
    padding: '3px',
    background: 'rgba(0, 20, 40, 0.6)',
    border: '1px solid rgba(0, 180, 255, 0.15)',
    borderRadius: '9px',
  },
  scopeBtn: {
    flex: 1,
    padding: '6px 10px',
    background: 'transparent',
    border: 'none',
    borderRadius: '6px',
    color: 'rgba(160, 196, 232, 0.65)',
    fontSize: '12px',
    fontWeight: 600,
    letterSpacing: '0.04em',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
  },
  scopeBtnActive: {
    background: 'rgba(0, 180, 255, 0.22)',
    color: '#00d4ff',
    boxShadow: '0 0 0 1px rgba(0, 212, 255, 0.4)',
  },
  sidebar: {
    width: '320px',
    minWidth: '320px',
    height: '100vh',
    overflowY: 'auto',
    background: 'rgba(8, 15, 30, 0.92)',
    backdropFilter: 'blur(20px)',
    borderLeft: '1px solid rgba(0, 180, 255, 0.15)',
    display: 'flex',
    flexDirection: 'column',
    padding: '20px 16px',
    gap: '16px',
    zIndex: 10,
  },

  brandHeader: {
    display: 'flex',
    flexDirection: 'column',
    marginBottom: '8px',
  },

  brandRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
  },

  brandText: {
    fontSize: '22px',
    fontWeight: '700',
    color: '#00d4ff',
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
  },

  brandSub: {
    fontSize: '11px',
    color: 'rgba(180, 220, 255, 0.5)',
    letterSpacing: '0.08em',
  },

  modeBtn: {
    marginTop: 'auto',
    padding: '10px 16px',
    background: 'rgba(0, 180, 255, 0.12)',
    border: '1px solid rgba(0, 180, 255, 0.3)',
    borderRadius: '8px',
    color: '#00d4ff',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: '500',
    transition: 'all 0.2s ease',
  },

  attribution: {
    fontSize: '10px',
    color: 'rgba(180, 220, 255, 0.3)',
    textAlign: 'center',
    lineHeight: '1.6',
  },
}