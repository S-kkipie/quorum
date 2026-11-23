import type { Asks, SettleWhy } from './control'

/**
 * Margen respecto al tope de la espera: la espera se corta antes para devolver el
 * veredicto nosotros en vez de que el engine descarte el hook.
 */
export const BUDGET_MARGIN_MS = 60_000
/**
 * Un hook tool.check tiene 10 s de tiempo propio y hasta 20 min de `$` en curso.
 * Mientras el diálogo `$.ui.ask` está abierto ninguno de los dos corre; además
 * `quorumd hold` (un `$` vivo) sostiene la espera por si el diálogo no lo hiciera.
 * La carrera se acota a esos 20 min menos el margen.
 */
export const HOLD_MAX_MS = 20 * 60_000 - BUDGET_MARGIN_MS

export const TERM_ALLOW = 'Permitir'
export const TERM_DENY = 'Denegar'
export const QUESTION_MAX = 120

export const REASON = {
  device: 'Permitido desde Quorum',
  deviceDeny: 'Denegado desde Quorum',
  terminal: 'Permitido en la terminal',
  terminalDeny: 'Denegado en la terminal',
  timeout: 'Sin respuesta en 19 min (Quorum)',
  interrupted: 'Turno interrumpido',
} as const

export const LATE_NOTICE = 'Ya decidido desde Quorum'
/**
 * Un rechazo de `$.ui.ask` antes de esto no es un Esc (nadie lee y cierra tan
 * rápido): no hay quien conteste en la terminal (p. ej. una corrida -p).
 */
export const NO_TERMINAL_MS = 500

export type PermissionDeps = {
  /**
   * El diálogo de la terminal (`$.ui.ask`); rechaza si el dueño lo cierra (Esc).
   * Sin cancelación. Ausente: sesión sin terminal, solo el dispositivo contesta.
   */
  termAsk?: (q: string) => Promise<unknown>
  asks: Asks
  /** Sostiene el hook mientras `until` no se resuelva (`quorumd hold`). */
  keepAlive: (until: Promise<unknown>) => void | Promise<void>
  /** `next.signal`: el turno (o el subagente) se cortó. */
  signal?: AbortSignal
  /** Línea para el dueño en la terminal (`$.ui.log`). */
  log?: (msg: string) => void
  /** Reloj en ms (por defecto Date.now), para NO_TERMINAL_MS. */
  now?: () => number
}

export type PermissionVerdict = { decision: 'allow' | 'deny'; reason: string }

/** `"<tool>: <summary>"` en una línea, acotado a QUESTION_MAX caracteres. */
export function permissionQuestion(tool: string, summary: string): string {
  const flat = summary.replace(/\s+/g, ' ').trim()
  const q = flat ? `${tool}: ${flat}` : tool
  return q.length > QUESTION_MAX ? `${q.slice(0, QUESTION_MAX - 1)}…` : q
}

/**
 * Carrera de un permiso: el diálogo de la terminal y la tarjeta en los dispositivos
 * a la vez; gana la primera respuesta.
 *
 * - Gana un dispositivo: no se emite ask_resolved (el hub emite el suyo); el diálogo
 *   de la terminal queda abierto y su respuesta tardía solo deja un aviso.
 * - Responde la terminal (Permitir, Denegar, otro texto o Esc, que deniega como el
 *   diálogo nativo): se retira la tarjeta (ask_resolved{by:'terminal'}).
 * - Sin terminal (sin `termAsk`, o `$.ui.ask` rechaza en menos de NO_TERMINAL_MS):
 *   solo el dispositivo, hasta HOLD_MAX_MS.
 * - Vencido HOLD_MAX_MS, o turno cortado, se deniega con motivo.
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
    // vencida, o retirada (fin del turno o del subagente, cierre de la sesión)
    settle({ decision: 'deny', reason: why === 'timeout' ? REASON.timeout : REASON.interrupted })
  })

  const onAbort = () => {
    settle({ decision: 'deny', reason: REASON.interrupted })
    asks.withdraw(askId)
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  try { void Promise.resolve(deps.keepAlive(done)).catch(() => {}) } catch { /* sin sostén: el diálogo abierto sostiene igual */ }

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
        // ganó un dispositivo: la respuesta tardía no cambia nada, solo se avisa
        if (byDevice) try { deps.log?.(LATE_NOTICE) } catch { /* nunca hacia Claude Code */ }
        return
      }
      fromTerminal(answer === TERM_ALLOW
        ? { decision: 'allow', reason: REASON.terminal }
        : { decision: 'deny', reason: answer === TERM_DENY || !answer.trim() ? REASON.terminalDeny : `${REASON.terminalDeny}: ${answer}` })
    }, () => {
      // tan rápido no es una persona: no hay terminal, sigue solo el dispositivo
      if (now() - opened < NO_TERMINAL_MS) return
      // Esc: la terminal deniega, como en el diálogo nativo
      if (!settled) fromTerminal({ decision: 'deny', reason: REASON.terminalDeny })
    }).catch(() => {})
  }

  const v = await done
  signal?.removeEventListener('abort', onAbort)
  return v
}
