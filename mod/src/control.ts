import {
  type BackgroundInfo, type BackgroundItem, backgroundStart, guessKind, isTaskNotification, kindOfType, label, nextCron,
  parseTaskNotifications, startLabel, stateOf,
} from './background'
import { summarize } from './events'
import type { Link } from './link'
import { permissionRace } from './permission'
import { COMMAND_TEXT_MAX, COMMAND_WAIT_ERROR, COMMAND_WAIT_MS, commandWaitMs, validateCommand } from './commands'
import { validatePluginCommand } from './plugincmd'
import type { Ask, Command, CommandEvent, ModelOption, SessionCommand } from './proto.gen'

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
  /**
   * `$.command.run({ command, args })`: runs a slash command as if typed; queued until the
   * session is idle; resolves with its output (`{ text }`) or rejects (unknown name, ...).
   */
  commandRun?: (command: string, args: string) => Promise<unknown>
  /** The session's current command list (commands.ts reporter); undefined until read. */
  commands?: () => readonly SessionCommand[] | undefined
  /**
   * `$.config.set({ key: 'model', value })`: the /config Model row switches the session's model at
   * once, with no confirm dialog (a PreModelSwitch hook that asks makes it a deny); it also saves
   * the model as the default for new sessions, as /model does.
   */
  setModel?: (value: string) => Promise<{ value?: unknown; deny?: string } | undefined>
  /** The session's reported model options (commands.ts reporter). */
  modelOptions?: () => readonly ModelOption[] | undefined
  /** Re-reads the command list (the reporter's check): once, for a name the last list lacks. */
  refreshCommands?: () => Promise<void>
  /** A device command settled (ok or not): the reporter re-checks and notes a new effort. */
  commandSettled?: (command: string, args: string, ok: boolean) => void
  newId?: () => string
  /** `$.clock.now()` (ms); Date.now when absent. */
  now?: () => number
}

/** A scheduled wake-up: when it fires and, for a recurring cron, its expression. */
type Wake = { at: number; cron?: string; recurring: boolean; label?: string; startedAt?: number }
/** A live background task or subagent: what it is and when the mod saw it start. */
type Task = { kind: string; label: string; startedAt: number; bg: boolean }
/** How many ended tasks are remembered (a notification may come after the end: a subagent's turn.complete). */
const ENDED_MAX = 50
/** How many announced task ends (task_end emitted) are remembered to dedupe them. */
const ANNOUNCED_MAX = 200
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
  background_tasks?: ReadonlyArray<{ id?: unknown; type?: unknown; description?: unknown; command?: unknown }>
  session_crons?: ReadonlyArray<{ id?: unknown; schedule?: unknown; recurring?: unknown; prompt?: unknown }>
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
/** How long after it settled a device command may still claim its turn's command markup (takeCommand). */
export const COMMAND_CLAIM_MS = 60_000
/**
 * Claude Code trims a `prompt.submit` text and refuses one that then starts with `/` (it would run
 * a command as the user). A leading zero-width space (not whitespace to `trim`) keeps it literal.
 */
export const LITERAL_MARK = '\u200b'
const literal = (text: string) => (text.trimStart().startsWith('/') ? LITERAL_MARK + text : text)
const unescape = (text: string) => (text.startsWith(LITERAL_MARK) ? text.slice(LITERAL_MARK.length) : text)
/**
 * The text some built-ins return, instead of failing, when the run did not come from the person
 * (Claude Code 2.1.331: /recap "only runs when you ask for it yourself in this session",
 * /send-to-project "runs only when you type it yourself").
 */
export const REFUSED = /only runs when you ask for it yourself|runs only when you type it yourself/i
export const REFUSED_ERROR = 'This command only runs when typed in the terminal.'
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
  // device commands whose turn may start with Claude Code's command markup (takeCommand); `settledAt` once it settled
  const ranCommands: Array<{ key: string; settledAt?: number }> = []
  const commandKey = (name: string, args: string) => `${name}\n${String(args ?? '').trim()}`
  const tasks = new Map<string, Task>() // known live background tasks and subagents
  // tasks that ended lately (their kind for a notification that comes after the end), oldest first
  const ended = new Map<string, Task>()
  // task ids whose task_end was emitted (a notification seen twice, or after a synthetic end),
  // oldest first; the value is true for a synthetic end (a real one may still replace it)
  const announced = new Map<string, boolean>()
  // tasks that ended without a notification (TaskStop, the Stop report): a synthetic task_end
  // follows unless their own notification comes first
  const unannounced = new Map<string, Task>()
  // notification-looking prompts the engine stamped with another origin (the owner typed them):
  // their turn is the owner's, not a notification's
  const literals: string[] = []
  // the running main turn was started by a task notification
  let notificationTurn = false
  // the background last reported with update (items are re-sent only when they change)
  let reported = '[0,[]]' // itemsKey of nothing pending (what the register starts with)
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
  const submitDevice = async (original: string): Promise<boolean> => {
    const text = literal(original)
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

  /**
   * Runs a slash command from a device and reports it as `command` events: `queued` when a
   * turn is running (it runs when the turn ends), then `done` (with its output) or `failed`.
   * Past its wait budget a `failed` (waiting for the terminal) shows first; the final status
   * still follows with the same id (the devices merge by id).
   * `listed`: it must be in the session's list and not terminal-only (the `command` type); the
   * Plan 6 `plugin` alias has already passed its own allow-list.
   */
  async function runCommand(name: string, args: string, listed: boolean): Promise<void> {
    const base = { id: (deps.newId ?? randomId)(), name: String(name).slice(0, 200), args: String(args ?? '').slice(0, 2000), origin: 'device' }
    const send = (ev: Omit<CommandEvent, keyof typeof base>) => emit('command', { ...base, ...ev })
    if (!deps.commandRun) { send({ status: 'failed', error: 'Commands are not available in this session' }); return }
    if (listed) {
      const check = (): string | null => {
        try { return validateCommand(deps.commands?.(), name, args) } catch { return 'The command list of this session is not available yet' }
      }
      const known = () => { try { return !!deps.commands?.()?.some(c => c.name === name) } catch { return false } }
      // a name the last list lacks (a plugin reloaded since, or no list yet): one re-check first
      if (!known() && deps.refreshCommands) await deps.refreshCommands().catch(() => undefined)
      const bad = check()
      if (bad) { send({ status: 'failed', error: bad }); return }
    }
    const ran: { key: string; settledAt?: number } = { key: commandKey(base.name, base.args) }
    ranCommands.push(ran)
    if (ranCommands.length > FROM_DEVICE_MAX) ranCommands.shift()
    await settle(send, () => deps.commandRun!(name, args), r => {
      ran.settledAt = now()
      if ('err' in r) {
        send({ status: 'failed', error: `Could not run /${base.name}: ${errText(r.err)}` })
        settled(name, args, false)
        return
      }
      const text = (r.value as { text?: unknown } | undefined)?.text
      if (typeof text === 'string' && REFUSED.test(text)) {
        send({ status: 'failed', error: REFUSED_ERROR })
        settled(name, args, false)
        return
      }
      send(typeof text === 'string' && text ? { status: 'done', text: text.slice(0, COMMAND_TEXT_MAX) } : { status: 'done' })
      settled(name, args, true)
    }, { waitMs: commandWaitMs(name), queue: true })
  }

  const errText = (err: unknown) => String((err as Error)?.message ?? err)
  const settled = (name: string, args: string, ok: boolean) => {
    try { deps.commandSettled?.(name, args, ok) } catch { /* never toward Claude Code */ }
  }

  /** Resolved by the next main-turn end. */
  const turnEnders: Array<() => void> = []
  /** Counts main-turn starts (a wait restarts when a turn ran during it). */
  let turnSeq = 0

  /**
   * Resolves once `ms` have passed with no main turn starting: when a turn is running it first
   * waits for that turn's end; when a turn starts during the sleep (another queued prompt, or the
   * command's own turn), it waits for that turn's end and sleeps `ms` again. Stops (never
   * resolves, arms nothing more) once `done()` is true, i.e. the command already settled; also
   * never resolves if the sleep fails.
   */
  async function idleDeadline(ms: number, done: () => boolean): Promise<void> {
    for (;;) {
      if (done()) return new Promise<never>(() => {})
      if (turnId !== undefined) await new Promise<void>(r => { turnEnders.push(r) })
      if (done()) return new Promise<never>(() => {})
      const seq = turnSeq
      await deps.sleep(ms)
      if (turnSeq === seq && turnId === undefined) return
    }
  }

  type Outcome = { value: unknown } | { err: unknown }

  /**
   * Runs `start` for a device command and hands its outcome to `finish`. With `queue`, `queued`
   * first when a turn is running, and the wait counts from when no turn runs any more
   * (`idleDeadline`); without, it counts from now (applied at once, like set_model). Past the
   * wait, `failed` (waiting for the terminal) and this resolves; the command is not cancelled
   * and `finish` still runs when it settles (the final status, same id).
   */
  async function settle(send: (ev: Pick<CommandEvent, 'status' | 'text' | 'error'>) => void, start: () => Promise<unknown>,
    finish: (r: Outcome) => void, opts: { waitMs: number; queue: boolean }): Promise<void> {
    if (opts.queue && turnId !== undefined) send({ status: 'queued' })
    let over = false
    const run: Promise<Outcome> = Promise.resolve().then(start).then(value => ({ value }), err => ({ err }))
      .finally(() => { over = true })
    const clock = opts.queue ? idleDeadline(opts.waitMs, () => over) : deps.sleep(opts.waitMs)
    const timeout = clock.then(() => undefined, () => new Promise<never>(() => {}))
    const r = await Promise.race([run, timeout])
    const done = (o: Outcome) => { try { finish(o) } catch { /* never toward Claude Code */ } }
    if (r) { done(r); return }
    send({ status: 'failed', error: COMMAND_WAIT_ERROR })
    void run.then(done)
  }

  /**
   * set_model: one of the reported model options, through the /config Model row (no dialog).
   * Applied at once (never `queued`). Options not read yet: one refresh first.
   */
  async function setModel(value: string): Promise<void> {
    const base = { id: (deps.newId ?? randomId)(), name: 'model', args: String(value ?? '').slice(0, 200), origin: 'device' }
    const send = (ev: Pick<CommandEvent, 'status' | 'text' | 'error'>) => emit('command', { ...base, ...ev })
    if (!deps.setModel) { send({ status: 'failed', error: 'Switching the model is not available in this session' }); return }
    const options = (): readonly ModelOption[] | undefined => { try { return deps.modelOptions?.() } catch { return undefined } }
    if (!options() && deps.refreshCommands) await deps.refreshCommands().catch(() => undefined)
    const opt = options()?.find(o => o.value === value)
    if (!opt) { send({ status: 'failed', error: `Unknown model: ${base.args.slice(0, 60)}` }); return }
    await settle(send, () => deps.setModel!(value), r => {
      const deny = 'value' in r ? (r.value as { deny?: unknown } | undefined)?.deny : undefined
      if ('err' in r) send({ status: 'failed', error: `Could not set the model: ${errText(r.err)}` })
      else if (deny !== undefined) send({ status: 'failed', error: String(deny).slice(0, 500) })
      else send({ status: 'done', text: `Set model to ${opt.label}` })
      settled('model', value, 'value' in r && deny === undefined)
    }, { waitMs: COMMAND_WAIT_MS, queue: false })
  }

  async function close(): Promise<void> {
    info('Closing the session from Quorum')
    asks.withdrawKind('permission')
    const ids = [...tasks.keys()]
    for (const [id, t] of tasks) if (t.bg) endWithout(id, t)
    for (const [id, t] of unannounced) endWithout(id, t)
    unannounced.clear()
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
      const t = typeof id === 'string' ? tasks.get(id) : undefined
      if (typeof id === 'string' && drop(id)) {
        if (t?.bg) endLater(id, t)
        recheck()
      }
      return
    }
    if (r.deny !== undefined || r.isError || !res || typeof res !== 'object') return
    const bgStart = backgroundStart(e.tool, r)
    if (bgStart) {
      const known = tasks.get(bgStart.taskId)
      const l = startLabel(e.tool, e)
      tasks.set(bgStart.taskId, { kind: bgStart.kind, label: l || known?.label || '', startedAt: known?.startedAt ?? now(), bg: true })
      return
    }
    if (e.tool === 'ScheduleWakeup') {
      if (e.stop === true || res.stopped === true) { wakes.delete(LOOP_WAKE); return }
      const delay = typeof e.delaySeconds === 'number' ? Math.min(WAKE_MAX_S, Math.max(WAKE_MIN_S, e.delaySeconds)) : undefined
      const at = typeof res.scheduledFor === 'number' ? res.scheduledFor : delay !== undefined ? now() + delay * 1000 : undefined
      if (at !== undefined) wakes.set(LOOP_WAKE, { at, recurring: false, label: label(e.prompt), startedAt: now() })
      return
    }
    if (e.tool === 'CronCreate' && typeof res.id === 'string') {
      const cron = typeof e.cron === 'string' ? e.cron : undefined
      const recurring = typeof res.recurring === 'boolean' ? res.recurring : e.recurring !== false
      const at = typeof res.nextFireAt === 'number' ? res.nextFireAt : cron ? nextCron(cron, now()) : undefined
      if (at !== undefined) wakes.set(res.id, { at, cron, recurring, label: label(e.prompt), startedAt: now() })
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
  function background(final = false): BackgroundInfo {
    expire(now() - WAKE_GRACE_MS)
    let wakeAt = 0
    for (const w of wakes.values()) if (!wakeAt || w.at < wakeAt) wakeAt = w.at
    // a foreground subagent is part of the turn, not an item; one still alive when the main turn
    // ends (`final`) runs on in the background
    const items: BackgroundItem[] = [...tasks].filter(([, t]) => t.bg || final)
      .map(([id, t]) => ({ id, kind: t.kind, label: t.label, startedAt: t.startedAt }))
    for (const [id, w] of wakes) {
      items.push({ id, kind: id === LOOP_WAKE ? 'loop' : 'cron', label: w.label ?? '', startedAt: w.startedAt ?? 0, nextWake: w.at })
    }
    items.sort((a, b) => a.startedAt - b.startedAt)
    return { tasks: tasks.size, wakeAt, items }
  }

  const itemsKey = (bg: BackgroundInfo) => JSON.stringify([bg.wakeAt, bg.items])

  /** Stops tracking a task (kept a while in `ended` for its kind); false if it was not live. */
  function drop(id: string): boolean {
    const t = tasks.get(id)
    if (!t) return false
    tasks.delete(id)
    ended.delete(id)
    ended.set(id, t)
    if (ended.size > ENDED_MAX) ended.delete(ended.keys().next().value as string)
    return true
  }

  /** Re-sends the background (its items) with update when it changed since last reported. */
  function report(): void {
    const bg = background()
    // what the items show (a foreground subagent counts in tasks but is no item: not re-sent for it)
    const key = itemsKey(bg)
    if (key === reported) return
    reported = key
    try { link()?.update({ background: bg }) } catch { /* never toward Claude Code */ }
  }

  /**
   * Emits task_end once per task id (a bounded memory of the announced ones), except that a real
   * end (from the task's own notification) after a synthetic one is emitted too: it replaces it.
   */
  function announce(taskId: string, data: Record<string, unknown>, synthetic = false): void {
    unannounced.delete(taskId)
    const prev = announced.get(taskId)
    if (prev !== undefined && (!prev || synthetic)) return
    announced.delete(taskId)
    announced.set(taskId, synthetic)
    if (announced.size > ANNOUNCED_MAX) announced.delete(announced.keys().next().value as string)
    if (controllable()) emit('task_end', { taskId, ...data, ...(synthetic ? { synthetic: true } : {}) })
  }

  /** A background task ended without a notification: a synthetic task_end, status `stopped`. */
  function endWithout(id: string, t: Task): void {
    announce(id, { kind: t.kind, summary: t.label, status: 'stopped' }, true)
  }

  /**
   * As endWithout, after RECHECK_MS: its own notification (with the real status and summary) may
   * still be on its way (a TaskStop's `killed`, a completion queued until the session is idle).
   */
  function endLater(id: string, t: Task): void {
    unannounced.set(id, t)
    void deps.sleep(RECHECK_MS).then(() => {
      if (unannounced.get(id) !== t) return
      unannounced.delete(id)
      endWithout(id, t)
    }, () => {})
  }

  /**
   * Handles a notification prompt: each block whose status ends a task emits task_end (the kind
   * is the tracked item's; once per task id) and the task is dropped; a monitor's event (no end)
   * is an info line, unless `endsOnly`.
   */
  function notify(text: string, endsOnly = false): boolean {
    let removed = false
    for (const n of parseTaskNotifications(text)) {
      if (!n.ended) {
        const what = n.event || n.summary
        if (!endsOnly && what && controllable()) info(`Background event: ${label(what)}`)
        continue
      }
      const t = tasks.get(n.taskId) ?? ended.get(n.taskId)
      removed = drop(n.taskId) || removed
      announce(n.taskId, {
        kind: t?.kind ?? guessKind(n.summary), summary: n.summary || t?.label || '', status: n.status ?? '',
        ...(n.exitCode !== undefined ? { exitCode: n.exitCode } : {}),
        ...(n.outputTail ? { outputTail: n.outputTail } : {}),
      })
    }
    report()
    return removed
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
    reported = itemsKey(bg)
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
        case 'command':
          await runCommand(c.command ?? '', c.args ?? '', true)
          return
        case 'set_model':
          await setModel(c.value ?? '')
          return
        case 'plugin': {
          // Plan 6 alias of `command`: limited to after/before/timeline, no list needed
          const command = c.command ?? ''
          const args = c.args ?? ''
          const bad = validatePluginCommand(command, args)
          if (bad) { info(bad); return }
          await runCommand(command, args, false)
          return
        }
      }
    },

    /**
     * turn.start: the current main-thread turn. A turn started by a notification prompt that
     * prompt.submit did not see is handled here (task_end, tracking).
     */
    turnStart(e: { turnId?: string; agentId?: string; text?: string }): void {
      if (e.agentId !== undefined) return
      const lit = isTaskNotification(e.text) ? literals.indexOf(String(e.text)) : -1
      if (lit >= 0) literals.splice(lit, 1)
      notificationTurn = lit < 0 && isTaskNotification(e.text)
      // ends only: a monitor event's info line came with its prompt.submit; task_end is deduped
      if (notificationTurn) notify(String(e.text), true)
      turnId = e.turnId
      turnSeq++
      published = ''
      // a wake-up due now fired: this is its turn
      expire(now())
    },

    /** turn.complete: end of a subagent or the main turn (undelivered 'now' → submit). */
    turnEnd(e: { agentId?: string }): void {
      if (e.agentId !== undefined) {
        if (drop(e.agentId)) { recheck(); report() }
        // its pending permissions died with it
        asks.withdrawAgent(e.agentId)
        return
      }
      turnId = undefined
      // device commands waiting for this turn's end: their wait for an answer (re)starts
      for (const r of turnEnders.splice(0)) r()
      // a subagent still running when the main turn ends runs in the background
      for (const t of tasks.values()) t.bg = true
      // what turn.complete published (events.ts reads background(true) for it)
      const bg = background()
      published = `${stateOf(bg)}:${bg.tasks}:${bg.wakeAt}`
      reported = itemsKey(bg)
      watchWake(bg.wakeAt)
      // a waiting permission died with the turn (Esc, abort, interrupt), subagents' too
      asks.withdrawKind('permission')
      for (const t of midTurn.splice(0)) void submitDevice(t)
    },

    /** agent.spawn answered: a subagent (foreground or background) runs until its turn.complete. */
    agentSpawned(id: string | undefined, e?: { description?: unknown; prompt?: unknown; background?: unknown }): void {
      if (!id) return
      const known = tasks.get(id)
      tasks.set(id, {
        kind: 'subagent', label: label(e?.description) || label(e?.prompt) || known?.label || '',
        startedAt: known?.startedAt ?? now(), bg: known?.bg === true || e?.background === true,
      })
      report()
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
      if (notify(text)) recheck()
    },

    /**
     * prompt.submit stamped with an origin other than task-notification: a prompt that merely
     * looks like one (the owner typed the markup) starts an ordinary turn.
     */
    ownerPrompt(text: string): void {
      if (!isTaskNotification(text)) return
      literals.push(text)
      if (literals.length > FROM_DEVICE_MAX) literals.shift()
    },

    /** The running main turn was started by a task notification (after turnStart). */
    isNotificationTurn(): boolean {
      return notificationTurn
    },

    /**
     * The classic Stop hook's report at the end of a main turn: what Claude Code still has in
     * flight replaces the mod's own tracking (missed starts, missed ends); crons it lists that
     * are not known are scheduled from their expression. Re-published if it changed after
     * the turn ended.
     */
    stopHook(e: StopReport): void {
      if (Array.isArray(e.background_tasks)) {
        const before = new Map(tasks)
        tasks.clear()
        const t0 = now()
        for (const t of e.background_tasks) {
          if (typeof t?.id !== 'string') continue
          const known = before.get(t.id)
          tasks.set(t.id, known ? { ...known, bg: true } : { kind: kindOfType(t.type), label: label(t.command) || label(t.description), startedAt: t0, bg: true })
        }
        for (const [id, t] of before) {
          if (tasks.has(id)) continue
          ended.delete(id)
          ended.set(id, t)
          // gone without a notification so far: a background one gets its task_end (deduped)
          if (t.bg) endLater(id, t)
        }
        while (ended.size > ENDED_MAX) ended.delete(ended.keys().next().value as string)
      }
      if (Array.isArray(e.session_crons)) {
        if (!e.session_crons.length) wakes.clear()
        const listed = new Set(e.session_crons.map(c => c?.id))
        // a cron Claude Code no longer lists was deleted or fired (the loop's own wake-up has no id)
        for (const id of [...wakes.keys()]) if (id !== LOOP_WAKE && !listed.has(id)) wakes.delete(id)
        const t = now()
        for (const c of e.session_crons) {
          const w = typeof c?.id === 'string' ? wakes.get(c.id) : undefined
          if (w && !w.label) w.label = label(c.prompt)
          if (typeof c?.id !== 'string' || typeof c.schedule !== 'string' || wakes.has(c.id)) continue
          const at = nextCron(c.schedule, t)
          if (at !== undefined) wakes.set(c.id, { at, cron: c.schedule, recurring: c.recurring !== false, label: label(c.prompt), startedAt: t })
        }
      }
      republish()
      report()
    },

    /** Consumes the text if it came from the device (its `user` was already emitted). */
    takeFromDevice(text: string): boolean {
      // use-haiku / think-hard strip a leading `_` / `+` (and the spaces after it) before the turn starts
      const unmarked = (t: string) => (/^(_(?!_)|\+)/.test(t) ? t.slice(1).trimStart() : t)
      // a `/` prompt was sent with LITERAL_MARK: the turn may start with or without it
      const plain = unescape(text)
      let i = fromDevice.indexOf(text)
      if (i < 0) i = fromDevice.findIndex(t => unescape(t) === plain || unmarked(unescape(t)) === plain)
      if (i < 0) return false
      fromDevice.splice(i, 1)
      return true
    },

    /**
     * A turn started with the command markup of `/name args`: true (and consumed, once) when a
     * device just ran that command (still running, or settled less than COMMAND_CLAIM_MS ago).
     */
    takeCommand(name: string, args: string): boolean {
      const t = now()
      for (let j = ranCommands.length - 1; j >= 0; j--) {
        const s = ranCommands[j]!.settledAt
        if (s !== undefined && t - s > COMMAND_CLAIM_MS) ranCommands.splice(j, 1)
      }
      const i = ranCommands.findIndex(r => r.key === commandKey(name, args))
      if (i < 0) return false
      ranCommands.splice(i, 1)
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
      try { track(e, cr); report() } catch { /* never toward Claude Code */ }
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
