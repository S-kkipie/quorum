import { middleTruncate } from './truncate'
import type { Event } from '../proto.gen'

export type ToolKind = 'read' | 'search' | 'edit' | 'write' | 'bash' | 'web_search' | 'web_fetch' | 'skill' | 'agent' | 'todo' | 'mcp' | 'other'
export type ToolState = 'running' | 'ok' | 'error' | 'denied'

export type ToolItem = {
  t: 'tool'; seq: number; id: string; name: string; kind: ToolKind; title: string; detail?: string
  input?: any; output?: string; state: ToolState; ms?: number; agent?: string
  file?: string; diff?: { add: number; del: number }
  /** this call started background work: it runs until the task_end with this id (then `status` is that end's status) */
  bg?: { taskId: string; status?: string }
}
export type ReadsItem = { t: 'reads'; seq: number; files: string[]; title: string; state: ToolState; agent?: string; tools: ToolItem[] }
/**
 * A subagent: its Agent call and its agent_start/agent_end as one card. `id` is the agent's id once
 * known (agent_start, or a background launch's task id), else its Agent call's id.
 */
export type AgentItem = { t: 'agent'; seq: number; id: string; type: string; description: string; status: string; answer?: string
  /** stable for the card's whole life (its Agent call's id, else its agent id), while `id` may change */
  key: string
  /** a background subagent: its Agent call's task id (= this id) and, once ended, the task_end status */
  bg?: { taskId: string; status?: string }
  /** the Agent call that started it */
  toolId?: string
  /** the task it was given (the Agent call's prompt) */
  prompt?: string
  /** the subagent that spawned it (absent for one of the main conversation) */
  agent?: string
  /** its own tool calls so far, and the newest one's title (set by partitionTimeline) */
  steps?: number
  lastTool?: string
  /** event times (Unix ms) of its start and end, when known */
  startedAt?: number
  endedAt?: number
  /** tokens it used, when its Agent call's result says */
  tokens?: number }
/** Subagents launched together (consecutive Agent calls a few seconds apart): one card. */
export type AgentGroupItem = { t: 'agents'; seq: number; agents: AgentItem[] }
export type ArtifactItem = { t: 'artifact'; seq: number; path: string; name: string; inBase: boolean; agent?: string }
/** A slash command a device ran: one item per command id, with its latest status. */
export type CommandItem = { t: 'command'; seq: number; id: string; name: string; args: string; origin: string; status: 'queued' | 'done' | 'failed'; text?: string; error?: string }
/** A compact boundary: "Conversation compacted · HH:MM" (no time when `at` is unknown). */
export type CompactItem = { t: 'compact'; seq: number; at?: number; trigger: string }
/** A background task finished (Claude Code's task notification, parsed by the mod). */
export type TaskEndItem = { t: 'task_end'; seq: number; taskId: string; kind: string; summary: string; status: string; exitCode?: number; outputTail?: string }
export type TurnItem = { t: 'turn'; seq: number; tokens?: { in: number; out: number; cache: number }; model: string }
/** How the Viewer asks for a file's link: an image pasted in the terminal, or an image Claude read. */
export type OpenOpts = { images: true } | { read: true } | { upload: true }

/** An image the owner pasted in the terminal (`[Image #n]`), stored at `path` on the session's machine. */
export type PastedImage = { n: number; path: string }

/** The images a user event carries, from the mod; anything malformed is dropped (at most 20). */
export function pastedImagesOf(v: unknown): PastedImage[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out = v
    .filter((x): x is PastedImage => !!x && typeof x === 'object' && Number.isInteger(x.n) && typeof x.path === 'string' && x.path !== '')
    .slice(0, 20)
    .map(({ n, path }) => ({ n, path }))
  return out.length ? out : undefined
}

/** A slash command the user event stands for (the mod parses Claude Code's command markup). */
export type CommandRef = { name: string; args: string }

export type Item =
  | TurnItem
  | { t: 'user' | 'assistant' | 'info'; seq: number; text: string; agent?: string; images?: PastedImage[]; command?: CommandRef }
  | ToolItem
  | ReadsItem
  | AgentItem
  | ArtifactItem
  | CommandItem
  | CompactItem
  | TaskEndItem

/**
 * Row seq of events read from the machine's transcript (they have no hub seq): below every hub seq
 * (backfill is -n..-1), counted from the newest history event so rows already shown keep their seq
 * when older pages are prepended. Negative, so their tools show as finished like backfill.
 */
const HIST_SEQ = -1_000_000_000

/** How many timeline items away a device command's card may be to stand in for its user event. */
const CARD_NEAR = 200

const commandRefOf = (v: any): CommandRef | undefined =>
  v && typeof v === 'object' && typeof v.name === 'string' && v.name ? { name: v.name, args: typeof v.args === 'string' ? v.args : '' } : undefined

const VIEWABLE = new Set(['html', 'htm', 'md', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf'])
const EDIT_VIEWABLE = new Set(['html', 'htm', 'svg'])
const DENIED = /deneg|denied|rechaz/i
/** An Agent call's result that only says it launched the subagent (it keeps running). */
const LAUNCHED = /async agent launched|async_launched|remote_launched|"isAsync"\s*:\s*true/i

/** Last path segment, for `/` and `\` separators. */
export function basename(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

const ext = (p: string): string => {
  const b = basename(p)
  const i = b.lastIndexOf('.')
  return i > 0 ? b.slice(i + 1).toLowerCase() : ''
}

const isWin = (p: string): boolean => /^[a-zA-Z]:/.test(p) || p.startsWith('\\\\')
const isAbs = (p: string): boolean => p.startsWith('/') || isWin(p) || p.startsWith('\\')

/** `.`/`..` resolved, single separators, no trailing separator; keeps case and the path's own separator style. */
function clean(p: string): string {
  const win = isWin(p)
  const sep = win ? '\\' : '/'
  const lead = p.startsWith('\\\\') ? '\\\\' : p.startsWith('/') || p.startsWith('\\') ? sep : ''
  const out: string[] = []
  for (const s of p.split(/[\\/]+/)) {
    if (!s || s === '.') continue
    if (s === '..') { if (out.length > (win ? 1 : 0)) out.pop(); continue }
    out.push(s)
  }
  return lead + out.join(sep)
}

/** Comparable form: cleaned, `/`-separated, lower-cased for Windows paths. */
function norm(p: string): string {
  const r = clean(p).replace(/\\/g, '/')
  return isWin(p) ? r.toLowerCase() : r
}

/** Relative paths are joined to the base (the hub only accepts absolute paths). */
function resolve(p: string, base: string): string {
  if (isAbs(p) || !base) return p
  const sep = isWin(base) ? '\\' : '/'
  return base.replace(/[\\/]+$/, '') + sep + p
}

/** Absolute, cleaned form of a file path the session reported (relative ones join the base). */
export function absPath(p: string, base: string): string {
  return clean(resolve(p, base))
}

/** True when `path` lies strictly inside `base` (prefix plus separator). False with an empty base. */
export function inBase(path: string, base: string): boolean {
  if (!base || !path) return false
  const b = norm(base)
  const p = norm(resolve(path, base))
  const prefix = b.endsWith('/') ? b : b + '/'
  return p.length > prefix.length && p.startsWith(prefix)
}

/** True when `path` lies inside the base or inside one of the session's git worktrees. */
export function inBases(path: string, base: string, worktrees: readonly string[] = []): boolean {
  return inBase(path, base) || worktrees.some((w) => inBase(path, w))
}

/** The folder `path` belongs to: the base if it holds it, else the first worktree that does, else the base. */
export function baseOf(path: string, base: string, worktrees: readonly string[] = []): string {
  if (inBase(path, base)) return base
  return worktrees.find((w) => inBase(path, w)) ?? base
}

function lines(s: string): string[] {
  if (!s) return []
  const l = s.split('\n')
  if (l[l.length - 1] === '') l.pop()
  return l
}

/** Line diff counts based on the longest common subsequence. */
export function diffLines(a: string, b: string): { add: number; del: number } {
  let x = lines(a)
  let y = lines(b)
  let s = 0
  while (s < x.length && s < y.length && x[s] === y[s]) s++
  let e = 0
  while (e < x.length - s && e < y.length - s && x[x.length - 1 - e] === y[y.length - 1 - e]) e++
  x = x.slice(s, x.length - e)
  y = y.slice(s, y.length - e)
  // cost cap: past this size every remaining line counts as changed
  if (x.length * y.length > 250_000) return { add: y.length, del: x.length }
  let prev = new Uint32Array(y.length + 1)
  let cur = new Uint32Array(y.length + 1)
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) {
      cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
    }
    ;[prev, cur] = [cur, prev]
  }
  const lcs = prev[y.length]
  return { add: y.length - lcs, del: x.length - lcs }
}

export function toolKind(name: string): ToolKind {
  switch (name) {
    case 'Read': return 'read'
    case 'Grep': case 'Glob': return 'search'
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return 'edit'
    case 'Write': return 'write'
    case 'Bash': return 'bash'
    case 'WebSearch': return 'web_search'
    case 'WebFetch': return 'web_fetch'
    case 'Skill': return 'skill'
    case 'Agent': case 'Task': return 'agent'
    case 'TodoWrite': return 'todo'
  }
  return name.startsWith('mcp__') ? 'mcp' : 'other'
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const firstLine = (s: string): string => s.split('\n').find((l) => l.trim())?.trim() ?? ''

function host(u: string): string {
  try { return new URL(u).host || u } catch { return u }
}

/** Title, detail, file and diff of a tool. Old events without `input` fall back to `summary`. */
function describe(name: string, kind: ToolKind, input: any, summary: string): Pick<ToolItem, 'title' | 'detail' | 'file' | 'diff'> {
  const i = input && typeof input === 'object' ? input : {}
  // the mod's summary of Read/Write/Edit is the file path
  const path = str(i.file_path) ?? str(i.notebook_path) ?? (['Read', 'Write', 'Edit'].includes(name) ? str(summary) : undefined)
  switch (kind) {
    case 'read': return { title: path ? `Read ${basename(path)}` : summary ? `Read ${summary}` : name, file: path }
    case 'search': return { title: `Searched ${str(i.pattern) ?? summary}`, detail: str(i.path) ?? str(i.glob) }
    case 'edit': {
      let diff: ToolItem['diff']
      if (Array.isArray(i.edits)) {
        diff = { add: 0, del: 0 }
        for (const e of i.edits) {
          const d = diffLines(String(e?.old_string ?? ''), String(e?.new_string ?? ''))
          diff.add += d.add
          diff.del += d.del
        }
      } else if (typeof i.old_string === 'string' || typeof i.new_string === 'string') {
        diff = diffLines(String(i.old_string ?? ''), String(i.new_string ?? ''))
      }
      return { title: path ? `Edited ${basename(path)}` : summary ? `Edited ${summary}` : name, file: path, diff }
    }
    case 'write': return { title: path ? `Created ${middleTruncate(basename(path), 24)}` : summary ? `Created ${summary}` : name, file: path }
    case 'bash': {
      const cmd = str(i.command) ?? summary
      const desc = str(i.description)
      return desc ? { title: desc, detail: firstLine(cmd) || undefined } : { title: firstLine(cmd) || name }
    }
    case 'web_search': return { title: `Searched "${str(i.query) ?? summary}"` }
    case 'web_fetch': return { title: `Read ${host(str(i.url) ?? summary)}` }
    case 'skill': {
      const s = str(i.skill) ?? summary
      return { title: `Used skill ${s.slice(s.lastIndexOf(':') + 1)}` }
    }
    case 'agent': return { title: `Subagent: ${str(i.description) ?? summary}`, detail: str(i.subagent_type) }
    case 'todo': {
      if (!Array.isArray(i.todos)) return { title: 'Updated the plan' }
      const done = i.todos.filter((t: any) => t?.status === 'completed').length
      return { title: `Updated the plan (${i.todos.length} tasks, ${done} done)` }
    }
    case 'mcp': {
      const [, server = '', ...rest] = name.split('__')
      return { title: `Used ${rest.join('__') || name} (${server})` }
    }
    default: return { title: name }
  }
}

function artifactFor(t: ToolItem, base: string, worktrees: readonly string[]): ArtifactItem | undefined {
  if (t.state !== 'ok' || !t.file) return undefined
  const x = ext(t.file)
  const ok = t.name === 'Write' ? VIEWABLE.has(x) : (t.name === 'Edit' || t.name === 'MultiEdit') && EDIT_VIEWABLE.has(x)
  if (!ok) return undefined
  const path = absPath(t.file, base)
  return { t: 'artifact', seq: t.seq, path, name: basename(path), inBase: inBases(path, base, worktrees), ...(t.agent ? { agent: t.agent } : {}) }
}

function groupState(ts: ToolItem[]): ToolState {
  for (const s of ['running', 'error', 'denied'] as const) if (ts.some((t) => t.state === s)) return s
  return 'ok'
}

/**
 * Drops (in place) the user event of each command a device ran when a card of the same command
 * is nearby: the card already shows it. Each card stands in for one user event, the closest
 * (same args first); a device command without a card keeps its user event.
 */
function hideDeviceCommands(flat: Item[], device: Set<Item>): void {
  if (!device.size) return
  const used = new Set<Item>()
  const drop = new Set<Item>()
  flat.forEach((it, i) => {
    if (!device.has(it) || it.t !== 'user' || !it.command) return
    const { name, args } = it.command
    let best = -1
    let bestScore = Infinity
    for (let j = Math.max(0, i - CARD_NEAR); j < Math.min(flat.length, i + CARD_NEAR + 1); j++) {
      const c = flat[j]
      if (c.t !== 'command' || c.name !== name || used.has(c)) continue
      const score = Math.abs(j - i) + (c.args.trim() === args.trim() ? 0 : CARD_NEAR * 2)
      if (score < bestScore) { best = j; bestScore = score }
    }
    if (best >= 0) { used.add(flat[best]); drop.add(it) }
  })
  for (let i = flat.length - 1; i >= 0; i--) if (drop.has(flat[i])) flat.splice(i, 1)
}

/** The transcript row key of an item (the inspector scrolls to a row by it). */
export const itemKey = (r: Item): string => `${r.t}:${r.t === 'command' ? r.id : r.seq}`

/**
 * Turns session events (seq order) into timeline items: tool_start/tool_end paired by id,
 * consecutive Reads of the same agent merged, one artifact card per viewable file (the last one wins).
 * `base` is the session's root, else its cwd.
 */
export function buildTimeline(events: Event[], base: string, worktrees: readonly string[] = []): Item[] {
  const flat: Item[] = []
  const tools = new Map<string, ToolItem>()
  // background tasks: tool rows by task id, and the status of tasks that already ended (a task_end can come first)
  const bgTools = new Map<string, { bg?: { taskId: string; status?: string } }[]>()
  const taskEnds = new Map<string, { status: string; synthetic: boolean; item: TaskEndItem }>()
  const agents = new Map<string, AgentItem>()
  // Agent calls by tool id, and those not yet tied to an agent_start (oldest first)
  const agentCalls = new Map<string, AgentItem>()
  let unlinked: AgentItem[] = []
  // calls an agent_start was tied to: their agent_end, not their tool_end, says how they ended
  const linked = new Set<AgentItem>()
  const commands = new Map<string, CommandItem>()
  // user events of commands a device ran: the command card shows them (see hideDeviceCommands)
  const deviceCommands = new Set<Item>()
  // the main turn ended: a foreground subagent still shown running lost its agent_end (it cannot
  // outlive the call that waits on it); background ones, and anything under one, wait for their end
  const settleForeground = (ts: number) => {
    const inBackground = (a: AgentItem | undefined): boolean => {
      const seen = new Set<AgentItem>()
      while (a && !seen.has(a)) { if (a.bg) return true; seen.add(a); a = a.agent ? agents.get(a.agent) : undefined }
      return false
    }
    for (const it of flat) {
      if (it.t !== 'agent' || it.status !== 'running' || inBackground(it)) continue
      it.status = 'completed'
      if (ts && !it.endedAt) it.endedAt = ts
    }
  }
  const settle = (t: ToolItem) => { const a = artifactFor(t, base, worktrees); if (a) flat.push(a) }

  let histLeft = 0
  for (const e of events) if (!e.seq) histLeft++
  for (const e of events) {
    const d = e.data ?? {}
    const seq = e.seq || HIST_SEQ - --histLeft
    switch (e.kind) {
      case 'user': case 'assistant': case 'info':
      {
        const images = e.kind === 'user' ? pastedImagesOf(d.images) : undefined
        const command = e.kind === 'user' ? commandRefOf(d.command) : undefined
        flat.push({ t: e.kind, seq, text: d.text ?? '', agent: d.agent || undefined, ...(images ? { images } : {}), ...(command ? { command } : {}) })
        if (command && d.device === true) deviceCommands.add(flat[flat.length - 1])
      }
        break
      case 'status':
        if (d.state === 'idle' && !d.agent) settleForeground(e.ts)
        break
      case 'turn_end':
        if (!d.agent) settleForeground(e.ts)
        // a footer only when the mod reported tokens (older events carry none)
        if (d.tokens && typeof d.tokens === 'object') flat.push({ t: 'turn', seq, tokens: d.tokens, model: typeof d.model === 'string' ? d.model : '' })
        break
      case 'tool_start': {
        const name: string = d.name ?? ''
        const kind = toolKind(name)
        // backfilled history (negative seq) has no tool_end: it is shown as finished
        if (kind === 'agent') {
          // the call is the subagent's card: agent_start / agent_end / its own tool_end fill it in
          const i = d.input && typeof d.input === 'object' ? d.input : {}
          const a: AgentItem = {
            t: 'agent', seq, id: d.id, key: d.id, toolId: d.id, type: str(i.subagent_type) ?? '', description: str(i.description) ?? str(d.summary) ?? '',
            status: seq < 0 ? 'completed' : 'running', ...(str(i.prompt) ? { prompt: i.prompt } : {}), ...(d.agent ? { agent: d.agent } : {}), ...(e.ts ? { startedAt: e.ts } : {}),
          }
          agentCalls.set(d.id, a)
          if (seq >= 0) unlinked.push(a)
          flat.push(a)
          break
        }
        const t: ToolItem = { t: 'tool', seq, id: d.id, name, kind, ...describe(name, kind, d.input, d.summary ?? ''), input: d.input, state: seq < 0 ? 'ok' : 'running', agent: d.agent || undefined }
        tools.set(d.id, t)
        flat.push(t)
        if (t.state === 'ok') settle(t)
        break
      }
      case 'tool_end': {
        const ok = d.ok !== false
        const output: string = d.output ?? ''
        const state: ToolState = ok ? 'ok' : DENIED.test(output) ? 'denied' : 'error'
        const call = agentCalls.get(d.id)
        if (call) {
          const taskId = ok ? str(d.background?.taskId) : undefined
          unlinked = unlinked.filter((x) => x !== call)
          if (taskId) {
            // a background launch: its task id is the agent's id (an agent_start not tied to the call yet joins it)
            const other = agents.get(taskId)
            if (other && other !== call) {
              const i = flat.indexOf(other)
              if (i >= 0) flat.splice(i, 1)
              Object.assign(call, { type: call.type || other.type, description: call.description || other.description, status: other.status, answer: other.answer, endedAt: other.endedAt })
            }
            call.id = taskId
            agents.set(taskId, call)
            call.bg = { taskId, ...(taskEnds.has(taskId) ? { status: taskEnds.get(taskId)!.status } : {}) }
            bgTools.set(taskId, [...(bgTools.get(taskId) ?? []), call])
          } else if (call.status === 'running' && (!ok || (!linked.has(call) && !LAUNCHED.test(output)))) {
            // a call no agent_start was tied to ends with its tool_end; a failed call always does
            call.status = ok ? 'completed' : 'error'
            if (!call.answer && output) call.answer = output
            if (e.ts && !call.endedAt) call.endedAt = e.ts
          }
          const tok = output.match(/"?total_?tokens"?\s*[:=]\s*(\d+)/i)
          if (tok) call.tokens = Number(tok[1])
          break
        }
        const t = tools.get(d.id)
        if (t) {
          const was = t.state
          Object.assign(t, { state, ms: d.ms, output })
          const taskId = ok ? str(d.background?.taskId) : undefined
          if (taskId) {
            t.bg = { taskId, ...(taskEnds.has(taskId) ? { status: taskEnds.get(taskId)!.status } : {}) }
            bgTools.set(taskId, [...(bgTools.get(taskId) ?? []), t])
          }
          if (was === 'running') settle(t)
        } else {
          flat.push({ t: 'tool', seq, id: d.id, name: 'tool', kind: 'other', title: 'tool', state, ms: d.ms, output, agent: d.agent || undefined })
        }
        break
      }
      case 'agent_start': {
        if (typeof d.id !== 'string' || !d.id) break
        const parent: string | undefined = d.agent || undefined
        // a background launch already named it (its task id is the agent's id)
        const known = agents.get(d.id)
        if (known) {
          Object.assign(known, { type: str(d.type) ?? known.type, description: str(d.description) ?? known.description }, parent ? { agent: parent } : {})
          linked.add(known)
          break
        }
        // its Agent call: the one the mod names ('' = no call started it: a card of its own); from an
        // older mod (no `tool`), the only running call of that description (of the same parent when it
        // is named: never a main-level call for a nested one)
        let call: AgentItem | undefined
        if (typeof d.tool === 'string') call = d.tool ? unlinked.find((x) => x.toolId === d.tool) : undefined
        else {
          const same = unlinked.filter((x) => x.description === (d.description ?? '') && (!parent || x.agent === parent))
          if (same.length === 1) call = same[0]
        }
        if (call) {
          unlinked = unlinked.filter((x) => x !== call)
          linked.add(call)
          Object.assign(call, { id: d.id, type: str(d.type) ?? call.type, description: str(d.description) ?? call.description }, parent ? { agent: parent } : {})
          agents.set(d.id, call)
          break
        }
        const a: AgentItem = { t: 'agent', seq, id: d.id, key: d.id, type: d.type ?? '', description: d.description ?? '', status: 'running', ...(parent ? { agent: parent } : {}), ...(e.ts ? { startedAt: e.ts } : {}) }
        agents.set(d.id, a)
        flat.push(a)
        break
      }
      case 'command': {
        if (typeof d.id !== 'string' || !d.id || typeof d.name !== 'string') break
        const status: CommandItem['status'] = d.status === 'done' || d.status === 'failed' ? d.status : 'queued'
        const patch = { status, text: str(d.text), error: str(d.error) }
        const cur = commands.get(d.id)
        if (cur) { Object.assign(cur, patch); break }
        const c: CommandItem = { t: 'command', seq, id: d.id, name: d.name, args: typeof d.args === 'string' ? d.args : '', origin: str(d.origin) ?? 'device', ...patch }
        commands.set(d.id, c)
        flat.push(c)
        break
      }
      case 'compact':
        flat.push({ t: 'compact', seq, at: typeof d.at === 'number' && d.at > 0 ? d.at : undefined, trigger: typeof d.trigger === 'string' ? d.trigger : '' })
        break
      case 'task_end': {
        // one card per task: the mod, a machine history page and a reconnect can all deliver the same
        // end; a real end (the task's own notification) replaces a synthetic "stopped" one in place
        const taskId = str(d.taskId) ?? ''
        const synthetic = d.synthetic === true
        const item: TaskEndItem = { t: 'task_end', seq, taskId, kind: str(d.kind) ?? '', summary: str(d.summary) ?? '', status: str(d.status) ?? '', ...(typeof d.exitCode === 'number' ? { exitCode: d.exitCode } : {}), ...(str(d.outputTail) ? { outputTail: d.outputTail } : {}) }
        if (taskId) {
          const prev = taskEnds.get(taskId)
          if (prev && (!prev.synthetic || synthetic)) break
          for (const t of bgTools.get(taskId) ?? []) t.bg = { taskId, status: item.status }
          if (prev) {
            const { seq: _, ...rest } = item
            for (const k of ['exitCode', 'outputTail'] as const) delete prev.item[k]
            Object.assign(prev.item, rest)
            taskEnds.set(taskId, { status: item.status, synthetic, item: prev.item })
            break
          }
          taskEnds.set(taskId, { status: item.status, synthetic, item })
        }
        flat.push(item)
        break
      }
      case 'agent_end': {
        const a = agents.get(d.id)
        if (a) Object.assign(a, { status: d.status ?? 'done', answer: d.answer || a.answer }, e.ts ? { endedAt: e.ts } : {})
        break
      }
    }
  }

  // a background subagent's own row follows its launching Agent call (task id = agent id)
  for (const [id, a] of agents) { const t = bgTools.get(id)?.[0]; if (t?.bg && !a.bg) a.bg = { ...t.bg } }

  hideDeviceCommands(flat, deviceCommands)

  // one card per file: the last one wins
  const lastCard = new Map<string, ArtifactItem>()
  for (const it of flat) if (it.t === 'artifact') lastCard.set(norm(it.path), it)

  const out: Item[] = []
  let run: ToolItem[] = []
  const flush = () => {
    if (run.length === 1) out.push(run[0])
    else if (run.length > 1) {
      const files = run.map((t) => t.file ?? t.title.replace(/^Read /, ''))
      out.push({ t: 'reads', seq: run[0].seq, files, title: `Read ${basename(files[0])} and ${files.length - 1} more`, state: groupState(run), agent: run[0].agent, tools: run })
    }
    run = []
  }
  for (const it of flat) {
    if (it.t === 'artifact' && lastCard.get(norm(it.path)) !== it) continue
    if (it.t === 'tool' && it.kind === 'read' && (run.length === 0 || run[0].agent === it.agent)) { run.push(it); continue }
    flush()
    if (it.t === 'tool' && it.kind === 'read') { run.push(it); continue }
    out.push(it)
  }
  flush()
  return out
}

