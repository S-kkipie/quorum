export type Tone = 'ok' | 'warn' | 'danger'

const trim = (n: number): string => String(Math.round(n * 10) / 10)

/** Compact token count: `999`, `1.2k`, `12k`, `1.2M`. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  if (n < 1000) return String(Math.round(n))
  const k = n < 10_000 ? Math.round(n / 100) / 10 : Math.round(n / 1000)
  if (k < 1000) return trim(k) + 'k'
  const m = n / 1_000_000
  return trim(m < 10 ? m : Math.round(m)) + 'M'
}

/** Subscription usage: warn at 80 %, danger at 95 %. */
export const usageTone = (pct: number): Tone => (pct >= 95 ? 'danger' : pct >= 80 ? 'warn' : 'ok')

/** Context window fill: warn at 50 %, danger at 75 %. */
export const contextTone = (pct: number): Tone => (pct >= 75 ? 'danger' : pct >= 50 ? 'warn' : 'ok')

/** Time until an ISO instant: `2h 10m`, `45m`, `3d`; empty when unknown or already past. */
export function resetIn(iso: string, now: number): string {
  const t = Date.parse(iso)
  if (!iso || Number.isNaN(t) || t <= now) return ''
  const mins = Math.floor((t - now) / 60_000)
  if (mins >= 1440) return `${Math.floor(mins / 1440)}d`
  if (mins >= 60) return `${Math.floor(mins / 60)}h ${mins % 60}m`
  return `${mins}m`
}

export const toneClass: Record<Tone, string> = { ok: 'text-zinc-500', warn: 'text-amber-400', danger: 'text-red-400' }
