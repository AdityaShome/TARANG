import React from 'react'
import { useTarangStore } from '../state/store'
import { LANGUAGES, LanguageCode } from '../i18n/translations'

interface Props {
  variant?: 'dark' | 'glass'
}

export function LanguageSwitcher({ variant = 'dark' }: Props) {
  const language    = useTarangStore(s => s.language)
  const setLanguage = useTarangStore(s => s.setLanguage)

  return (
    <select
      id="language-select"
      value={language}
      onChange={e => setLanguage(e.target.value as LanguageCode)}
      style={variant === 'glass' ? styles.selectGlass : styles.selectDark}
      aria-label="Language"
    >
      {LANGUAGES.map(l => (
        <option key={l.code} value={l.code}>{l.nativeLabel}</option>
      ))}
    </select>
  )
}

const styles: Record<string, React.CSSProperties> = {
  selectDark: {
    background: 'rgba(0, 30, 60, 0.8)', border: '1px solid rgba(0, 180, 255, 0.2)',
    borderRadius: '6px', color: '#a0c4e8', padding: '5px 8px', fontSize: '12px', cursor: 'pointer',
  },
  selectGlass: {
    background: 'rgba(0, 180, 255, 0.12)', border: '1px solid rgba(0, 180, 255, 0.35)',
    borderRadius: '8px', color: '#00d4ff', padding: '8px 12px', fontSize: '13px',
    fontWeight: 600, cursor: 'pointer', backdropFilter: 'blur(8px)',
  },
}
