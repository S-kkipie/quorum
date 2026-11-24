import { type BackgroundInfo, nextCron, stateOf, taskEnds } from './background'
import { summarize } from './events'
import type { Link } from './link'
import { permissionRace } from './permission'
import { validatePluginCommand } from './plugincmd'
import type { Ask, Command } from './proto.gen'

// the permission race lives in permission.ts; its caps are re-exported here
export { BUDGET_MARGIN_MS, HOLD_MAX_MS } from './permission'
/** Keeps a hook `$` in flight until `until` resolves (register.ts builds it). */
export type KeepAlive = (until: Promise<unknown>) => void
/** After TaskStop, how long to wait before /exit (which otherwise opens a dialog). */
export const CLOSE_SETTLE_MS = 1500
export const SERVICE_INFO = 'Service session: Quorum does not control it'
/** Tools that always ask the person: tool.check does not route them. */
export const NEVER_ASK = new Set(['AskUserQuestion', 'ExitPlanMode'])

export type Decision = { decision: string; reason?: string; answers?: Record<string, string> | null }
export type Verdict = { decision: 'allow' | 'ask' | 'deny'; reason?: string; [k: string]: unknown }
type Emitter = Pick<Link, 'emit' | 'update'>
/** `by` null: resolves without emitting ask_resolved (the hub already emitted its own). */
type Waiter = { kind: string; agentId?: string; settle: (d: Decision | undefined, by: string | null, why: SettleWhy) => void }
/** Why an ask closed: a device decided, it expired or it was withdrawn. */
export type SettleWhy = 'decided' | 'timeout' | 'withdrawn'
export type AskOpts = {
  /** Receives the new askId (to withdraw it later with `withdraw`). */
  onId?: (askId: string) => void
  /** Subagent asking: its asks are withdrawn when it finishes (`withdrawAgent`). */
  agentId?: string
  /** Why it closed, right before resolving. */
  onEnd?: (why: SettleWhy) => void
}

/**
 * Questions to the device. `ask` emits `ask` + status needs_you and resolves with the
 * device's decision, or undefined if it expires or is withdrawn (the terminal answered,
 * the turn was cut or the session closes).
 * When resolved by any path it emits `ask_resolved{by}` and, with none others open,
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
    try { this.getLink()?.emit({ kind, data } as never) } catch { /* never toward Claude Code */ }
  }

  private status(state: 'needs_you' | 'working'): void {
    this.emit('status', { state })
    try { this.getLink()?.update({ state }) } catch { /* same */ }
  }

  ask(a: Omit<Ask, 'askId'>, waitMs: number, opts: AskOpts = {}): Promise<Decision | undefined> {
    const askId = this.newId()
    opts.onId?.(askId)
    return new Promise(resolve => {
      const settle = (d: Decision | undefined, by: string | null, why: SettleWhy) => {
        if (!this.waiting.delete(askId)) return
        if (by !== null) this.emit('ask_resolved', { askId, by })
        if (this.waiting.size === 0) this.status('working')
        try { opts.onEnd?.(why) } catch { /* same */ }
        resolve(d)
      }
      this.waiting.set(askId, { kind: a.kind, agentId: opts.agentId, settle })
      this.emit('ask', { askId, ...a })
      this.status('needs_you')
      if (Number.isFinite(waitMs)) void this.sleep(waitMs).then(() => settle(undefined, 'terminal', 'timeout'), () => {})
    })
  }

  /**
   * Decision arrived from the device. The hub already published and stored its own
   * ask_resolved with the device name (the authoritative one): none is emitted here;
   * the wait is only released and, if none remain open, status working.
   */
  resolve(askId: string, decision: Decision): boolean {
    const w = this.waiting.get(askId)
    if (!w) return false
    w.settle(decision, null, 'decided')
    return true
  }

  /** The terminal answered first: the device's copy is withdrawn. */
  withdraw(askId: string): void {
    this.waiting.get(askId)?.settle(undefined, 'terminal', 'withdrawn')
  }

  /** Withdraws all open ones of a kind (e.g. permissions on returning to the terminal). */
  withdrawKind(kind: string): void {
    for (const [id, w] of [...this.waiting]) if (w.kind === kind) this.withdraw(id)
  }

  /** Withdraws the open ones of a subagent (its turn ended). */
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
  /** `runPluginCommand` (plugincmd.ts) over `$`: an allow-listed plugin slash command. */
  runPlugin?: (command: string, args: string) => Promise<{ ok: boolean; error?: string }>
  newId?: () => string
  /** `$.clock.now()` (ms); Date.now when absent. */
  now?: () => number
}

/** A scheduled wake-up: when it fires and, for a recurring cron, its expression. */
type Wake = { at: number; cron?: string; recurring: boolean }
/** `ScheduleWakeup` has no id: the dynamic loop has at most one pending wake-up. */
const LOOP_WAKE = 'schedule-wakeup'
const WAKE_MIN_S = 60
const WAKE_MAX_S = 3600
/** A wake-up this late (ms) without its turn did not fire: it is dropped (a recurring cron moves on). */
export const WAKE_GRACE_MS = 60_000
/** After a task ends between turns, how long to wait for a follow-up turn before re-publishing. */
export const RECHECK_MS = 5000
/** Longest single timer (setTimeout overflows past 2^31-1 ms): a later wake-up is re-armed on expiry. */
const MAX_SLEEP_MS = 2 ** 31 - 1

/** What the classic Stop hook reports (both fields absent on older builds). */
export type StopReport = {
  background_tasks?: ReadonlyArray<{ id?: unknown }>
  session_crons?: ReadonlyArray<{ id?: unknown; schedule?: unknown; recurring?: unknown }>
}

/** What the tool.check hook lends to the permission race. */
export type PermissionHook = {
  /** `$.ui.ask(q, { options: ['Allow','Deny'], header: 'Permission' })` of the hook itself. */
  termAsk: (q: string) => Promise<unknown>
  /**
   * Whether someone can answer `$.ui.ask` (`$.session.surfaces()` non-empty; empty in
   * a -p run). Queried only when the race runs. Without it, assumed true.
   */
  hasTerminal?: () => Promise<boolean>
  /** `next.signal` */
  signal?: AbortSignal
  keepAlive?: KeepAlive
  /** Line in the transcript (`$.ui.log`). */
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
 * Session control from Quorum: device commands, permissions and questions.
 * Pure: everything from `$` arrives via `deps`, so it is tested with fakes.
 */
export function makeControl(deps: ControlDeps) {
  let turnId: string | undefined
  const midTurn: string[] = []
  const fromDevice: string[] = []
  const tasks = new Set<string>() // known live background tasks and subagents
  const wakes = new Map<string, Wake>() // scheduled wake-ups (ScheduleWakeup, CronCreate)
  const now = () => { try { return deps.now?.() ?? Date.now() } catch { return Date.now() } }
  // the state last published after a turn ended (to re-send only real changes)
  let published = ''
  const asks = new Asks(deps.getLink, deps.sleep, deps.newId ?? randomId)

  const link = () => { try { return deps.getLink() } catch { return undefined } }
  /** Controllable work session (not service). */
  const controllable = () => { const l = link(); return !!l && l.role !== 'service' }
  const emit = (kind: string, data: unknown) => { try { link()?.emit({ kind, data } as never) } catch { /* never toward Claude Code */ } }
  const info = (text: string) => emit('info', { text })

  /** Sends the prompt as from the device; false if the submit failed. */
  const submitDevice = async (text: string): Promise<boolean> => {
    fromDevice.push(text)
    if (fromDevice.length > FROM_DEVICE_MAX) fromDevice.shift()
    return deps.submit(text).then(() => true, err => {
      // there will be no turn.start with this text: don't let it mask an identical one typed in the terminal
      const i = fromDevice.lastIndexOf(text)
      if (i >= 0) fromDevice.splice(i, 1)
      info(`Could not send the prompt: ${String((err as Error)?.message ?? err)}`)
      return false
    })
  }

  async function close(): Promise<void> {
    info('Closing the session from Quorum')
    asks.withdrawKind('permission')
    const ids = [...tasks]
    tasks.clear()
    wakes.clear()
    // /exit with live background work opens a dialog nobody on the device
    // can answer: what is known is stopped first (without blocking if it fails).
    await Promise.all(ids.map(id => deps.stopTask(id).catch(() => undefined)))
    if (ids.length) await deps.sleep(CLOSE_SETTLE_MS).catch(() => undefined)
    if (turnId) await deps.abort(turnId).catch(() => undefined)
    await deps.exit().catch(err => info(`Could not close: ${String((err as Error)?.message ?? err)}`))
  }

  function track(e: Call, r: CallResult): void {
    const res = r.result as Record<string, unknown> | undefined
    if (e.tool === 'TaskStop') {
      const id = e.task_id ?? e.shell_id
      if (typeof id === 'string' && tasks.delete(id)) recheck()
      return
    }
    if (r.deny !== undefined || r.isError || !res || typeof res !== 'object') return
    if (typeof res.backgroundTaskId === 'string') tasks.add(res.backgroundTaskId)
    if (e.tool === 'Monitor' && typeof res.taskId === 'string') tasks.add(res.taskId)
    if (e.tool === 'ScheduleWakeup') {
      if (e.stop === true || res.stopped === true) { wakes.delete(LOOP_WAKE); return }
      const delay = typeof e.delaySeconds === 'number' ? Math.min(WAKE_MAX_S, Math.max(WAKE_MIN_S, e.delaySeconds)) : undefined
      const at = typeof res.scheduledFor === 'number' ? res.scheduledFor : delay !== undefined ? now() + delay * 1000 : undefined
      if (at !== undefined) wakes.set(LOOP_WAKE, { at, recurring: false })
      return
    }
    if (e.tool === 'CronCreate' && typeof res.id === 'string') {
      const cron = typeof e.cron === 'string' ? e.cron : undefined
      const recurring = typeof res.recurring === 'boolean' ? res.recurring : e.recurring !== false
      const at = typeof res.nextFireAt === 'number' ? res.nextFireAt : cron ? nextCron(cron, now()) : undefined
      if (at !== undefined) wakes.set(res.id, { at, cron, recurring })
      return
    }
    if (e.tool === 'CronDelete') {
      if (typeof e.id === 'string') wakes.delete(e.id)
      if (res.endedLoopWakeup === true) wakes.delete(LOOP_WAKE)
    }
  }

  /** A wake-up whose time came (its turn started) or passed: one-shots are dropped, recurring crons move on. */
  function expire(before: number): void {
    const t = now()
    for (const [id, w] of [...wakes]) {
      if (w.at > before) continue
      const next = w.recurring && w.cron ? nextCron(w.cron, t) : undefined
      if (next === undefined) wakes.delete(id)
      else w.at = next
    }
  }

  /**
   * Live tasks and the next wake-up. One just due (within WAKE_GRACE_MS) still counts: its
   * turn is about to start; one later than that never fired and is dropped.
   */
  function background(): BackgroundInfo {
    expire(now() - WAKE_GRACE_MS)
    let wakeAt = 0
    for (const w of wakes.values()) if (!wakeAt || w.at < wakeAt) wakeAt = w.at
    return { tasks: tasks.size, wakeAt }
  }

  /**
   * A task ended between turns: if no follow-up turn starts within RECHECK_MS, the state is
   * re-published (otherwise the session could stay `background` with nothing left).
   */
  function recheck(): void {
    if (turnId !== undefined) return
    void deps.sleep(RECHECK_MS).then(() => republish(), () => {})
  }

  /**
   * Re-sends the end-of-turn state when it changed: only between turns and with no
   * question open (needs_you and working win).
   */
  function republish(): void {
    if (turnId !== undefined || asks.pending.length) return
    const bg = background()
    watchWake(bg.wakeAt)
    const state = stateOf(bg)
    const key = `${state}:${bg.tasks}:${bg.wakeAt}`
    if (key === published) return
    published = key
    emit('status', { state, background: bg })
    try { link()?.update({ state, background: bg }) } catch { /* never toward Claude Code */ }
  }

  /**
   * A published wake-up gets one re-check right after its grace (WAKE_GRACE_MS): if its turn never
   * started, the state is re-published without it, so "waking up" does not stick (a recurring cron
   * moves on and its next time is watched the same way). One timer per wake-up time.
   */
  let watched = 0
  function watchWake(wakeAt: number): void {
    if (!wakeAt || wakeAt === watched) return
    watched = wakeAt
    const ms = Math.min(MAX_SLEEP_MS, Math.max(0, wakeAt + WAKE_GRACE_MS - now()) + 1)
    void deps.sleep(ms).then(() => {
      if (watched !== wakeAt) return // a newer wake-up is watched instead
      watched = 0
      if (turnId === undefined) republish()
    }, () => {})
  }

  async function question(e: Call, run: () => Promise<CallResult>): Promise<CallResult> {
    const questions = e.questions ?? []
    const summary = (Array.isArray(questions) ? questions : [])
      .map(q => String((q as { question?: unknown })?.question ?? '')).join(' · ').slice(0, 200)
    let askId = ''
    // no expiry: the tool.call budget does not run while next(e) is in flight
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
    if (d?.decision === 'deny') return { deny: 'The user canceled the question from Quorum.' }
    return terminal
  }

  return {
    get turnId() { return turnId },

    /** Applies a device command. */
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
          // the hub does not publish the prompt: the device's user event comes from here, once.
          // device: true tells the hub it was not typed in the terminal (that one marks the session seen).
          emit('user', { text, device: true })
          if (c.mode === 'now' && turnId) { midTurn.push(text); return }
          if (c.mode === 'interrupt' && turnId) {
            // 'now' prompts not yet delivered go first, in the same prompt (not after it)
            const nows = midTurn.splice(0)
            const prompt = [...nows, text].join('\n\n')
            await deps.abort(turnId).catch(() => undefined)
            // if the submit fails, the 'now' prompts are sent alone as a queued prompt (the
            // interrupt text already warned with an info); if that also fails, they wait
            // for the end of the next turn
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
        case 'plugin': {
          const command = c.command ?? ''
          const args = c.args ?? ''
          const bad = validatePluginCommand(command, args)
          if (bad) { info(bad); return }
          if (!deps.runPlugin) { info('Plugin commands are not available in this session'); return }
          const r = await deps.runPlugin(command, args).catch(err => ({ ok: false, error: String((err as Error)?.message ?? err) }))
          if (!r.ok) info(r.error ?? `Could not run /${command}`)
          return
        }
      }
    },

    /** turn.start: the current main-thread turn. */
    turnStart(e: { turnId?: string; agentId?: string }): void {
      if (e.agentId !== undefined) return
      turnId = e.turnId
      published = ''
      // a wake-up due now fired: this is its turn
      expire(now())
    },

    /** turn.complete: end of a subagent or the main turn (undelivered 'now' → submit). */
    turnEnd(e: { agentId?: string }): void {
      if (e.agentId !== undefined) {
        if (tasks.delete(e.agentId)) recheck()
        // its pending permissions died with it
        asks.withdrawAgent(e.agentId)
        return
      }
      turnId = undefined
      // what turn.complete published (events.ts reads background() for it)
      const bg = background()
      published = `${stateOf(bg)}:${bg.tasks}:${bg.wakeAt}`
      watchWake(bg.wakeAt)
      // a waiting permission died with the turn (Esc, abort, interrupt), subagents' too
      asks.withdrawKind('permission')
      for (const t of midTurn.splice(0)) void submitDevice(t)
    },

    agentSpawned(id: string | undefined): void {
      if (id) tasks.add(id)
    },

    /** Live background tasks and the next scheduled wake-up (ms, 0 = none). */
    background,

    /**
     * A `<task-notification>` prompt (prompt.submit, origin task-notification): the tasks it
     * reports as ended are dropped. Nothing is published at once: dequeued while idle it starts
     * the follow-up turn itself, and a transient idle would read as a finished session. Without
     * a follow-up turn, the bounded re-check (RECHECK_MS) publishes the new state.
     */
    taskNotification(text: string): void {
      let removed = false
      for (const id of taskEnds(text)) removed = tasks.delete(id) || removed
      if (removed) recheck()
    },

    /**
     * The classic Stop hook's report at the end of a main turn: what Claude Code still has in
     * flight replaces the mod's own tracking (missed starts, missed ends); crons it lists that
     * are not known are scheduled from their expression. Re-published if it changed after
     * the turn ended.
     */
    stopHook(e: StopReport): void {
      if (Array.isArray(e.background_tasks)) {
        tasks.clear()
        for (const t of e.background_tasks) if (typeof t?.id === 'string') tasks.add(t.id)
      }
      if (Array.isArray(e.session_crons)) {
        if (!e.session_crons.length) wakes.clear()
        const listed = new Set(e.session_crons.map(c => c?.id))
        // a cron Claude Code no longer lists was deleted or fired (the loop's own wake-up has no id)
        for (const id of [...wakes.keys()]) if (id !== LOOP_WAKE && !listed.has(id)) wakes.delete(id)
        const t = now()
        for (const c of e.session_crons) {
          if (typeof c?.id !== 'string' || typeof c.schedule !== 'string' || wakes.has(c.id)) continue
          const at = nextCron(c.schedule, t)
          if (at !== undefined) wakes.set(c.id, { at, cron: c.schedule, recurring: c.recurring !== false })
        }
      }
      republish()
    },

    /** Consumes the text if it came from the device (its `user` was already emitted). */
    takeFromDevice(text: string): boolean {
      // use-haiku / think-hard strip a leading `_` / `+` (and the spaces after it) before the turn starts
      const unmarked = (t: string) => (/^(_(?!_)|\+)/.test(t) ? t.slice(1).trimStart() : t)
      let i = fromDevice.indexOf(text)
      if (i < 0) i = fromDevice.findIndex(t => unmarked(t) === text)
      if (i < 0) return false
      fromDevice.splice(i, 1)
      return true
    },

    /** Body of tool.call: AskUserQuestion race, 'now' injection, background tasks. */
    async toolCall<R>(e: Call, run: () => Promise<R>): Promise<R> {
      const main = e.agentId === undefined
      if (main && e.tool === 'AskUserQuestion' && controllable()) {
        return (await question(e, run as never)) as R
      }
      const r = await run()
      const cr = (r ?? {}) as CallResult
      try { track(e, cr) } catch { /* never toward Claude Code */ }
      // only a real model call (with tool_use_id): in a plugin's $.tool.call the context is lost
      if (main && e.tool_use_id !== undefined && midTurn.length && cr.deny === undefined && controllable()) {
        const said = midTurn.splice(0)
        return { ...cr, context: [...(cr.context ?? []), ...said] } as R
      }
      return r
    },

    /**
     * After `next(e)` in tool.check. An 'ask' from a real call (main thread
     * or subagent) runs the race (permission.ts): the terminal dialog
     * (`hook.termAsk`, via `$.ui.ask`) and the card on the devices at once.
     * Without a race, the engine's verdict as is: allow/deny, `$.tool.check` queries (no tool_use_id), AskUserQuestion/ExitPlanMode,
     * service session or no daemon (no devices: the native dialog is better).
     */
    async permission<V extends Verdict>(e: CheckInput, verdict: V, hook: PermissionHook): Promise<V | Verdict> {
      if (verdict.decision !== 'ask' || e.tool_use_id === undefined) return verdict
      if (NEVER_ASK.has(e.tool) || !controllable() || link()?.state === 'no-daemon') return verdict
      let detail = ''
      try { detail = (JSON.stringify(e.input) ?? '').slice(0, DETAIL_MAX) } catch { /* no detail */ }
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
