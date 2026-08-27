
import { useState } from 'react'

export function OceanCopilot() {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')

  const suggestions = [
    'Show temperature at 200m',
    'Show salinity',
    'Show the 20°C isosurface',
    'Show Argo instruments',
  ]

  function handleSubmit() {
    if (!query.trim()) return

    console.log('Ocean Copilot query:', query)
  }

  return (
    <>
      {/* Small AI Copilot button */}
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          style={styles.copilotButton}
          aria-label="Open TARANG AI Copilot"
          title="Open TARANG AI Copilot"
        >
          <span style={styles.icon}>✦</span>
          <span>AI Copilot</span>
        </button>
      )}

      {/* Copilot panel */}
      {isOpen && (
        <div style={styles.panel}>

          {/* Header */}
          <div style={styles.header}>
            <div style={styles.headerContent}>
              <div style={styles.title}>
                ✦ TARANG AI COPILOT
              </div>

              <div style={styles.subtitle}>
                Explore ocean data using natural language
              </div>
            </div>

            <button
              onClick={() => setIsOpen(false)}
              style={styles.closeButton}
              aria-label="Close AI Copilot"
              title="Close"
            >
              ×
            </button>
          </div>

          {/* Input */}
          <div style={styles.inputRow}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleSubmit()
                }
              }}
              placeholder="Ask about the ocean..."
              style={styles.input}
            />

            <button
              onClick={handleSubmit}
              style={styles.askButton}
            >
              Ask
            </button>
          </div>

          {/* Suggestions */}
          <div style={styles.suggestionsTitle}>
            Try asking
          </div>

          <div style={styles.suggestions}>
            {suggestions.map((suggestion) => (
              <button
                key={suggestion}
                onClick={() => setQuery(suggestion)}
                style={styles.suggestion}
              >
                {suggestion}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  )
}

const styles: Record<string, React.CSSProperties> = {
  /*
   * Small button shown when Copilot is closed.
   * It stays on the left side of the visualization
   * without taking up a large amount of space.
   */
  copilotButton: {
    position: 'absolute',
    top: '20px',
    left: '20px',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '10px 14px',
    borderRadius: '10px',
    border: '1px solid rgba(0, 212, 255, 0.35)',
    background: 'rgba(8, 15, 30, 0.88)',
    backdropFilter: 'blur(16px)',
    boxShadow: '0 8px 30px rgba(0, 0, 0, 0.3)',
    color: '#00d4ff',
    cursor: 'pointer',
    fontSize: '12px',
    fontWeight: 600,
    letterSpacing: '0.03em',
    zIndex: 30,
    transition: 'all 0.2s ease',
  },

  icon: {
    fontSize: '16px',
    lineHeight: 1,
  },

  /*
   * Full Copilot panel.
   * This only appears after clicking the button.
   */
  panel: {
    position: 'absolute',
    top: '20px',
    left: '20px',
    width: '360px',
    padding: '18px',
    borderRadius: '14px',
    background: 'rgba(8, 15, 30, 0.94)',
    backdropFilter: 'blur(20px)',
    border: '1px solid rgba(0, 180, 255, 0.25)',
    boxShadow: '0 12px 40px rgba(0, 0, 0, 0.4)',
    zIndex: 30,
    color: '#ffffff',
    fontFamily: "'Inter', sans-serif",
    boxSizing: 'border-box',
  },

  header: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '12px',
    marginBottom: '14px',
  },

  headerContent: {
    minWidth: 0,
  },

  title: {
    fontSize: '15px',
    fontWeight: 700,
    letterSpacing: '0.08em',
    color: '#00d4ff',
  },

  subtitle: {
    marginTop: '4px',
    fontSize: '11px',
    color: 'rgba(210, 230, 255, 0.55)',
    lineHeight: '1.4',
  },

  closeButton: {
    width: '28px',
    height: '28px',
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    borderRadius: '7px',
    border: '1px solid rgba(255, 255, 255, 0.1)',
    background: 'rgba(255, 255, 255, 0.05)',
    color: 'rgba(220, 235, 255, 0.75)',
    cursor: 'pointer',
    fontSize: '20px',
    lineHeight: 1,
  },

  inputRow: {
    display: 'flex',
    gap: '8px',
  },

  input: {
    flex: 1,
    minWidth: 0,
    padding: '10px 12px',
    borderRadius: '8px',
    border: '1px solid rgba(255, 255, 255, 0.12)',
    background: 'rgba(255, 255, 255, 0.06)',
    color: '#ffffff',
    outline: 'none',
    fontSize: '12px',
    boxSizing: 'border-box',
  },

  askButton: {
    padding: '10px 14px',
    borderRadius: '8px',
    border: '1px solid rgba(0, 212, 255, 0.35)',
    background: 'rgba(0, 180, 255, 0.16)',
    color: '#00d4ff',
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: '12px',
  },

  suggestionsTitle: {
    marginTop: '16px',
    marginBottom: '8px',
    fontSize: '10px',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: 'rgba(180, 220, 255, 0.45)',
  },

  suggestions: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },

  suggestion: {
    padding: '8px 10px',
    textAlign: 'left',
    borderRadius: '7px',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    background: 'rgba(255, 255, 255, 0.04)',
    color: 'rgba(220, 235, 255, 0.8)',
    cursor: 'pointer',
    fontSize: '11px',
  },
}