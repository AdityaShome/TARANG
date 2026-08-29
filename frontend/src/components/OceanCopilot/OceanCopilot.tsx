import { useState } from 'react'
import { useTarangStore } from '../../state/store'


// ============================================================
// TYPES
// ============================================================

interface CopilotAction {
  type: string
  value?: string | number | boolean | null
}


interface CopilotResponse {
  answer: string
  requires_confirmation: boolean
  actions: CopilotAction[]
}


// ============================================================
// BACKEND
// ============================================================

const BACKEND_URL =
  import.meta.env.VITE_BACKEND_URL ||
  'http://127.0.0.1:8001'


// ============================================================
// COMPONENT
// ============================================================

export function OceanCopilot() {

  const [isOpen, setIsOpen] =
    useState(false)

  const [query, setQuery] =
    useState('')

  const [answer, setAnswer] =
    useState('')

  const [pendingActions, setPendingActions] =
    useState<CopilotAction[]>([])

  const [loading, setLoading] =
    useState(false)

  const [error, setError] =
    useState('')


  // ==========================================================
  // TARANG ZUSTAND ACTIONS
  // ==========================================================

  const setActiveVar =
    useTarangStore(
      s => s.setActiveVar
    )

  const setActiveDepthIdx =
    useTarangStore(
      s => s.setActiveDepthIdx
    )

  const setRenderMode =
    useTarangStore(
      s => s.setRenderMode
    )

  const setIsoThreshold =
    useTarangStore(
      s => s.setIsoThreshold
    )

  const toggleLayer =
    useTarangStore(
      s => s.toggleLayer
    )

  const depthLevels =
    useTarangStore(
      s => s.depthLevels
    )


  // ==========================================================
  // EXAMPLE SUGGESTIONS
  //
  // These are ONLY examples.
  // They DO NOT limit what the AI can understand.
  // ==========================================================

  const suggestions = [
    'Show temperature at 200m',
    'Show salinity at 30m',
    'Show threshold at 10 degrees',
    'Show salinity at 50m with threshold 15',
  ]


  // ==========================================================
  // ASK OPENROUTER
  // ==========================================================

  async function askCopilot(
    customQuery?: string
  ) {

    const userQuery =
      (
        customQuery ??
        query
      ).trim()


    if (
      !userQuery ||
      loading
    ) {
      return
    }


    setQuery(
      userQuery
    )

    setAnswer('')

    setError('')

    setPendingActions([])

    setLoading(true)


    try {

      const response =
        await fetch(
          `${BACKEND_URL}/api/copilot`,
          {
            method: 'POST',

            headers: {
              'Content-Type':
                'application/json',
            },

            body: JSON.stringify({
              query: userQuery,
            }),
          }
        )


      const data:
        CopilotResponse =
        await response.json()


      if (!response.ok) {

        // FastAPI error responses come back as { "detail": "..." },
        // not { "answer": "..." } — check detail first so the real
        // backend error message is surfaced instead of a generic one.
        throw new Error(
          (data as any)?.detail ||
          data?.answer ||
          'Copilot request failed'
        )
      }


      setAnswer(
        data.answer ||
        'I could not generate a response.'
      )


      // ======================================================
      // STORE ALL AI ACTIONS
      // ======================================================

      if (
        data.requires_confirmation &&
        Array.isArray(
          data.actions
        ) &&
        data.actions.length > 0
      ) {

        setPendingActions(
          data.actions
        )
      }


    } catch (err) {

      console.error(
        'TARANG Copilot error:',
        err
      )


      setError(
        err instanceof Error
          ? err.message
          : 'Unable to connect to TARANG AI Copilot'
      )


    } finally {

      setLoading(false)
    }
  }


  // ==========================================================
  // FIND CLOSEST DEPTH INDEX
  //
  // TARANG uses depth INDEX internally.
  // The user speaks in meters.
  //
  // Example:
  // user asks 30m
  // dataset contains [0, 10, 25, 50, ...]
  // closest = 25m
  // index = 2
  // ==========================================================

  function findClosestDepthIndex(
    requestedDepth: number
  ): number {

    if (
      depthLevels.length === 0
    ) {

      throw new Error(
        'Depth levels are not loaded yet'
      )
    }


    let closestIndex = 0

    let closestDifference =
      Math.abs(
        depthLevels[0] -
        requestedDepth
      )


    depthLevels.forEach(
      (
        depth,
        index
      ) => {

        const difference =
          Math.abs(
            depth -
            requestedDepth
          )


        if (
          difference <
          closestDifference
        ) {

          closestDifference =
            difference

          closestIndex =
            index
        }
      }
    )


    return closestIndex
  }


  // ==========================================================
  // APPLY ALL AI ACTIONS
  // ==========================================================

  function applyActions() {

    if (
      pendingActions.length === 0
    ) {
      return
    }


    setError('')


    try {

      for (
        const action
        of pendingActions
      ) {


        // ====================================================
        // VARIABLE
        // ====================================================

        if (
          action.type ===
          'set_variable'
        ) {

          if (
            typeof action.value !==
            'string'
          ) {

            throw new Error(
              'Invalid variable returned by AI'
            )
          }


          setActiveVar(
            action.value
          )


          continue
        }


        // ====================================================
        // GENERIC DEPTH
        //
        // Works for salinity AND temperature.
        // ====================================================

        if (
          action.type ===
          'set_depth'
        ) {

          const requestedDepth =
            Number(
              action.value
            )


          if (
            !Number.isFinite(
              requestedDepth
            )
          ) {

            throw new Error(
              'Invalid depth returned by AI'
            )
          }


          const closestIndex =
            findClosestDepthIndex(
              requestedDepth
            )


          setActiveDepthIdx(
            closestIndex
          )


          continue
        }


        // ====================================================
        // RENDER MODE
        // ====================================================

        if (
          action.type ===
          'set_render_mode'
        ) {

          const mode =
            action.value


          if (
            mode !== 'slice' &&
            mode !== 'volume' &&
            mode !== 'isosurface'
          ) {

            throw new Error(
              `Unsupported render mode: ${mode}`
            )
          }


          setRenderMode(
            mode
          )


          continue
        }


        // ====================================================
        // ISOSURFACE THRESHOLD
        //
        // DYNAMIC:
        // 10 -> 10
        // 20 -> 20
        // 30 -> 30
        // 12.5 -> 12.5
        // ====================================================

        if (
          action.type ===
          'set_isosurface'
        ) {

          const threshold =
            Number(
              action.value
            )


          if (
            !Number.isFinite(
              threshold
            )
          ) {

            throw new Error(
              'Invalid isosurface threshold returned by AI'
            )
          }


          // Automatically switch to isosurface mode.
          setRenderMode(
            'isosurface'
          )


          // Use EXACT value from user.
          setIsoThreshold(
            threshold
          )


          continue
        }


        // ====================================================
        // LAYER
        // ====================================================

        if (
          action.type ===
          'toggle_layer'
        ) {

          if (
            typeof action.value !==
            'string'
          ) {

            throw new Error(
              'Invalid layer returned by AI'
            )
          }


          toggleLayer(
            action.value
          )


          continue
        }


        // ====================================================
        // UNKNOWN ACTION
        // ====================================================

        throw new Error(
          `Unsupported TARANG action: ${action.type}`
        )
      }


      // ======================================================
      // SUCCESS MESSAGE
      // ======================================================

      const count =
        pendingActions.length


      setAnswer(

        count === 1

          ? 'Done. I applied the requested visualization change.'

          : `Done. I applied all ${count} requested visualization changes.`
      )


      setPendingActions([])


    } catch (err) {

      console.error(
        'TARANG action error:',
        err
      )


      setError(
        err instanceof Error
          ? err.message
          : 'Unable to apply visualization changes'
      )
    }
  }


  // ==========================================================
  // NO / CANCEL
  //
  // Do NOT change TARANG.
  //
  // Ask OpenRouter for a natural response.
  // ==========================================================

  async function rejectActions() {

    if (loading) {
      return
    }


    const rejectedRequest =
      query.trim()


    // IMPORTANT:
    // Remove pending actions immediately.
    // Nothing gets applied.
    setPendingActions([])


    setAnswer('')

    setError('')

    setLoading(true)


    try {

      const response =
        await fetch(
          `${BACKEND_URL}/api/copilot`,
          {
            method: 'POST',

            headers: {
              'Content-Type':
                'application/json',
            },

            body: JSON.stringify({

              query: `
The user rejected the visualization changes
you just proposed.

The user clicked NO.

DO NOT make any visualization changes.

Respond naturally and conversationally.

Acknowledge that the requested change was cancelled.

You can ask a helpful follow-up question about
what the user would like to explore.

Do not propose another visualization action
automatically.

Original request:
"${rejectedRequest}"
              `.trim(),

            }),
          }
        )


      const data =
        await response.json()


      if (!response.ok) {

        throw new Error(
          data?.detail ||
          'Cancellation request failed'
        )
      }


      setAnswer(
        data.answer ||
        "No problem. I won't change the visualization. What would you like to explore?"
      )


    } catch (err) {

      console.error(
        'NO response error:',
        err
      )


      // Fallback ONLY if OpenRouter fails.
      setAnswer(
        "No problem. I left the visualization unchanged. What would you like to explore next?"
      )


    } finally {

      setLoading(false)
    }
  }


  // ==========================================================
  // UI
  // ==========================================================

  return (
    <>
      {/* ======================================================
          CLOSED BUTTON
          ====================================================== */}

      {!isOpen && (

        <button
          onClick={() =>
            setIsOpen(true)
          }

          style={
            styles.copilotButton
          }

          aria-label="Open TARANG AI Copilot"

          title="Open TARANG AI Copilot"
        >

          <span
            style={styles.icon}
          >
            ✦
          </span>

          <span>
            AI Copilot
          </span>

        </button>
      )}


      {/* ======================================================
          COPILOT PANEL
          ====================================================== */}

      {isOpen && (

        <div
          style={styles.panel}
        >

          {/* ==================================================
              HEADER
              ================================================== */}

          <div
            style={styles.header}
          >

            <div
              style={
                styles.headerContent
              }
            >

              <div
                style={styles.title}
              >
                ✦ TARANG AI COPILOT
              </div>


              <div
                style={
                  styles.subtitle
                }
              >
                Control ocean visualization
                using natural language
              </div>

            </div>


            <button
              onClick={() =>
                setIsOpen(false)
              }

              style={
                styles.closeButton
              }

              aria-label="Close AI Copilot"
            >
              ×
            </button>

          </div>


          {/* ==================================================
              INPUT
              ================================================== */}

          <div
            style={styles.inputRow}
          >

            <input
              value={query}

              onChange={e =>
                setQuery(
                  e.target.value
                )
              }

              onKeyDown={e => {

                if (
                  e.key ===
                  'Enter'
                ) {

                  askCopilot()
                }
              }}

              placeholder="Ask about the ocean..."

              style={styles.input}

              disabled={loading}
            />


            <button
              onClick={() =>
                askCopilot()
              }

              style={
                styles.askButton
              }

              disabled={
                loading ||
                !query.trim()
              }
            >
              {loading
                ? '...'
                : 'Ask'}
            </button>

          </div>


          {/* ==================================================
              AI ANSWER
              ================================================== */}

          {answer && (

            <div
              style={
                styles.responseBox
              }
            >

              <div
                style={
                  styles.responseLabel
                }
              >
                TARANG AI
              </div>


              <div
                style={styles.answer}
              >
                {answer}
              </div>

            </div>
          )}


          {/* ==================================================
              CONFIRMATION
              ================================================== */}

          {pendingActions.length >
            0 && (

            <div
              style={
                styles.confirmationBox
              }
            >

              <div
                style={
                  styles.confirmationTitle
                }
              >
                ⚙ Visualization changes
              </div>


              <div
                style={
                  styles.confirmationText
                }
              >

                I have prepared{' '}

                <strong>
                  {pendingActions.length}
                </strong>{' '}

                {pendingActions.length ===
                1
                  ? 'change'
                  : 'changes'}{' '}

                for TARANG.

                <br />

                Shall I apply them?

              </div>


              <div
                style={
                  styles.confirmButtons
                }
              >

                <button
                  onClick={
                    applyActions
                  }

                  style={
                    styles.approveButton
                  }

                  disabled={loading}
                >
                  ✓ Yes, apply
                </button>


                <button
                  onClick={
                    rejectActions
                  }

                  style={
                    styles.rejectButton
                  }

                  disabled={loading}
                >
                  ✕ No, cancel
                </button>

              </div>

            </div>
          )}


          {/* ==================================================
              ERROR
              ================================================== */}

          {error && (

            <div
              style={styles.error}
            >
              {error}
            </div>
          )}


          {/* ==================================================
              EXAMPLES
              ================================================== */}

          <div
            style={
              styles.suggestionsTitle
            }
          >
            TRY ASKING
          </div>


          <div
            style={
              styles.suggestions
            }
          >

            {suggestions.map(
              suggestion => (

                <button
                  key={suggestion}

                  onClick={() =>
                    askCopilot(
                      suggestion
                    )
                  }

                  style={
                    styles.suggestion
                  }

                  disabled={loading}
                >
                  {suggestion}
                </button>

              )
            )}

          </div>

        </div>
      )}

    </>
  )
}


// ============================================================
// STYLES
// ============================================================

const styles:
  Record<
    string,
    React.CSSProperties
  > = {

  copilotButton: {

    position: 'absolute',

    top: '20px',

    left: '20px',

    display: 'flex',

    alignItems: 'center',

    gap: '8px',

    padding:
      '10px 14px',

    borderRadius:
      '10px',

    border:
      '1px solid rgba(0, 212, 255, 0.35)',

    background:
      'rgba(8, 15, 30, 0.88)',

    backdropFilter:
      'blur(16px)',

    boxShadow:
      '0 8px 30px rgba(0, 0, 0, 0.3)',

    color:
      '#00d4ff',

    cursor:
      'pointer',

    fontSize:
      '12px',

    fontWeight:
      600,

    letterSpacing:
      '0.03em',

    zIndex:
      30,
  },


  icon: {

    fontSize:
      '16px',

    lineHeight:
      1,
  },


  panel: {

    position:
      'absolute',

    top:
      '20px',

    left:
      '20px',

    width:
      '390px',

    padding:
      '18px',

    borderRadius:
      '14px',

    background:
      'rgba(8, 15, 30, 0.96)',

    backdropFilter:
      'blur(20px)',

    border:
      '1px solid rgba(0, 180, 255, 0.25)',

    boxShadow:
      '0 12px 40px rgba(0, 0, 0, 0.4)',

    zIndex:
      30,

    color:
      '#ffffff',

    fontFamily:
      "'Inter', sans-serif",

    boxSizing:
      'border-box',
  },


  header: {

    display:
      'flex',

    alignItems:
      'flex-start',

    justifyContent:
      'space-between',

    gap:
      '12px',

    marginBottom:
      '14px',
  },


  headerContent: {

    minWidth:
      0,
  },


  title: {

    fontSize:
      '15px',

    fontWeight:
      700,

    letterSpacing:
      '0.08em',

    color:
      '#00d4ff',
  },


  subtitle: {

    marginTop:
      '4px',

    fontSize:
      '11px',

    color:
      'rgba(210, 230, 255, 0.55)',

    lineHeight:
      1.4,
  },


  closeButton: {

    width:
      '28px',

    height:
      '28px',

    flexShrink:
      0,

    display:
      'flex',

    alignItems:
      'center',

    justifyContent:
      'center',

    padding:
      0,

    borderRadius:
      '7px',

    border:
      '1px solid rgba(255, 255, 255, 0.1)',

    background:
      'rgba(255, 255, 255, 0.05)',

    color:
      'rgba(220, 235, 255, 0.75)',

    cursor:
      'pointer',

    fontSize:
      '20px',
  },


  inputRow: {

    display:
      'flex',

    gap:
      '8px',
  },


  input: {

    flex:
      1,

    minWidth:
      0,

    padding:
      '10px 12px',

    borderRadius:
      '8px',

    border:
      '1px solid rgba(255, 255, 255, 0.12)',

    background:
      'rgba(255, 255, 255, 0.06)',

    color:
      '#ffffff',

    outline:
      'none',

    fontSize:
      '12px',

    boxSizing:
      'border-box',
  },


  askButton: {

    padding:
      '10px 14px',

    borderRadius:
      '8px',

    border:
      '1px solid rgba(0, 212, 255, 0.35)',

    background:
      'rgba(0, 180, 255, 0.16)',

    color:
      '#00d4ff',

    cursor:
      'pointer',

    fontWeight:
      600,

    fontSize:
      '12px',
  },


  responseBox: {

    marginTop:
      '14px',

    padding:
      '12px',

    borderRadius:
      '9px',

    background:
      'rgba(0, 180, 255, 0.06)',

    border:
      '1px solid rgba(0, 180, 255, 0.12)',
  },


  responseLabel: {

    fontSize:
      '9px',

    fontWeight:
      700,

    letterSpacing:
      '0.1em',

    color:
      '#00d4ff',

    marginBottom:
      '6px',
  },


  answer: {

    fontSize:
      '12px',

    lineHeight:
      1.5,

    color:
      'rgba(235, 245, 255, 0.9)',
  },


  confirmationBox: {

    marginTop:
      '10px',

    padding:
      '12px',

    borderRadius:
      '9px',

    border:
      '1px solid rgba(0, 212, 255, 0.25)',

    background:
      'rgba(0, 180, 255, 0.06)',
  },


  confirmationTitle: {

    fontSize:
      '11px',

    fontWeight:
      700,

    color:
      '#00d4ff',

    marginBottom:
      '5px',
  },


  confirmationText: {

    fontSize:
      '11px',

    lineHeight:
      1.5,

    color:
      'rgba(235, 240, 255, 0.65)',

    marginBottom:
      '10px',
  },


  confirmButtons: {

    display:
      'flex',

    gap:
      '8px',
  },


  approveButton: {

    flex:
      1,

    padding:
      '9px',

    borderRadius:
      '7px',

    border:
      '1px solid rgba(0, 212, 255, 0.35)',

    background:
      'rgba(0, 212, 255, 0.14)',

    color:
      '#00d4ff',

    cursor:
      'pointer',

    fontSize:
      '11px',

    fontWeight:
      600,
  },


  rejectButton: {

    flex:
      1,

    padding:
      '9px',

    borderRadius:
      '7px',

    border:
      '1px solid rgba(255, 255, 255, 0.12)',

    background:
      'rgba(255, 255, 255, 0.05)',

    color:
      'rgba(235, 240, 255, 0.7)',

    cursor:
      'pointer',

    fontSize:
      '11px',

    fontWeight:
      600,
  },


  error: {

    marginTop:
      '10px',

    padding:
      '9px',

    borderRadius:
      '7px',

    background:
      'rgba(255, 70, 70, 0.08)',

    border:
      '1px solid rgba(255, 70, 70, 0.2)',

    color:
      '#ff8f8f',

    fontSize:
      '11px',

    lineHeight:
      1.4,
  },


  suggestionsTitle: {

    marginTop:
      '16px',

    marginBottom:
      '8px',

    fontSize:
      '10px',

    textTransform:
      'uppercase',

    letterSpacing:
      '0.08em',

    color:
      'rgba(180, 220, 255, 0.45)',
  },


  suggestions: {

    display:
      'flex',

    flexDirection:
      'column',

    gap:
      '6px',
  },


  suggestion: {

    padding:
      '8px 10px',

    textAlign:
      'left',

    borderRadius:
      '7px',

    border:
      '1px solid rgba(255, 255, 255, 0.08)',

    background:
      'rgba(255, 255, 255, 0.04)',

    color:
      'rgba(220, 235, 255, 0.8)',

    cursor:
      'pointer',

    fontSize:
      '11px',
  },
}