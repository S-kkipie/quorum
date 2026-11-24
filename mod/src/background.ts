import type { BackgroundInfo } from './proto.gen'

/** What is left of a session once its turn ends: live background tasks and the next wake-up. */
export type { BackgroundInfo }

/** The state a session is in between turns: `background` with anything pending, else `idle`. */
export function stateOf(bg: BackgroundInfo): 'background' | 'idle' {
  return bg.tasks > 0 || bg.wakeAt > 0 ? 'background' : 'idle'
}

const END_STATUS = new Set(['completed', 'failed', 'killed', 'stopped', 'cancelled', 'canceled', 'error', 'timeout'])

/**
 * Task ids a `<task-notification>` prompt reports as ended (a status like completed,
 * failed or killed). A monitor's event (no status, or `running`) ends nothing.
 */
export function taskEnds(text: string): string[] {
  const out: string[] = []
  for (const m of String(text ?? '').matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const body = m[1] ?? ''
    const id = /<task-id>\s*([^<]+?)\s*<\/task-id>/.exec(body)?.[1]
    const status = /<status>\s*([^<]+?)\s*<\/status>/.exec(body)?.[1]?.toLowerCase()
    if (id && status && END_STATUS.has(status)) out.push(id)
  }
  return out
}

const CRON_HORIZON_DAYS = 1500

/** One cron field as the set of values it matches, or undefined when malformed. */
function field(s: string, min: number, max: number): Set<number> | undefined {
  const out = new Set<number>()
  for (const part of s.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part)
    if (!m) return undefined
    let lo = min
    let hi = max
    if (m[1] !== '*') {
      const [a = NaN, b] = (m[1] ?? '').split('-').map(Number)
      lo = a
      hi = b ?? (m[2] ? max : a)
    }
    const step = m[2] ? Number(m[2]) : 1
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi || step < 1) return undefined
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out
}

/**
 * The first time after `from` (ms) a 5-field cron expression (local time) matches, in ms;
 * undefined when malformed or nothing matches within ~4 years (a Feb 29 cron included).
 */
export function nextCron(expr: string, from: number): number | undefined {
  const parts = String(expr ?? '').trim().split(/\s+/)
  const [p0 = '', p1 = '', p2 = '', p3 = '', p4 = ''] = parts
  if (parts.length !== 5) return undefined
  const [mi, ho, dom, mon, dow] = [field(p0, 0, 59), field(p1, 0, 23), field(p2, 1, 31), field(p3, 1, 12), field(p4, 0, 7)]
  if (!mi || !ho || !dom || !mon || !dow) return undefined
  if (dow.has(7)) dow.add(0)
  // vixie cron: a day field starting with `*` (`*`, `*/2`) does not restrict, so the other one decides
  const domAny = p2.startsWith('*')
  const dowAny = p4.startsWith('*')
  const minutes = [...mi].sort((a, b) => a - b)
  const hours = [...ho].sort((a, b) => a - b)
  const start = new Date(from)
  for (let d = 0; d <= CRON_HORIZON_DAYS; d++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + d)
    if (!mon.has(day.getMonth() + 1)) continue
    // standard cron: with both day fields restricted, either one matching is enough
    const okDom = dom.has(day.getDate())
    const okDow = dow.has(day.getDay())
    if (!(domAny && dowAny) && !(domAny ? okDow : dowAny ? okDom : okDom || okDow)) continue
    for (const h of hours) {
      for (const m of minutes) {
        const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).getTime()
        if (t > from) return t
      }
    }
  }
  return undefined
}
