import type { BackgroundInfo, BackgroundItem } from './proto.gen'

/** What is left of a session once its turn ends: live background tasks and the next wake-up. */
export type { BackgroundInfo, BackgroundItem }

/** The state a session is in between turns: `background` with anything pending, else `idle`. */
export function stateOf(bg: BackgroundInfo): 'background' | 'idle' {
  return bg.tasks > 0 || bg.wakeAt > 0 ? 'background' : 'idle'
}

/** Longest item label (the command line, a monitor's description, a prompt). */
export const LABEL_MAX = 200
/** Longest output tail a task_end carries. */
export const OUTPUT_TAIL_MAX = 2000
const SUMMARY_MAX = 500

/** A label: one line of at most LABEL_MAX characters. */
export function label(v: unknown): string {
  return typeof v === 'string' ? v.slice(0, LABEL_MAX * 8).replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX) : ''
}

/** How much of a notification prompt is parsed: its head and its last NOTICE_TAIL characters. */
export const NOTICE_MAX = 256 * 1024
const NOTICE_TAIL = 8 * 1024

const END_STATUS = new Set(['completed', 'failed', 'killed', 'stopped', 'cancelled', 'canceled', 'error', 'timeout'])

/** One `<task-notification>` block as parsed (fields absent when the block lacks them). */
export type TaskNotice = {
  taskId: string
  toolUseId?: string
  status?: string
  summary: string
  outputFile?: string
  exitCode?: number
  /** The tail of the `<result>` / `<output>` the block carries, at most OUTPUT_TAIL_MAX. */
  outputTail?: string
  /** A monitor's event line (`<event>`). */
  event?: string
  /** The status ends the task (completed, failed, killed, ...). */
  ended: boolean
}

/** The trimmed text of the first `<name>…</name>` (linear: indexOf, no backtracking). */
function tagOf(body: string, name: string): string | undefined {
  const open = body.indexOf(`<${name}>`)
  if (open < 0) return undefined
  const from = open + name.length + 2
  const close = body.indexOf(`</${name}>`, from)
  return close < 0 ? undefined : body.slice(from, close).trim()
}

/** The text between the first `<name>` and the LAST `</name>` (a result may quote markup). */
function wideTag(body: string, name: string): string | undefined {
  const open = body.indexOf(`<${name}>`)
  const close = body.lastIndexOf(`</${name}>`)
  if (open < 0 || close < open) return undefined
  return body.slice(open + name.length + 2, close).trim()
}

/** Does this prompt text come from Claude Code's task notifications (it starts with one)? */
export function isTaskNotification(text: unknown): boolean {
  return typeof text === 'string' && text.trimStart().startsWith('<task-notification>')
}

/**
 * Every `<task-notification>` block of a prompt Claude Code injected, e.g.
 * `<task-notification><task-id>b1</task-id><tool-use-id>toolu_1</tool-use-id>
 * <output-file>/tmp/…/b1.output</output-file><status>completed</status>
 * <summary>Background command "npm test" completed (exit code 0)</summary></task-notification>`.
 * Missing fields are tolerated; a block without a task id is skipped. The output file is never read.
 */
export function parseTaskNotifications(text: unknown): TaskNotice[] {
  const out: TaskNotice[] = []
  let src = String(text ?? '')
  // bounded work: the head (the header tags) and the tail (a result's end, the closing tags)
  if (src.length > NOTICE_MAX) src = src.slice(0, NOTICE_MAX - NOTICE_TAIL) + src.slice(-NOTICE_TAIL)
  const OPEN = '<task-notification>'
  const CLOSE = '</task-notification>'
  for (let at = src.indexOf(OPEN); at >= 0; at = src.indexOf(OPEN, at)) {
    const close = src.indexOf(CLOSE, at + OPEN.length)
    if (close < 0) break
    const whole = src.slice(at + OPEN.length, close)
    at = close + CLOSE.length
    // header tags are searched only before the result / output (which may quote markup)
    const cut = [whole.indexOf('<result>'), whole.indexOf('<output>')].filter(i => i >= 0)
    const body = cut.length ? whole.slice(0, Math.min(...cut)) : whole
    const taskId = tagOf(body, 'task-id')?.trim()
    if (!taskId) continue
    const status = tagOf(body, 'status')?.trim().toLowerCase() || undefined
    const summary = (tagOf(body, 'summary') ?? '').trim().slice(0, SUMMARY_MAX)
    const n: TaskNotice = { taskId, summary, ended: !!status && END_STATUS.has(status) }
    if (status) n.status = status
    const toolUseId = tagOf(body, 'tool-use-id')?.trim()
    if (toolUseId) n.toolUseId = toolUseId
    const outputFile = tagOf(body, 'output-file')?.trim()
    if (outputFile) n.outputFile = outputFile
    const code = tagOf(body, 'exit-code') ?? /exit code:?\s*(-?\d+)/i.exec(summary)?.[1]
    if (code !== undefined && /^\s*-?\d+\s*$/.test(code)) n.exitCode = Number(code)
    const output = wideTag(whole, 'result') ?? wideTag(whole, 'output')
    if (output) n.outputTail = output.slice(-OUTPUT_TAIL_MAX)
    const event = tagOf(body, 'event')
    if (event !== undefined) n.event = event.slice(0, SUMMARY_MAX)
    out.push(n)
  }
  return out
}

/**
 * Task ids a `<task-notification>` prompt reports as ended (a status like completed,
 * failed or killed). A monitor's event (no status, or `running`) ends nothing.
 */
export function taskEnds(text: string): string[] {
  return parseTaskNotifications(text).filter(n => n.ended).map(n => n.taskId)
}

/** A kind for a task the mod never saw start, from the notification's summary. */
export function guessKind(summary: string): string {
  if (/^\s*(background\s+)?command\b|^\s*shell\b/i.test(summary)) return 'command'
  if (/^\s*monitor\b/i.test(summary)) return 'monitor'
  if (/^\s*(agent|subagent)\b/i.test(summary)) return 'subagent'
  return 'task'
}

/** A classic Stop `background_tasks[].type` as a BackgroundItem kind. */
export function kindOfType(type: unknown): string {
  const t = typeof type === 'string' ? type.toLowerCase() : ''
  return t === 'shell' || t === 'bash' ? 'command' : t === 'monitor' ? 'monitor' : t === 'subagent' || t === 'agent' ? 'subagent' : t || 'task'
}

/**
 * The background task a finished tool call started: a Bash run in (or moved to) the
 * background (`result.backgroundTaskId`), a Monitor (`result.taskId`), an Agent launched in the
 * background (`result.status` async_launched / remote_launched, `result.agentId`).
 */
export function backgroundStart(tool: string, r: { deny?: unknown; isError?: unknown; result?: unknown } | undefined):
  { taskId: string; kind: string } | undefined {
  if (!r || r.deny !== undefined || r.isError) return undefined
  const res = r.result as Record<string, unknown> | undefined
  if (!res || typeof res !== 'object') return undefined
  if (typeof res.backgroundTaskId === 'string' && res.backgroundTaskId) return { taskId: res.backgroundTaskId, kind: 'command' }
  if (tool === 'Monitor' && typeof res.taskId === 'string' && res.taskId) return { taskId: res.taskId, kind: 'monitor' }
  if (tool === 'Agent' && (res.status === 'async_launched' || res.status === 'remote_launched') && typeof res.agentId === 'string' && res.agentId) {
    return { taskId: res.agentId, kind: 'subagent' }
  }
  return undefined
}

/** What a tool call that started background work says it is (its item label). */
export function startLabel(tool: string, input: Record<string, unknown>): string {
  if (tool === 'Monitor') {
    const ws = input.ws as { url?: unknown } | undefined
    return label(input.description) || label(input.command) || label(ws?.url)
  }
  if (tool === 'Agent') return label(input.description) || label(input.prompt)
  return label(input.command) || label(input.description)
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
