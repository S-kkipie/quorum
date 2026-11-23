import type { Asks, SettleWhy } from './control'

/**
 * Margin below the wait cap: the wait is cut earlier so that we return the
 * verdict ourselves instead of the engine discarding the hook.
 */
export const BUDGET_MARGIN_MS = 60_000
/**
 * A tool.check hook has 10 s of its own time and up to 20 min of in-flight `$`.
 * While the `$.ui.ask` dialog is open neither of them runs; in addition
 * `quorumd hold` (a live `$`) sustains the wait in case the dialog does not.
 * The race is bounded to those 20 min minus the margin.
 */
export const HOLD_MAX_MS = 20 * 60_000 - BUDGET_MARGIN_MS

export const TERM_ALLOW = 'Allow'
export const TERM_DENY = 'Deny'
export const QUESTION_MAX = 120

export const REASON = {
  device: 'Allowed from Quorum',
  deviceDeny: 'Denied from Quorum',
  terminal: 'Allowed in the terminal',
  terminalDeny: 'Denied in the terminal',
  timeout: 'No answer in 19 min (Quorum)',
  interrupted: 'Turn interrupted',
} as const

export const LATE_NOTICE = 'Already decided from Quorum'
/**
 * A `$.ui.ask` rejection sooner than this is not an Esc (nobody reads and closes
 * that fast): there is nobody to answer in the terminal (e.g. a -p run).
 */
export const NO_TERMINAL_MS = 500

export type PermissionDeps = {
  /**
   * The terminal dialog (`$.ui.ask`); rejects if the owner closes it (Esc).
   * No cancellation. Absent: session without a terminal, only the device answers.
   */
  termAsk?: (q: string) => Promise<unknown>
  asks: Asks
  /** Keeps the hook alive until `until` resolves (`quorumd hold`). */
  keepAlive: (until: Promise<unknown>) => void | Promise<void>
  /** `next.signal`: the turn (or the subagent) was cut. */
  signal?: AbortSignal
  /** Line for the owner in the terminal (`$.ui.log`). */
  log?: (msg: string) => void
  /** Clock in ms (Date.now by default), for NO_TERMINAL_MS. */
  now?: () => number
}

export type PermissionVerdict = { decision: 'allow' | 'deny'; reason: string }

/** `"<tool>: <summary>"` on one line, capped at QUESTION_MAX characters. */
export function permissionQuestion(tool: string, summary: string): string {
  const flat = summary.replace(/\s+/g, ' ').trim()
  const q = flat ? `${tool}: ${flat}` : tool
  return q.length > QUESTION_MAX ? `${q.slice(0, QUESTION_MAX - 1)}…` : q
}

/**
 * Race of a permission: the terminal dialog and the card on the devices
 * at once; the first answer wins.
 *
 * - A device wins: ask_resolved is not emitted (the hub emits its own); the terminal
 *   dialog stays open and its late answer only leaves a notice.
 * - The terminal answers (Allow, Deny, other text or Esc, which denies like the
 *   native dialog): the card is withdrawn (ask_resolved{by:'terminal'}).
 * - No terminal (no `termAsk`, or `$.ui.ask` rejects in under NO_TERMINAL_MS):
 *   only the device, up to HOLD_MAX_MS.
 * - Once HOLD_MAX_MS expires, or the turn is cut, it is denied with a reason.
 */
export async function permissionRace(
  deps: PermissionDeps,
  a: { tool: string; summary: string; detail: string; agentId?: string },
): Promise<PermissionVerdict> {
  const { asks, signal } = deps
  if (signal?.aborted) return { decision: 'deny', reason: REASON.interrupted }
  let askId = ''
  let settled = false
  let byDevice = false
  let why: SettleWhy = 'withdrawn'
  let finish!: (v: PermissionVerdict) => void
  const done = new Promise<PermissionVerdict>(r => { finish = r })
  const settle = (v: PermissionVerdict) => {
    if (settled) return
    settled = true
    finish(v)
  }

  const device = asks.ask(
    { kind: 'permission', tool: a.tool, summary: a.summary, detail: a.detail, questions: null },
    HOLD_MAX_MS,
    { onId: id => { askId = id }, agentId: a.agentId, onEnd: w => { why = w } },
  )
  void device.then(d => {
    if (settled) return
    if (d) {
      byDevice = true
      settle(d.decision === 'allow'
        ? { decision: 'allow', reason: REASON.device }
        : { decision: 'deny', reason: d.reason || REASON.deviceDeny })
      return
    }
    // expired, or withdrawn (end of the turn or subagent, session closed)
    settle({ decision: 'deny', reason: why === 'timeout' ? REASON.timeout : REASON.interrupted })
  })

  const onAbort = () => {
    settle({ decision: 'deny', reason: REASON.interrupted })
    asks.withdraw(askId)
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  try { void Promise.resolve(deps.keepAlive(done)).catch(() => {}) } catch { /* no keep-alive: the open dialog sustains it anyway */ }

  const fromTerminal = (v: PermissionVerdict) => {
    settle(v)
    asks.withdraw(askId)
  }
  if (deps.termAsk) raceTerminal(deps.termAsk)

  function raceTerminal(termAsk: (q: string) => Promise<unknown>): void {
    const now = deps.now ?? (() => Date.now())
    const opened = now()
    let term: Promise<unknown>
    try { term = Promise.resolve(termAsk(permissionQuestion(a.tool, a.summary))) } catch (err) { term = Promise.reject(err) }
    void term.then(raw => {
      const answer = typeof raw === 'string' ? raw : ''
      if (settled) {
        // a device won: the late answer changes nothing, only a notice is shown
        if (byDevice) try { deps.log?.(LATE_NOTICE) } catch { /* never toward Claude Code */ }
        return
      }
      fromTerminal(answer === TERM_ALLOW
        ? { decision: 'allow', reason: REASON.terminal }
        : { decision: 'deny', reason: answer === TERM_DENY || !answer.trim() ? REASON.terminalDeny : `${REASON.terminalDeny}: ${answer}` })
    }, () => {
      // too fast to be a person: there is no terminal, only the device continues
      if (now() - opened < NO_TERMINAL_MS) return
      // Esc: the terminal denies, like the native dialog
      if (!settled) fromTerminal({ decision: 'deny', reason: REASON.terminalDeny })
    }).catch(() => {})
  }

  const v = await done
  signal?.removeEventListener('abort', onAbort)
  return v
}
