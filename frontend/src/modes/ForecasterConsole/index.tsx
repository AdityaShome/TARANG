import React from 'react'

import { SceneManager } from '../../scene/SceneManager'
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
  const t = useT()
  const [showGlossary, setShowGlossary] = useState(false)

  return (
    <div id="forecaster-console" style={styles.container}>
      {/* ── 3D Scene (shared render core) ────────────────────────────── */}
      <div style={styles.sceneWrapper}>
        <SceneManager />
        {!hasSearchedRegion && (
          <div id="search-hint" style={styles.searchHint}>
            {t('searchHint')}
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

      {/* ── Thermal Legend ────────────────────────────────────────────── */}
      <Legend />
      
      {/* ── Glossary Panel ────────────────────────────────────────────── */}
      {showGlossary && <GlossaryPanel onClose={() => setShowGlossary(false)} />}
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
    zIndex:         5,
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