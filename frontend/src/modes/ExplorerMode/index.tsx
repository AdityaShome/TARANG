import React, { useEffect, useRef, useState } from 'react'
import { SceneManager } from '../../scene/SceneManager'
import { useTarangStore } from '../../state/store'
import { LanguageSwitcher } from '../../components/LanguageSwitcher'
import { useT } from '../../i18n/useT'
import type { TranslationKey } from '../../i18n/translations'

/**
 * Explorer Mode — Public outreach / science communication (§2, §10)
 *
 * A second UI shell wrapping the SAME SceneManager (shared render core).
 * Shows a guided 20-second camera flythrough over the Bay of Bengal
 * with plain-language captions — no jargon.
 * Named as a real deliverable in the PS, not a bonus. (§1, §13)
 */

interface KeyFrame {
  captionKey: TranslationKey
  duration:   number  // ms
}

// Caption text lives in i18n/translations.ts (flythrough1..6) so the script re-renders in
// whatever language the researcher/visitor picked via LanguageSwitcher.
const FLYTHROUGH_SCRIPT: KeyFrame[] = [
  { captionKey: 'flythrough1', duration: 3000 },
  { captionKey: 'flythrough2', duration: 4000 },
  { captionKey: 'flythrough3', duration: 4000 },
  { captionKey: 'flythrough4', duration: 4000 },
  { captionKey: 'flythrough5', duration: 4000 },
  { captionKey: 'flythrough6', duration: 5000 },
]

export function ExplorerMode() {
  const setUIMode        = useTarangStore(s => s.setUIMode)
  const [frameIdx, setFrameIdx] = useState(0)
  const [visible, setVisible]   = useState(true)
  const timerRef = useRef<ReturnType<typeof setTimeout>>()
  const t = useT()

  // Auto-advance captions
  useEffect(() => {
    if (frameIdx >= FLYTHROUGH_SCRIPT.length) return

    const frame = FLYTHROUGH_SCRIPT[frameIdx]
    timerRef.current = setTimeout(() => {
      setVisible(false)
      setTimeout(() => {
        setFrameIdx(i => i + 1)
        setVisible(true)
      }, 400)
    }, frame.duration)

    return () => clearTimeout(timerRef.current)
  }, [frameIdx])

  const captionKey = FLYTHROUGH_SCRIPT[frameIdx]?.captionKey
  const caption = captionKey ? t(captionKey) : ''

  return (
    <div id="explorer-mode" style={styles.container}>
      {/* ── Shared 3D Scene ─────────────────────────────────────────────── */}
      <SceneManager autoRotate />

      {/* ── Caption overlay ─────────────────────────────────────────────── */}
      <div style={styles.captionOverlay}>
        <div style={{
          ...styles.caption,
          opacity: visible ? 1 : 0,
          transform: visible ? 'translateY(0)' : 'translateY(10px)',
        }}>
          {caption}
        </div>

        {/* Progress dots */}
        <div style={styles.dots}>
          {FLYTHROUGH_SCRIPT.map((_, i) => (
            <div key={i} style={{
              ...styles.dot,
              background: i === frameIdx ? '#00d4ff' : 'rgba(255,255,255,0.3)',
            }} />
          ))}
        </div>
      </div>

      {/* ── TARANG brand ─────────────────────────────────────────────────── */}
      <div style={styles.brand}>
        <span style={styles.brandText}>TARANG</span>
        <span style={styles.brandSub}>{t('explorerBrandSub')}</span>
      </div>

      {/* ── Language switcher ───────────────────────────────────────────── */}
      <div style={styles.langSwitcher}>
        <LanguageSwitcher variant="glass" />
      </div>

      {/* ── Switch to Console ─────────────────────────────────────────────── */}
      <button
        id="switch-to-console"
        style={styles.consoleBtn}
        onClick={() => setUIMode('console')}
      >
        🔬 {t('consoleModeBtn')} →
      </button>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: 'relative',
    width:    '100vw',
    height:   '100vh',
    background: '#020810',
    overflow: 'hidden',
  },
  captionOverlay: {
    position:   'absolute',
    bottom:     '80px',
    left:       '50%',
    transform:  'translateX(-50%)',
    textAlign:  'center',
    zIndex:     20,
    display:    'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap:        '16px',
  },
  caption: {
    maxWidth:       '640px',
    fontSize:       '20px',
    fontWeight:     '500',
    color:          '#e8f4ff',
    lineHeight:     '1.5',
    textShadow:     '0 2px 20px rgba(0,0,0,0.8)',
    transition:     'opacity 0.4s ease, transform 0.4s ease',
    padding:        '16px 24px',
    background:     'rgba(0, 10, 30, 0.7)',
    borderRadius:   '12px',
    backdropFilter: 'blur(12px)',
    border:         '1px solid rgba(0, 180, 255, 0.2)',
  },
  dots: {
    display: 'flex',
    gap:     '8px',
  },
  dot: {
    width:        '8px',
    height:       '8px',
    borderRadius: '50%',
    transition:   'background 0.3s ease',
  },
  brand: {
    position:      'absolute',
    top:           '32px',
    left:          '40px',
    display:       'flex',
    flexDirection: 'column',
    zIndex:        20,
  },
  brandText: {
    fontSize:   '28px',
    fontWeight: '700',
    color:      '#00d4ff',
    letterSpacing: '0.12em',
  },
  brandSub: {
    fontSize: '12px',
    color:    'rgba(180, 220, 255, 0.5)',
    letterSpacing: '0.06em',
  },
  langSwitcher: {
    position: 'absolute',
    top:      '32px',
    right:    '220px',
    zIndex:   20,
  },
  consoleBtn: {
    position:       'absolute',
    top:            '32px',
    right:          '40px',
    padding:        '12px 20px',
    background:     'rgba(0, 180, 255, 0.15)',
    border:         '1px solid rgba(0, 180, 255, 0.4)',
    borderRadius:   '10px',
    color:          '#00d4ff',
    fontSize:       '14px',
    fontWeight:     '600',
    cursor:         'pointer',
    zIndex:         20,
    backdropFilter: 'blur(8px)',
    transition:     'all 0.2s ease',
  },
}
