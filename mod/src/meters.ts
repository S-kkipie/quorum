import type { RateLimit, TokenCount } from './proto.gen'

type Usage = Partial<Record<'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens', number>>

export const REPORT_INTERVAL_MS = 30_000

export function sumTokens(u: Usage | undefined): TokenCount {
  return {
    in: u?.input_tokens ?? 0,
    out: u?.output_tokens ?? 0,
    cache: (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0),
  }
}

type Measure = {
  rateLimits?: Array<{ kind: string; percentUsed: number; resetsAt?: string }>
  context?: { percent?: number; tokens?: number; window?: number }
}

/**
 * The single source of context percentage and its estimate flag: `percent` as reported
 * (not an estimate), else round(100 * tokens / window) (an estimate), else undefined.
 */
export function contextOf(c: { percent?: number; tokens?: number; window?: number } | undefined): { pct: number; estimate: boolean } | undefined {
  if (!c) return undefined
  const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)))
  if (typeof c.percent === 'number') return { pct: clamp(c.percent), estimate: false }
  if (typeof c.tokens === 'number' && c.window) return { pct: clamp((100 * c.tokens) / c.window), estimate: true }
  return undefined
}

export type MeterPatch = { tokens: TokenCount; rateLimits?: RateLimit[]; usageAt?: number; contextEstimate?: boolean; contextPct?: number }

/**
 * Session token totals and usage reports. A main-turn end always reports the totals and the context;
 * rate limits travel at most once per 30 s, stamped with the time they were measured (usageAt).
 */
export class Meters {
  private tokens: TokenCount = { in: 0, out: 0, cache: 0 }
  private last = -Infinity
  constructor(private deps: { now(): number; update(p: MeterPatch): void }) {}

  addTurn(usage: Usage | undefined): TokenCount {
    const t = sumTokens(usage)
    this.tokens = { in: this.tokens.in + t.in, out: this.tokens.out + t.out, cache: this.tokens.cache + t.cache }
    return t
  }

  report(m: Measure | undefined, at?: number, opts?: { turnEnd?: boolean }): void {
    const now = at ?? this.deps.now()
    const due = now - this.last >= REPORT_INTERVAL_MS
    if (!due && !opts?.turnEnd) return
    const patch: MeterPatch = { tokens: { ...this.tokens } }
    const ctx = contextOf(m?.context)
    if (ctx) { patch.contextPct = ctx.pct; patch.contextEstimate = ctx.estimate }
    if (due) this.last = now
    const rateLimits = due ? rateLimitsOf(m) : undefined
    if (rateLimits) {
      patch.rateLimits = rateLimits
      patch.usageAt = now
    }
    this.deps.update(patch)
  }

  /**
   * The usage read once when the session starts: its rate limits go out at once (no 30 s throttle),
   * so the account shows on the board before the first turn ends. Without rate limits nothing is sent.
   */
  reportStart(m: Measure | undefined, at?: number): void {
    const rateLimits = rateLimitsOf(m)
    if (!rateLimits?.length) return
    const now = at ?? this.deps.now()
    this.last = now
    this.deps.update({ tokens: { ...this.tokens }, rateLimits, usageAt: now })
  }
}

function rateLimitsOf(m: Measure | undefined): RateLimit[] | undefined {
  if (!Array.isArray(m?.rateLimits)) return undefined
  return m.rateLimits
    .filter(r => r.kind === 'five_hour' || r.kind === 'seven_day')
    .map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt ?? '' }))
}
