import { middleTruncate } from './truncate'
import type { Event } from '../proto.gen'

export type ToolKind = 'read' | 'search' | 'edit' | 'write' | 'bash' | 'web_search' | 'web_fetch' | 'skill' | 'agent' | 'todo' | 'mcp' | 'other'
export type ToolState = 'running' | 'ok' | 'error' | 'denied'

export type ToolItem = {
  t: 'tool'; seq: number; id: string; name: string; kind: ToolKind; title: string; detail?: string
  input?: any; output?: string; state: ToolState; ms?: number; agent?: string
  file?: string; diff?: { add: number; del: number }
}
export type ReadsItem = { t: 'reads'; seq: number; files: string[]; title: string; state: ToolState; agent?: string; tools: ToolItem[] }
export type AgentItem = { t: 'agent'; seq: number; id: string; type: string; description: string; status: string; answer?: string }
export type ArtifactItem = { t: 'artifact'; seq: number; path: string; name: string; inBase: boolean }
export type TurnItem = { t: 'turn'; seq: number; tokens?: { in: number; out: number; cache: number }; model: string }
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

export type Item =
  | TurnItem
  | { t: 'user' | 'assistant' | 'info'; seq: number; text: string; agent?: string; images?: PastedImage[] }
  | ToolItem
  | ReadsItem
  | AgentItem
  | ArtifactItem

const VIEWABLE = new Set(['html', 'htm', 'md', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf'])
const EDIT_VIEWABLE = new Set(['html', 'htm', 'svg'])
const DENIED = /deneg|denied|rechaz/i

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

function artifactFor(t: ToolItem, base: string): ArtifactItem | undefined {
  if (t.state !== 'ok' || !t.file) return undefined
  const x = ext(t.file)
  const ok = t.name === 'Write' ? VIEWABLE.has(x) : (t.name === 'Edit' || t.name === 'MultiEdit') && EDIT_VIEWABLE.has(x)
  if (!ok) return undefined
  const path = absPath(t.file, base)
  return { t: 'artifact', seq: t.seq, path, name: basename(path), inBase: inBase(path, base) }
}

function groupState(ts: ToolItem[]): ToolState {
  for (const s of ['running', 'error', 'denied'] as const) if (ts.some((t) => t.state === s)) return s
  return 'ok'
}

/**
 * Turns session events (seq order) into timeline items: tool_start/tool_end paired by id,
 * consecutive Reads of the same agent merged, one artifact card per viewable file (the last one wins).
 * `base` is the session's root, else its cwd.
 */
export function buildTimeline(events: Event[], base: string): Item[] {
  const flat: Item[] = []
  const tools = new Map<string, ToolItem>()
  const agents = new Map<string, AgentItem>()
  const settle = (t: ToolItem) => { const a = artifactFor(t, base); if (a) flat.push(a) }

  for (const e of events) {
    const d = e.data ?? {}
    switch (e.kind) {
      case 'user': case 'assistant': case 'info':
      {
        const images = e.kind === 'user' ? pastedImagesOf(d.images) : undefined
        flat.push({ t: e.kind, seq: e.seq, text: d.text ?? '', agent: d.agent || undefined, ...(images ? { images } : {}) })
      }
        break
      case 'turn_end':
        // a footer only when the mod reported tokens (older events carry none)
        if (d.tokens && typeof d.tokens === 'object') flat.push({ t: 'turn', seq: e.seq, tokens: d.tokens, model: typeof d.model === 'string' ? d.model : '' })
        break
      case 'tool_start': {
        const name: string = d.name ?? ''
        const kind = toolKind(name)
        // backfilled history (negative seq) has no tool_end: it is shown as finished
        const t: ToolItem = { t: 'tool', seq: e.seq, id: d.id, name, kind, ...describe(name, kind, d.input, d.summary ?? ''), input: d.input, state: e.seq < 0 ? 'ok' : 'running', agent: d.agent || undefined }
        tools.set(d.id, t)
        flat.push(t)
        if (t.state === 'ok') settle(t)
        break
      }
      case 'tool_end': {
        const ok = d.ok !== false
        const output: string = d.output ?? ''
        const state: ToolState = ok ? 'ok' : DENIED.test(output) ? 'denied' : 'error'
        const t = tools.get(d.id)
        if (t) {
          const was = t.state
          Object.assign(t, { state, ms: d.ms, output })
          if (was === 'running') settle(t)
        } else {
          flat.push({ t: 'tool', seq: e.seq, id: d.id, name: 'tool', kind: 'other', title: 'tool', state, ms: d.ms, output, agent: d.agent || undefined })
        }
        break
      }
      case 'agent_start': {
        const a: AgentItem = { t: 'agent', seq: e.seq, id: d.id, type: d.type ?? '', description: d.description ?? '', status: 'running' }
        agents.set(d.id, a)
        flat.push(a)
        break
      }
      case 'agent_end': {
        const a = agents.get(d.id)
        if (a) Object.assign(a, { status: d.status ?? 'done', answer: d.answer })
        break
      }
    }
  }

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
