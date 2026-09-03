import { useEffect } from 'react'
import { useTarangStore } from './state/store'
import { fetchSources, fetchMetadata } from './api/client'
import { buildTimeStepLabels } from './api/time'
import { prewarmIndiaRegion } from './api/prewarm'
import { ForecasterConsole } from './modes/ForecasterConsole'
import { ExplorerMode } from './modes/ExplorerMode'
import { VolumeWorkspace } from './modes/VolumeWorkspace'
import './index.css'

/**
 * App Shell — Mode Router
 *
 * Reads uiMode from the central store and renders either:
 *   'console'  → ForecasterConsole (power-user, all controls visible)
 *   'explorer' → ExplorerMode (guided flythrough, public outreach)
 *
 * Both modes share the same SceneManager underneath — one render core. (§10)
 *
 * On mount: loads the source list and initial metadata from /api/sources
 * and /api/metadata to populate all selectors before the scene renders.
 */
import { HomeOverlay } from './components/HomeOverlay'

export default function App() {
  const uiMode          = useTarangStore(s => s.uiMode)
  const renderMode      = useTarangStore(s => s.renderMode)
  const activeSourceId  = useTarangStore(s => s.activeSourceId)
  const setSources      = useTarangStore(s => s.setSources)
  const setDepthLevels  = useTarangStore(s => s.setDepthLevels)
  const setTimeSteps    = useTarangStore(s => s.setTimeSteps)
  const setActiveVar    = useTarangStore(s => s.setActiveVar)
  const setVariableMeta = useTarangStore(s => s.setVariableMeta)
  const setLoading      = useTarangStore(s => s.setLoading)
  const setError        = useTarangStore(s => s.setError)

  // ── Bootstrap: load sources + initial metadata ─────────────────────────────
  useEffect(() => {
    const controller = new AbortController()

    async function bootstrap() {
      setLoading(true)
      try {
        // 1. Load source list. A transient empty response (backend mid-reload,
        //    cold-start bind-mount race) must NOT clobber a good list — keep what
        //    we have and let the healer poll below recover it.
        const sources = await fetchSources(controller.signal)
        if (sources.length > 0) {
          setSources(sources)
        } else if (useTarangStore.getState().sources.length === 0) {
          throw new Error('backend returned no data sources (starting up?)')
        }

        // 2. Load metadata for the active source (drives selectors)
        const meta = await fetchMetadata(activeSourceId, controller.signal)
        setDepthLevels(meta.depth_levels)
        setTimeSteps(buildTimeStepLabels(
          meta.time_range?.start,
          meta.time_range?.end,
          meta.time_range?.steps,
        ))

        // Feed the variable dropdown; setActiveVar seeds the colour range from CF metadata.
        setVariableMeta(meta.available_variables, meta.cf_metadata)
        const initialVar = meta.available_variables[0]
        if (initialVar) {
          setActiveVar(initialVar)
          // India is the default scope — warm its region so click/drag picks are fast.
          if (useTarangStore.getState().viewScope === 'india') {
            prewarmIndiaRegion(activeSourceId, initialVar)
          }
        }
      } catch (e: unknown) {
        if ((e as Error).name !== 'AbortError') {
          setError(`Failed to connect to backend: ${(e as Error).message}`)
        }
      } finally {
        setLoading(false)
      }
    }

    bootstrap()
    return () => controller.abort()
  }, [activeSourceId])  // re-run when source changes

  // ── Self-healer: the UI must never sit broken. Every 4 s, if the source list
  //    is empty OR the active source isn't in the list (backend restarted /
  //    registry reloaded a different set), re-fetch and re-bootstrap. Also runs
  //    on tab-focus. Idle no-op in the healthy case.
  useEffect(() => {
    let running = false
    async function heal() {
      if (running) return
      const st = useTarangStore.getState()
      const stale = st.sources.length === 0 || !st.sources.some(s => s.id === st.activeSourceId)
      if (!stale) return
      running = true
      try {
        const sources = await fetchSources()
        if (sources.length > 0) {
          setSources(sources)
          // Snap to a valid source if the current one vanished.
          const sourceId = sources.some(s => s.id === useTarangStore.getState().activeSourceId)
            ? useTarangStore.getState().activeSourceId
            : sources[0].id
          if (sourceId !== useTarangStore.getState().activeSourceId) {
            useTarangStore.getState().setActiveSource(sourceId)
          }
          const meta = await fetchMetadata(sourceId)
          setDepthLevels(meta.depth_levels)
          setTimeSteps(buildTimeStepLabels(meta.time_range?.start, meta.time_range?.end, meta.time_range?.steps))
          setVariableMeta(meta.available_variables, meta.cf_metadata)
          if (meta.available_variables[0]) setActiveVar(meta.available_variables[0])
          setError(null)
        }
      } catch { /* still down — next tick */ }
      finally { running = false }
    }
    const id = setInterval(heal, 4000)
    window.addEventListener('focus', heal)
    heal()
    return () => { clearInterval(id); window.removeEventListener('focus', heal) }
  }, [])

  return (
    <div id="tarang-root" style={{ width: '100vw', height: '100vh', overflow: 'hidden' }}>
      <HomeOverlay />
      {renderMode === 'cube' 
        ? <VolumeWorkspace /> 
        : uiMode === 'console'
          ? <ForecasterConsole />
          : <ExplorerMode />
      }
    </div>
  )
}
