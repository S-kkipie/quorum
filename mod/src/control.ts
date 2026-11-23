import { summarize } from './events'
import type { Link } from './link'
import { permissionRace } from './permission'
import type { Ask, Command } from './proto.gen'

// la carrera de permisos vive en permission.ts; sus topes se reexportan aquí
export { BUDGET_MARGIN_MS, HOLD_MAX_MS } from './permission'
/** Mantiene un `$` del hook en curso hasta que `until` se resuelva (lo arma register.ts). */
export type KeepAlive = (until: Promise<unknown>) => void
/** Tras TaskStop, cuánto se espera antes de /exit (que si no abre un diálogo). */
export const CLOSE_SETTLE_MS = 1500
export const SERVICE_INFO = 'Sesión de servicio: Quorum no la controla'
/** Herramientas que siempre piden a la persona: tool.check no las enruta. */
export const NEVER_ASK = new Set(['AskUserQuestion', 'ExitPlanMode'])

export type Decision = { decision: string; reason?: string; answers?: Record<string, string> | null }
export type Verdict = { decision: 'allow' | 'ask' | 'deny'; reason?: string; [k: string]: unknown }
type Emitter = Pick<Link, 'emit' | 'update'>
/** `by` null: se resuelve sin emitir ask_resolved (el hub ya emitió el suyo). */
type Waiter = { kind: string; agentId?: string; settle: (d: Decision | undefined, by: string | null, why: SettleWhy) => void }
/** Por qué se cerró un ask: decidió un dispositivo, venció o se retiró. */
export type SettleWhy = 'decided' | 'timeout' | 'withdrawn'
export type AskOpts = {
  /** Recibe el askId nuevo (para retirarlo después con `withdraw`). */
  onId?: (askId: string) => void
  /** Subagente que pregunta: sus asks se retiran al terminar él (`withdrawAgent`). */
  agentId?: string
  /** Por qué se cerró, justo antes de resolver. */
  onEnd?: (why: SettleWhy) => void
}

/**
 * Preguntas al dispositivo. `ask` emite `ask` + status needs_you y resuelve con la
 * decisión del dispositivo, o undefined si vence o se retira (respondió la terminal,
 * se cortó el turno o se cierra la sesión).
 * Al resolverse por cualquier vía emite `ask_resolved{by}` y, sin otras abiertas,
 * status working.
 */
export class Asks {
  private waiting = new Map<string, Waiter>()

  constructor(
    private getLink: () => Emitter | undefined,
    private sleep: (ms: number) => Promise<void>,
    private newId: () => string,
  ) {}

  private emit(kind: string, data: unknown): void {
    try { this.getLink()?.emit({ kind, data } as never) } catch { /* nunca hacia Claude Code */ }
  }

  private status(state: 'needs_you' | 'working'): void {
    this.emit('status', { state })
    try { this.getLink()?.update({ state }) } catch { /* idem */ }
  }

  ask(a: Omit<Ask, 'askId'>, waitMs: number, opts: AskOpts = {}): Promise<Decision | undefined> {
    const askId = this.newId()
    opts.onId?.(askId)
    return new Promise(resolve => {
      const settle = (d: Decision | undefined, by: string | null, why: SettleWhy) => {
        if (!this.waiting.delete(askId)) return
        if (by !== null) this.emit('ask_resolved', { askId, by })
        if (this.waiting.size === 0) this.status('working')
        try { opts.onEnd?.(why) } catch { /* idem */ }
        resolve(d)
      }
      this.waiting.set(askId, { kind: a.kind, agentId: opts.agentId, settle })
      this.emit('ask', { askId, ...a })
      this.status('needs_you')
      if (Number.isFinite(waitMs)) void this.sleep(waitMs).then(() => settle(undefined, 'terminal', 'timeout'), () => {})
    })
  }

  /**
   * Decisión llegada del dispositivo. El hub ya publicó y guardó su propio
   * ask_resolved con el nombre del dispositivo (el autoritativo): aquí no se emite
   * otro; solo se libera la espera y, si no quedan abiertas, status working.
   */
  resolve(askId: string, decision: Decision): boolean {
    const w = this.waiting.get(askId)
    if (!w) return false
    w.settle(decision, null, 'decided')
    return true
  }

  /** La terminal respondió primero: la copia del dispositivo se retira. */
  withdraw(askId: string): void {
    this.waiting.get(askId)?.settle(undefined, 'terminal', 'withdrawn')
  }

  /** Retira todas las abiertas de un tipo (p. ej. permisos al volver a la terminal). */
  withdrawKind(kind: string): void {
    for (const [id, w] of [...this.waiting]) if (w.kind === kind) this.withdraw(id)
  }

  /** Retira las abiertas de un subagente (terminó su turno). */
  withdrawAgent(agentId: string): void {
    for (const [id, w] of [...this.waiting]) if (w.agentId === agentId) this.withdraw(id)
  }

  get pending(): string[] {
    return [...this.waiting.keys()]
  }
}

export type ControlDeps = {
  getLink: () => Link | undefined
  /** `$.prompt.submit({ text, asUser: true })` */
  submit: (text: string) => Promise<unknown>
  /** `$.turn.abort({ turnId })` */
  abort: (turnId: string) => Promise<unknown>
  /** `$.tool.call({ tool: 'TaskStop', task_id })` */
  stopTask: (id: string) => Promise<unknown>
  /** `$.command.run({ command: 'exit' })` */
  exit: () => Promise<unknown>
  /** `$.clock.sleep(ms)` */
  sleep: (ms: number) => Promise<void>
  newId?: () => string
}

/** Lo que el hook tool.check presta a la carrera de permisos. */
export type PermissionHook = {
  /** `$.ui.ask(q, { options: ['Permitir','Denegar'], header: 'Permiso' })` del propio hook. */
  termAsk: (q: string) => Promise<unknown>
  /**
   * Si hay quien conteste `$.ui.ask` (`$.session.surfaces()` no vacío; vacío en
   * una corrida -p). Se consulta solo cuando corre la carrera. Sin ella, se asume que sí.
   */
  hasTerminal?: () => Promise<boolean>
  /** `next.signal` */
  signal?: AbortSignal
  keepAlive?: KeepAlive
  /** Línea en el transcript (`$.ui.log`). */
  log?: (msg: string) => void
}

type Call = { tool: string; tool_use_id?: string; agentId?: string; [k: string]: unknown }
type CallResult = { deny?: string; result?: unknown; context?: readonly string[]; isError?: boolean; [k: string]: unknown }
type CheckInput = { tool: string; input: unknown; tool_use_id?: string; agentId?: string }

const FROM_DEVICE_MAX = 50
const DETAIL_MAX = 4000

function randomId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Control de la sesión desde Quorum: órdenes del dispositivo, permisos y preguntas.
 * Pura: todo lo de `$` llega por `deps`, así que se prueba con fakes.
 */
export function makeControl(deps: ControlDeps) {
  let turnId: string | undefined
  const midTurn: string[] = []
  const fromDevice: string[] = []
  const tasks = new Set<string>() // tareas de fondo y subagentes vivos que se conocen
  const asks = new Asks(deps.getLink, deps.sleep, deps.newId ?? randomId)

  const link = () => { try { return deps.getLink() } catch { return undefined } }
  /** Sesión de trabajo controlable (no servicio). */
  const controllable = () => { const l = link(); return !!l && l.role !== 'service' }
  const emit = (kind: string, data: unknown) => { try { link()?.emit({ kind, data } as never) } catch { /* nunca hacia Claude Code */ } }
  const info = (text: string) => emit('info', { text })

  /** Envía el prompt como del dispositivo; false si el submit falló. */
  const submitDevice = async (text: string): Promise<boolean> => {
    fromDevice.push(text)
    if (fromDevice.length > FROM_DEVICE_MAX) fromDevice.shift()
    return deps.submit(text).then(() => true, err => {
      // no habrá turn.start con este texto: que no tape uno igual escrito en la terminal
      const i = fromDevice.lastIndexOf(text)
      if (i >= 0) fromDevice.splice(i, 1)
      info(`No se pudo enviar el prompt: ${String((err as Error)?.message ?? err)}`)
      return false
    })
  }

  async function close(): Promise<void> {
    info('Cerrando la sesión desde Quorum')
    asks.withdrawKind('permission')
    const ids = [...tasks]
    tasks.clear()
    // /exit con trabajo de fondo vivo abre un diálogo que nadie en el dispositivo
    // puede contestar: se detiene primero lo que se conoce (sin bloquear si falla).
    await Promise.all(ids.map(id => deps.stopTask(id).catch(() => undefined)))
    if (ids.length) await deps.sleep(CLOSE_SETTLE_MS).catch(() => undefined)
    if (turnId) await deps.abort(turnId).catch(() => undefined)
    await deps.exit().catch(err => info(`No se pudo cerrar: ${String((err as Error)?.message ?? err)}`))
  }

  function track(e: Call, r: CallResult): void {
    const res = r.result as Record<string, unknown> | undefined
    if (e.tool === 'TaskStop') {
      const id = e.task_id ?? e.shell_id
      if (typeof id === 'string') tasks.delete(id)
      return
    }
    if (r.deny !== undefined || r.isError || !res || typeof res !== 'object') return
    if (typeof res.backgroundTaskId === 'string') tasks.add(res.backgroundTaskId)
    if (e.tool === 'Monitor' && typeof res.taskId === 'string') tasks.add(res.taskId)
  }

  async function question(e: Call, run: () => Promise<CallResult>): Promise<CallResult> {
    const questions = e.questions ?? []
    const summary = (Array.isArray(questions) ? questions : [])
      .map(q => String((q as { question?: unknown })?.question ?? '')).join(' · ').slice(0, 200)
    let askId = ''
    // sin vencimiento: el presupuesto de tool.call no corre mientras next(e) está en vuelo
    const device = asks.ask({ kind: 'question', tool: e.tool, summary, detail: '', questions }, Infinity, { onId: id => { askId = id } })
    const terminal = run()
    const first = await Promise.race([
      terminal.then(r => ({ from: 'terminal' as const, r }), err => ({ from: 'terminal' as const, err })),
      device.then(d => ({ from: 'device' as const, d })),
    ])
    if (first.from === 'terminal') {
      asks.withdraw(askId)
      if ('err' in first) throw first.err
      return first.r
    }
    const d = first.d
    if (d?.decision === 'allow' && d.answers) return { result: { questions, answers: d.answers } }
    if (d?.decision === 'deny') return { deny: 'El usuario canceló la pregunta desde Quorum.' }
    return terminal
  }

  return {
    get turnId() { return turnId },

    /** Aplica una orden del dispositivo. */
    async handle(c: Command): Promise<void> {
      const l = link()
      if (!l) return
      if (l.role === 'service') {
        info(SERVICE_INFO)
        return
      }
      switch (c.type) {
        case 'prompt': {
          const text = c.text ?? ''
          if (!text.trim()) return
          // el hub no publica el prompt: el user del dispositivo sale de aquí, una vez
          emit('user', { text })
          if (c.mode === 'now' && turnId) { midTurn.push(text); return }
          if (c.mode === 'interrupt' && turnId) {
            // los 'now' aún sin entregar van delante, en el mismo prompt (no después de él)
            const nows = midTurn.splice(0)
            const prompt = [...nows, text].join('\n\n')
            await deps.abort(turnId).catch(() => undefined)
            // si el submit falla, los 'now' se envían solos como prompt en cola (el
            // texto del interrupt ya avisó con un info); si eso también falla, esperan
            // al fin del próximo turno
            if (!(await submitDevice(prompt)) && nows.length) {
              const rest = nows.join('\n\n')
              if (!(await submitDevice(rest))) midTurn.unshift(...nows)
            }
            return
          }
          await submitDevice(text)
          return
        }
        case 'abort':
          if (turnId) await deps.abort(turnId).catch(() => undefined)
          return
        case 'close':
          await close()
          return
        case 'decide':
          asks.resolve(c.askId, { decision: c.decision, reason: c.reason, answers: c.answers ?? null })
          return
      }
    },

    /** turn.start: el turno del hilo principal en curso. */
    turnStart(e: { turnId?: string; agentId?: string }): void {
      if (e.agentId !== undefined) return
      turnId = e.turnId
    },

    /** turn.complete: fin de un subagente o del turno principal ('now' sin entregar → submit). */
    turnEnd(e: { agentId?: string }): void {
      if (e.agentId !== undefined) {
        tasks.delete(e.agentId)
        // sus permisos pendientes murieron con él
        asks.withdrawAgent(e.agentId)
        return
      }
      turnId = undefined
      // un permiso que esperaba murió con el turno (Esc, abort, interrupt), también los de subagentes
      asks.withdrawKind('permission')
      for (const t of midTurn.splice(0)) void submitDevice(t)
    },

    agentSpawned(id: string | undefined): void {
      if (id) tasks.add(id)
    },

    /** Consume el texto si vino del dispositivo (su `user` ya se emitió). */
    takeFromDevice(text: string): boolean {
      const i = fromDevice.indexOf(text)
      if (i < 0) return false
      fromDevice.splice(i, 1)
      return true
    },

    /** Cuerpo de tool.call: carrera de AskUserQuestion, inyección 'now', tareas de fondo. */
    async toolCall<R>(e: Call, run: () => Promise<R>): Promise<R> {
      const main = e.agentId === undefined
      if (main && e.tool === 'AskUserQuestion' && controllable()) {
        return (await question(e, run as never)) as R
      }
      const r = await run()
      const cr = (r ?? {}) as CallResult
      try { track(e, cr) } catch { /* nunca hacia Claude Code */ }
      // solo una llamada real del modelo (con tool_use_id): en un $.tool.call de un plugin el context se pierde
      if (main && e.tool_use_id !== undefined && midTurn.length && cr.deny === undefined && controllable()) {
        const said = midTurn.splice(0)
        return { ...cr, context: [...(cr.context ?? []), ...said] } as R
      }
      return r
    },

    /**
     * Después de `next(e)` en tool.check. Un 'ask' de una llamada real (hilo
     * principal o subagente) corre la carrera (permission.ts): el diálogo de la terminal
     * (`hook.termAsk`, vía `$.ui.ask`) y la tarjeta en los dispositivos a la vez.
     * Sin carrera, el veredicto del engine tal cual: allow/deny, consultas `$.tool.check` (sin tool_use_id), AskUserQuestion/ExitPlanMode,
     * sesión de servicio o sin daemon (sin dispositivos: mejor el diálogo nativo).
     */
    async permission<V extends Verdict>(e: CheckInput, verdict: V, hook: PermissionHook): Promise<V | Verdict> {
      if (verdict.decision !== 'ask' || e.tool_use_id === undefined) return verdict
      if (NEVER_ASK.has(e.tool) || !controllable() || link()?.state === 'no-daemon') return verdict
      let detail = ''
      try { detail = (JSON.stringify(e.input) ?? '').slice(0, DETAIL_MAX) } catch { /* sin detalle */ }
      const terminal = hook.hasTerminal ? await hook.hasTerminal().catch(() => true) : true
      return permissionRace({
        termAsk: terminal ? hook.termAsk : undefined,
        asks,
        keepAlive: hook.keepAlive ?? (() => {}),
        signal: hook.signal,
        log: hook.log,
      }, { tool: e.tool, summary: summarize(e.tool, e.input), detail, agentId: e.agentId })
    },

    asks,
  }
}

export type Control = ReturnType<typeof makeControl>
