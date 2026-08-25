import React, { useEffect } from 'react'
import { useTarangStore } from './state/store'
import { fetchSources, fetchMetadata } from './api/client'
import { ForecasterConsole } from './modes/ForecasterConsole'
import { ExplorerMode } from './modes/ExplorerMode'
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
export default function App() {
  const uiMode          = useTarangStore(s => s.uiMode)
  const activeSourceId  = useTarangStore(s => s.activeSourceId)
  const setSources      = useTarangStore(s => s.setSources)
  const setDepthLevels  = useTarangStore(s => s.setDepthLevels)
  const setTimeSteps    = useTarangStore(s => s.setTimeSteps)
  const setActiveVar    = useTarangStore(s => s.setActiveVar)
  const setColormap     = useTarangStore(s => s.setColormap)
  const setLoading      = useTarangStore(s => s.setLoading)
  const setError        = useTarangStore(s => s.setError)

  // ── Bootstrap: load sources + initial metadata ─────────────────────────────
  useEffect(() => {
    const controller = new AbortController()

    async function bootstrap() {
      setLoading(true)
      try {
        // 1. Load source list
        const sources = await fetchSources(controller.signal)
        setSources(sources)

        // 2. Load metadata for the active source (drives selectors)
        const meta = await fetchMetadata(activeSourceId, controller.signal)
        setDepthLevels(meta.depth_levels)
        setTimeSteps(meta.time_range?.steps
          ? Array.from({ length: meta.time_range.steps }, (_, i) => `T+${i}`)
          : []
        )

        // Set colormap bounds from CF metadata (NEVER hand-typed — §20 Rule 2)
        const varMeta = meta.cf_metadata[meta.available_variables[0]]
        if (varMeta) {
          setActiveVar(meta.available_variables[0])
          setColormap({ min: varMeta.valid_min, max: varMeta.valid_max })
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

  return (
    <div id="tarang-root" style={{ width: '100vw', height: '100vh', overflow: 'hidden' }}>
      {uiMode === 'console'
        ? <ForecasterConsole />
        : <ExplorerMode />
      }
    </div>
  )
}
