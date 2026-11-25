import { backgroundStart, type BackgroundInfo, isTaskNotification, stateOf } from './background'
import type { Link } from './link'
import { sumTokens } from './meters'
import { trimInput } from './trim'

export const ERROR_ANSWER =
  'Claude returned an error (expired session, usage limit or API failure). Check it in the terminal.'

const TOOL_OUTPUT_MAX = 8000
const AGENT_ANSWER_MAX = 2000
const TURN_ANSWER_MAX = 40_000

/** One-line summary of a tool call. */
export function summarize(tool: string, input: unknown): string {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const pick = (k: string): string | undefined => (typeof o[k] === 'string' ? (o[k] as string) : undefined)
  const key =
    tool === 'Bash' ? 'command'
    : tool === 'Read' || tool === 'Write' || tool === 'Edit' ? 'file_path'
    : tool === 'Grep' || tool === 'Glob' ? 'pattern'
    : tool === 'WebFetch' ? 'url'
    : ''
  if (key) {
    const v = pick(key)
    if (v !== undefined) return v
  }
  let out = ''
  for (const [k, v] of Object.entries(o)) {
    if (k === 'tool' || k === 'tool_use_id' || k === 'agentId') continue
    const part = `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`
    out = out ? `${out} ${part}` : part
    if (out.length >= 120) break
  }
  return out.slice(0, 120)
}

type Chunk = { kind: string; text?: string; name?: string; id?: string }
type Call = { tool: string; tool_use_id: string; agentId?: string; [k: string]: unknown }
type Done = {
  answer: string
  reason?: string
  isAborted?: boolean
  agentId?: string
  usage?: { output_tokens?: number; input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; model?: string }
}

/**
 * A slash command's turn starts with Claude Code's command markup (`<command-message>x</command-message>`,
 * `<command-name>/x</command-name>`, `<command-args>a b</command-args>`, in any order): its name
 * (without the `/`) and trimmed args; undefined for any other text.
 */
export function commandOf(text: string): { name: string; args: string } | undefined {
  if (typeof text !== 'string' || !text.startsWith('<command-')) return undefined
  const name = /<command-name>\/?([^<\s]+)<\/command-name>/.exec(text)?.[1]
  if (!name) return undefined
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1] ?? ''
  return { name, args: args.trim() }
}

/**
 * Pure handlers of the session hooks. `getLink` is queried on every call
 * (the Link is born in session.start); `turnComplete` receives `getPct` for the context percentage.
 * `opts.fromDevice(text)` says (and consumes) whether the prompt came from the device: its
 * `user` was already emitted by the control, so turnStart does not repeat it.
 * A command turn (Claude Code's command markup) emits `user` as `{text: '/name args', command}`;
 * `opts.fromCommand(name, args)` says (and consumes) whether a device just ran it: then
 * `device: true` (the hub does not mark the session seen; the app shows the command card instead).
 * `opts.background()` says what is left when a main turn ends (live background tasks, next
 * wake-up): with any, the session is `background` instead of `idle`.
 * Nothing here throws or waits on anything slow.
 */
export function makeHandlers(
  getLink: () => Link | undefined,
  opts: {
    fromDevice?: (text: string) => boolean
    fromCommand?: (name: string, args: string) => boolean
    background?: () => BackgroundInfo | undefined
    /** Whether the turn starting with this text is a task notification's (default: its markup). */
    isNotification?: (text: string) => boolean
  } = {},
) {
  const safe = (fn: (l: Link) => void): void => {
    try {
      const l = getLink()
      if (l) fn(l)
    } catch { /* an event failure must not reach Claude Code */ }
  }
  const full = (l: Link) => l.role !== 'service'
  const tag = (agent: string | undefined, d: Record<string, unknown>) => (agent ? { agent, ...d } : d)
  const status = (l: Link, state: 'working' | 'idle') => {
    l.emit({ kind: 'status', data: { state } })
    l.update({ state })
  }
  // the person pressed Stop in Claude Code (Esc, Ctrl+C, a client's Stop) on the running main turn
  let stopped = false

  return {
    /** `images`: the pasted images the prompt names that exist on disk (see images.ts). */
    turnStart(e: { text: string; agentId?: string; images?: Array<{ n: number; path: string }> }): void {
      if (e.agentId !== undefined) return
      stopped = false
      safe(l => {
        if (full(l)) {
          l.emit({ kind: 'turn_start', data: {} })
          const c = commandOf(e.text)
          if (opts.isNotification ? opts.isNotification(e.text) : isTaskNotification(e.text)) {
            // Claude Code's own notification prompt: the control emitted task_end for it; never a
            // user bubble, and never the owner typing (no seen mark)
          } else if (c) {
            const text = c.args ? `/${c.name} ${c.args}` : `/${c.name}`
            const device = opts.fromCommand?.(c.name, c.args) === true
            l.emit({ kind: 'user', data: device ? { text, command: c, device: true } : { text, command: c } })
          } else if (!opts.fromDevice?.(e.text)) {
            l.emit({ kind: 'user', data: e.images?.length ? { text: e.text, images: e.images } : { text: e.text } })
          }
        }
        status(l, 'working')
      })
    },

    /** Observes a turn.step chunk; `st` is the state of the current step. */
    chunk(e: { agentId?: string }, c: Chunk, st: StepState): void {
      safe(l => {
        if (!full(l)) return
        const agent = e.agentId
        if (c.kind === 'thinking') {
          if (!st.thinking) l.emit({ kind: 'thinking', data: tag(agent, { text: '' }) })
          st.thinking = true
          return
        }
        st.thinking = false
        if (c.kind === 'text' && c.text) {
          st.text += c.text
          l.emit({ kind: 'assistant_delta', data: tag(agent, { text: c.text }) })
        }
      })
    },

    stepEnd(e: { agentId?: string }, st: StepState): void {
      safe(l => {
        if (full(l) && st.text.trim()) {
          l.emit({ kind: 'assistant', data: tag(e.agentId, { text: st.text.slice(0, TURN_ANSWER_MAX) }) })
        }
      })
    },

    toolStart(e: Call): void {
      safe(l => {
        if (!full(l)) return
        l.emit({ kind: 'tool_start', data: tag(e.agentId, { id: e.tool_use_id, name: e.tool, summary: summarize(e.tool, e), input: trimInput(e.tool, e) }) })
      })
    },

    toolEnd(e: Call, r: { isError?: boolean; deny?: string; text?: string; result?: unknown } | undefined, ms: number): void {
      safe(l => {
        if (!full(l)) return
        let output = ''
        if (r?.deny !== undefined) output = String(r.deny)
        else if (typeof r?.text === 'string') output = r.text
        else if (r?.result !== undefined) output = typeof r.result === 'string' ? r.result : JSON.stringify(r.result) ?? ''
        // a call that started background work: still running (its task_end comes later)
        const bg = backgroundStart(e.tool, r)
        l.emit({
          kind: 'tool_end',
          data: tag(e.agentId, {
            id: e.tool_use_id, ok: !(r?.isError || r?.deny !== undefined), ms, output: output.slice(0, TOOL_OUTPUT_MAX),
            ...(bg ? { background: { taskId: bg.taskId } } : {}),
          }),
        })
      })
    },

    /**
     * session.compact settled (`r` is what `next(e)` resolved to): a compaction of the main
     * conversation that stands emits `compact` ("manual" for /compact, "auto" for the threshold
     * or a plugin's). A precompute, a skip and a subagent's own compaction emit nothing.
     */
    compact(e: { trigger?: string; agentId?: string }, r: { skip?: unknown; messages?: unknown; tokensBefore?: unknown } | undefined, at: number): void {
      if (e.agentId !== undefined || e.trigger === 'precompute') return
      if (!r || r.skip !== undefined || !Array.isArray(r.messages)) return
      safe(l => {
        if (!full(l)) return
        const pre = typeof r.tokensBefore === 'number' && r.tokensBefore > 0 ? { preTokens: Math.round(r.tokensBefore) } : {}
        l.emit({ kind: 'compact', data: { at, trigger: e.trigger === 'manual' ? 'manual' : 'auto', ...pre } })
      })
    },

    /** session.stop: the person pressed Stop; it counts only on a running main turn. */
    sessionStop(isTurnRunning: boolean): void {
      if (isTurnRunning) stopped = true
    },

    /**
     * agent.spawn answered: `agent_start` names the Agent call that started it (`tool`, absent when
     * no call did) and, for a subagent spawned by another, its parent (`agent`, like its events).
     */
    agentSpawn(e: { subagentType?: string; description?: string; tool_use_id?: string; parentAgentId?: string }, r: { agentId?: string } | undefined): void {
      safe(l => {
        if (!full(l) || !r?.agentId) return
        const tool = e.tool_use_id ? { tool: e.tool_use_id } : {}
        l.emit({ kind: 'agent_start', data: tag(e.parentAgentId, { id: r.agentId, type: e.subagentType ?? '', description: e.description ?? '', ...tool }) })
      })
    },

    turnComplete(e: Done, getPct?: () => Promise<number | undefined>): void {
      safe(l => {
        if (e.agentId !== undefined) {
          if (!full(l)) return
          const status = e.isAborted ? 'killed' : e.reason === 'error' ? 'error' : 'completed'
          l.emit({ kind: 'agent_end', data: { id: e.agentId, status, answer: (e.answer ?? '').slice(0, AGENT_ANSWER_MAX) } })
          return
        }
        // aborted by the person's own Stop: they were looking, so the hub never makes it unread
        // (session.stop never fires for $.turn.abort, Quorum's interrupt)
        const byStop = stopped && e.reason === 'aborted'
        stopped = false
        let bg: BackgroundInfo = { tasks: 0, wakeAt: 0 }
        try { bg = opts.background?.() ?? bg } catch { /* idle then */ }
        if (full(l)) {
          const answer = e.reason === 'error' && !(e.answer ?? '').trim() ? ERROR_ANSWER : (e.answer ?? '')
          l.emit({
            kind: 'turn_end',
            data: {
              answer: answer.slice(0, TURN_ANSWER_MAX), reason: e.reason ?? 'answer', outputTokens: e.usage?.output_tokens ?? 0,
              tokens: sumTokens(e.usage), model: e.usage?.model ?? '', background: bg,
              ...(byStop ? { stopped: true } : {}),
            },
          })
        }
        const state = stateOf(bg)
        l.emit({ kind: 'status', data: { state, background: bg } })
        l.update({ state, background: bg })
        if (full(l) && getPct) {
          void getPct().then(p => {
            if (typeof p === 'number') safe(l2 => l2.update({ contextPct: p }))
          }, () => {})
        }
      })
    },
  }
}

export type StepState = { text: string; thinking: boolean }
export const newStep = (): StepState => ({ text: '', thinking: false })

/**
 * Context percentage from `$.session.usage().context`: `percent` if present;
 * otherwise round(100 * tokens / window) when both exist; otherwise undefined.
 */
export function contextPct(u: { context?: { percent?: number; tokens?: number; window?: number } } | undefined): number | undefined {
  const c = u?.context
  if (!c) return undefined
  if (typeof c.percent === 'number') return Math.max(0, Math.min(100, Math.round(c.percent)))
  if (typeof c.tokens === 'number' && c.window) return Math.max(0, Math.min(100, Math.round((100 * c.tokens) / c.window)))
  return undefined
}

type Handlers = ReturnType<typeof makeHandlers>

/**
 * Body of the turn.step hook: forwards each chunk and the inner stream's return
 * value. If the consumer closes (return) or throws into the wrapper, it closes
 * or forwards to the inner stream and still emits the step's partial text.
 */
export async function* stepHook<C extends { kind: string }, R>(
  h: Handlers,
  e: { agentId?: string },
  stream: AsyncGenerator<C, R>,
): AsyncGenerator<C, R> {
  const st = newStep()
  let finished = false // the inner generator finished or failed: nothing to close
  try {
    while (true) {
      let r: IteratorResult<C, R>
      try {
        r = await stream.next()
      } catch (err) {
        finished = true
        throw err
      }
      if (r.done) {
        finished = true
        return r.value
      }
      h.chunk(e, r.value, st)
      try {
        yield r.value
      } catch (err) {
        // the inner stream decides; if it does not throw, rethrow anyway
        let res: IteratorResult<C, R>
        try {
          res = await stream.throw(err)
        } catch (err2) {
          finished = true
          throw err2
        }
        // if it recovered and is still suspended at a yield, the finally closes it
        if (res.done) finished = true
        throw err
      }
    }
  } finally {
    h.stepEnd(e, st)
    if (!finished) await stream.return(undefined as never).catch(() => {})
  }
}

/**
 * The call was not made by the model but by a mod: a `$.ui.ask` (which the engine runs as a
 * tool.call of AskUserQuestion, e.g. Quorum's permission dialog) or a `$.tool.call`.
 * It is not reflected on the devices (neither tool row nor question card).
 * `next.origin` says who caused it; without it (old builds), the engine's `toolu_plugin_…` id.
 */
export function fromPlugin(origin: { plugin?: string } | undefined, e: { tool_use_id?: unknown }): boolean {
  if (origin?.plugin !== undefined && origin.plugin !== 'engine') return true
  return typeof e.tool_use_id === 'string' && e.tool_use_id.startsWith('toolu_plugin_')
}

/** Body of the tool.call hook: tool_start, call, tool_end (also if it throws). */
export async function toolHook<R>(h: Handlers, e: Call, run: () => Promise<R>): Promise<R> {
  h.toolStart(e)
  const t0 = Date.now()
  let r: R
  try {
    r = await run()
  } catch (err) {
    h.toolEnd(e, { isError: true, text: String((err as Error)?.message ?? err) }, Date.now() - t0)
    throw err
  }
  h.toolEnd(e, r as never, Date.now() - t0)
  return r
}
