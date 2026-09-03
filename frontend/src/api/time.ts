/**
 * Turn a source's /api/metadata time_range ({ start, end, steps }) into a list of human-readable
 * per-step labels — the file's real datetimes, not "T+N".
 *
 * Steps are evenly spaced in every dataset this app ingests (daily means, 3-hourly forecasts…),
 * so we interpolate between start and end rather than needing the full coordinate array.
 *   - daily (or coarser) spacing  →  "26 Aug"
 *   - sub-daily spacing           →  "2 Sep 04:30"
 * Falls back to "T+N" if the timestamps can't be parsed.
 */
export function buildTimeStepLabels(start?: string, end?: string, steps?: number): string[] {
  const n = Math.max(0, steps ?? 0)
  const fallback = () => Array.from({ length: n }, (_, i) => `T+${i}`)
  if (!start || n < 1) return fallback()

  // Trim nanoseconds ("2026-08-26T00:00:00.000000000") — Date can't parse them.
  const t0 = Date.parse(start.slice(0, 19).replace(' ', 'T'))
  const t1 = Date.parse((end ?? start).slice(0, 19).replace(' ', 'T'))
  if (Number.isNaN(t0)) return fallback()

  const span = n > 1 && !Number.isNaN(t1) ? (t1 - t0) / (n - 1) : 0
  const subDaily = span > 0 && span < 20 * 3600 * 1000

  return Array.from({ length: n }, (_, i) => {
    const d = new Date(t0 + span * i)
    const day = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    return subDaily
      ? `${day} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
      : day
  })
}
