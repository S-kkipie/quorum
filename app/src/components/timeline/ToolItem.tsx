import { useState, type ReactNode } from 'react'
import {
  Ban, Bot, Check, Circle, CircleCheck, CircleDot, ExternalLink, FilePen, FilePlus, FileText, Globe,
  ListTodo, Loader2, Plug, Search, Sparkles, Square, Terminal, Wrench, X, type LucideIcon,
} from 'lucide-react'
import { Tool as ToolBox, ToolContent, ToolHeader } from '@/components/ai-elements/tool'
import { cn } from '@/lib/utils'
import { toolPartState, toolView, type ToolView } from '../../lib/elements'
import { absPath, basename, inBase, type AgentItem, type OpenOpts, type ReadsItem, type ToolItem as Tool, type ToolKind } from '../../lib/timeline'
import ViewThumb from './ViewThumb'

// Colour only where it carries meaning: changes to files in the accent, subagents and skills in the
// background-state violet, everything that only looks around stays neutral. The neutral tile turns
// surface while its row is hovered or pressed (the row itself turns chip), so it never disappears.
const NEUTRAL = 'bg-chip text-muted-foreground group-hover/row:bg-surface group-active/row:bg-surface'
const CHANGE = 'bg-accent-soft text-accent'
const DELEGATE = 'bg-state-background-soft text-state-background'
const KIND: Record<ToolKind, { icon: LucideIcon; tint: string }> = {
  read: { icon: FileText, tint: NEUTRAL },
  search: { icon: Search, tint: NEUTRAL },
  edit: { icon: FilePen, tint: CHANGE },
  write: { icon: FilePlus, tint: CHANGE },
  bash: { icon: Terminal, tint: NEUTRAL },
  web_search: { icon: Search, tint: NEUTRAL },
  web_fetch: { icon: Globe, tint: NEUTRAL },
  skill: { icon: Sparkles, tint: DELEGATE },
  agent: { icon: Bot, tint: DELEGATE },
  todo: { icon: ListTodo, tint: NEUTRAL },
  mcp: { icon: Plug, tint: NEUTRAL },
  other: { icon: Wrench, tint: NEUTRAL },
}

/** Files the viewer can show when they were edited (Edit of a .md or an image gets no card). */
const OPENABLE_EDIT = /\.(md|png|jpe?g|gif|webp)$/i
/** Images the Read tool can show; only absolute paths can get a link. */
const READ_IMAGE = /\.(png|jpe?g|gif|webp)$/i
const ABS = /^(\/|[a-zA-Z]:[\\/]|\\\\)/
const MAX_THUMBS = 4
const MAX_LINES = 200
const MAX_CHARS = 4000

/** What a call that started background work shows: running (until its task_end), then done / failed / stopped. */
type Bg = 'running' | 'done' | 'failed' | 'stopped' | 'ended'
function bgState(t: { bg?: { taskId: string; status?: string } }, ended?: (id: string) => boolean): Bg | undefined {
  if (!t.bg) return undefined
  const st = t.bg.status
  if (st === undefined) return ended?.(t.bg.taskId) ? 'ended' : 'running'
  return st === 'failed' || st === 'killed' ? 'failed' : st === 'stopped' ? 'stopped' : 'done'
}

function bgNote(bg?: Bg): ReactNode {
  return bg === 'running' ? <span className="shrink-0 text-xs font-medium text-state-background">Running in background</span>
    : bg === 'stopped' ? <span className="shrink-0 text-xs text-muted-foreground">Stopped</span>
    : bg === 'ended' ? <span className="shrink-0 text-xs text-muted-foreground">Ended</span> : undefined
}

function StateIcon({ state, bg }: { state: ToolView['state']; bg?: Bg }) {
  if (bg === 'running') return <Loader2 size={14} aria-label="running in background" className="shrink-0 animate-spin text-state-background" />
  if (bg === 'ended') return <Square size={12} aria-label="ended" className="shrink-0 fill-current text-muted-foreground" />
  if (bg === 'stopped') return <Square size={12} aria-label="stopped" className="shrink-0 fill-current text-muted-foreground" />
  switch (state) {
    case 'running': return <Loader2 size={14} aria-label="running" className="shrink-0 animate-spin text-state-working" />
    case 'done': return <Check size={14} aria-label="done" className="shrink-0 text-success" />
    case 'error': return <X size={14} aria-label="failed" className="shrink-0 text-danger" />
    case 'denied': return <Ban size={14} aria-label="denied" className="shrink-0 text-warning" />
  }
}

function clip(s: string): string {
  return s.length > MAX_CHARS ? s.slice(0, MAX_CHARS) + '\n[truncated]' : s
}

function Pre({ children }: { children: ReactNode }) {
  return <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-muted-foreground">{children}</pre>
}

const split = (s: string): string[] => (s ? s.replace(/\n$/, '').split('\n') : [])

/** Removed and added lines of one replacement, without the shared leading/trailing lines. */
function hunk(a: string, b: string): { sign: '-' | '+'; text: string }[] {
  const x = split(a)
  const y = split(b)
  let s = 0
  while (s < x.length && s < y.length && x[s] === y[s]) s++
  let e = 0
  while (e < x.length - s && e < y.length - s && x[x.length - 1 - e] === y[y.length - 1 - e]) e++
  return [
    ...x.slice(s, x.length - e).map((text) => ({ sign: '-' as const, text })),
    ...y.slice(s, y.length - e).map((text) => ({ sign: '+' as const, text })),
  ]
}

function Diff({ input }: { input: any }) {
  const i = input && typeof input === 'object' ? input : {}
  const pairs: [string, string][] = Array.isArray(i.edits)
    ? i.edits.map((e: any) => [String(e?.old_string ?? ''), String(e?.new_string ?? '')])
    : typeof i.new_source === 'string' ? [['', i.new_source]]
    : [[String(i.old_string ?? ''), String(i.new_string ?? '')]]
  const rows = pairs.flatMap(([a, b], k) => [...(k ? [null] : []), ...hunk(a, b)])
  if (!rows.some(Boolean)) return <Pre>(no changes to show)</Pre>
  const shown = rows.slice(0, MAX_LINES)
  return (
    <div className="-mx-1 max-h-72 overflow-auto font-mono text-xs leading-relaxed">
      {shown.map((r, k) => r
        ? <div key={k} className={`whitespace-pre-wrap break-words px-1 text-ink ${r.sign === '-' ? 'bg-del-soft' : 'bg-add-soft'}`}><span className={r.sign === '-' ? 'text-del' : 'text-add'}>{r.sign}</span>{` ${r.text}`}</div>
        : <div key={k} className="my-1 border-t border-line" />)}
      {rows.length > shown.length && <div className="px-1 text-muted-foreground">{rows.length - shown.length} more lines</div>}
    </div>
  )
}

function Todos({ input }: { input: any }) {
  const todos: any[] = Array.isArray(input?.todos) ? input.todos : []
  if (!todos.length) return <Pre>(empty plan)</Pre>
  return (
    <ul className="max-h-72 space-y-1 overflow-auto text-xs">
      {todos.map((t, k) => {
        const status = String(t?.status ?? 'pending')
        const done = status === 'completed'
        return (
          <li key={k} className="flex items-start gap-2">
            {done ? <CircleCheck size={14} aria-label="completed" className="mt-0.5 shrink-0 text-success" />
              : status === 'in_progress' ? <CircleDot size={14} aria-label="in progress" className="mt-0.5 shrink-0 text-state-working" />
              : <Circle size={14} aria-label="pending" className="mt-0.5 shrink-0 text-muted-foreground" />}
            <span className={done ? 'text-muted-foreground line-through' : 'text-ink'}>{String(t?.content ?? t?.activeForm ?? '')}</span>
          </li>
        )
      })}
    </ul>
  )
}

const json = (v: unknown): string => { try { return JSON.stringify(v, null, 2) ?? '' } catch { return String(v) } }

function output(t: Tool): string {
  return t.output ? clip(t.output) : t.state === 'running' ? 'Running…' : '(no output)'
}

function Label({ children }: { children: ReactNode }) {
  return <div className="mb-1 mt-2.5 text-xs font-medium text-muted-foreground first:mt-0">{children}</div>
}

function ToolDetail({ t }: { t: Tool }) {
  const i = t.input && typeof t.input === 'object' ? t.input : {}
  switch (t.kind) {
    case 'read': return <Pre>{t.file ?? t.title}</Pre>
    case 'edit': return <Diff input={t.input} />
    case 'write': return <Pre>{typeof i.content === 'string' ? clip(i.content) : output(t)}</Pre>
    case 'skill': return <Pre>{typeof i.args === 'string' && i.args ? i.args : t.input ? json(t.input) : '(no arguments)'}</Pre>
    case 'todo': return <Todos input={t.input} />
    case 'mcp': case 'other': return (
      <>
        {t.input !== undefined && <><Label>Input</Label><Pre>{clip(json(t.input))}</Pre></>}
        <Label>Output</Label><Pre>{output(t)}</Pre>
      </>
    )
    default: return (
      <>
        {t.detail && <div className="mb-1 truncate font-mono text-xs text-ink">{t.detail}</div>}
        <Pre>{output(t)}</Pre>
      </>
    )
  }
}

/** The images successfully read by these tools, once each, in order. */
function readImages(tools: Tool[]): string[] {
  const out = new Set<string>()
  for (const t of tools) if (t.kind === 'read' && t.state === 'ok' && t.file && ABS.test(t.file) && READ_IMAGE.test(t.file)) out.add(t.file)
  return [...out]
}

/**
 * 64 px thumbnails of the images a Read row read (at most 4, then a +N tile that opens the row),
 * shown while it is collapsed; a tap on a thumbnail opens the Viewer.
 */
function ReadThumbs({ files, machine, sessionId, onOpenFile, onMore }: {
  files: string[]; machine: string; sessionId: string; onOpenFile?: (path: string, o?: OpenOpts) => void; onMore: () => void
}) {
  if (!files.length || !machine || !sessionId) return null
  const more = files.length - MAX_THUMBS
  return (
    <div className="mb-2 ml-[2.4rem] flex flex-wrap gap-2">
      {files.slice(0, MAX_THUMBS).map((f) => (
        <ViewThumb key={f} machine={machine} sessionId={sessionId} path={f} mode="read" label={basename(f)}
          onOpen={onOpenFile ? () => onOpenFile(f, { read: true }) : undefined} />
      ))}
      {more > 0 && (
        <button type="button" aria-label={`Show ${more} more images`} onClick={onMore}
          className="press flex size-16 shrink-0 items-center justify-center rounded-lg border border-line bg-chip text-xs text-muted-foreground hover:text-ink">{`+${more}`}</button>
      )}
    </div>
  )
}

/** A collapsed row on the vendored Tool (Radix Collapsible); the header toggles the detail. */
function Row({ name, view, tint, Icon, right, nested, below, bg, children }: {
  bg?: Bg
  name: string; view: ToolView; tint: string; Icon: LucideIcon; right?: ReactNode; nested?: boolean
  /** shown under the header whether or not the row is open; `expand` opens the row */
  below?: (expand: () => void) => ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <ToolBox open={open} onOpenChange={setOpen} className={cn('my-1 rounded-xl border border-line bg-surface', nested && 'ml-5')}>
      <ToolHeader
        type="dynamic-tool" toolName={name} title={view.title} state={toolPartState(view.state)}
        className="group/row min-h-11 gap-2.5 rounded-xl px-2 py-0 text-left text-muted-foreground transition-colors duration-100 hover:bg-chip active:bg-chip"
        icon={<span className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md transition-colors duration-100 ${tint}`}><Icon size={13} aria-hidden /></span>}
        meta={right}
        status={<StateIcon state={view.state} bg={bg} />}
      />
      {below?.(() => setOpen(true))}
      <ToolContent className="mx-2 mb-2 space-y-0 rounded-lg bg-chip p-2.5 text-ink">{children}</ToolContent>
    </ToolBox>
  )
}

/**
 * One timeline action as a short, collapsed row; tapping it shows the detail for its kind.
 * Handles single tools, merged reads and subagents.
 */
export default function ToolItem({ item, live, base = '', machine = '', sessionId = '', onOpenFile, bgEnded }: {
  item: Tool | ReadsItem | AgentItem
  /** the task left the session's live items without a task_end */
  bgEnded?: (taskId: string) => boolean
  /** streamed text of a running subagent */
  live?: string
  /** session base: decides whether an edited file can be opened */
  base?: string
  /** the session's machine and id: read-image thumbnails ask the hub for links with them */
  machine?: string
  sessionId?: string
  onOpenFile?: (path: string, o?: OpenOpts) => void
}) {
  if (item.t === 'agent') {
    const bg = bgState(item, bgEnded)
    const running = item.status === 'running' && (!bg || bg === 'running')
    const view: ToolView = { title: item.description || 'Subagent', icon: 'agent', state: running ? 'running' : /error|fail/i.test(item.status) ? 'error' : 'done' }
    return (
      <Row name="Agent" view={view} Icon={Bot} tint={KIND.agent.tint} bg={running ? undefined : bg}
        right={bgNote(running && !!item.bg ? 'running' : bg) ?? (item.type ? <span className="min-w-0 max-w-[35%] shrink truncate text-[13px] text-muted-foreground">{item.type}</span> : undefined)}>
        <Pre>{clip(item.answer || live || (running ? 'Working…' : '(no answer)'))}</Pre>
      </Row>
    )
  }
  const view = toolView(item)
  const bg = item.t === 'tool' ? bgState(item, bgEnded) : undefined
  if (bg === 'failed') view.state = 'error'
  const k = KIND[view.icon]
  const thumbs = (tools: Tool[]) => (expand: () => void) => <ReadThumbs files={readImages(tools)} machine={machine} sessionId={sessionId} onOpenFile={onOpenFile} onMore={expand} />
  if (item.t === 'reads') {
    return (
      <Row name="Read" view={view} Icon={k.icon} tint={k.tint} nested={!!item.agent} below={thumbs(item.tools)}>
        <Pre>{clip(item.files.join('\n'))}</Pre>
      </Row>
    )
  }
  const canOpen = item.kind === 'edit' && item.state === 'ok' && !!item.file && OPENABLE_EDIT.test(item.file) && inBase(item.file, base)
  // same text as view.meta, coloured per side
  const diff = item.diff && (
    <span className="shrink-0 font-mono text-xs">
      <span className="text-add">+{item.diff.add}</span> <span className="text-del">{'\u2212'}{item.diff.del}</span>
    </span>
  )
  return (
    <Row name={item.name} view={view} Icon={k.icon} tint={k.tint} right={bgNote(bg) ?? diff} bg={bg} nested={!!item.agent} below={item.kind === 'read' ? thumbs([item]) : undefined}>
      <ToolDetail t={item} />
      {canOpen && (
        <button type="button" onClick={() => onOpenFile?.(absPath(item.file!, base))}
          className="mt-2 flex min-h-11 items-center gap-1.5 rounded-lg px-1 text-sm font-medium text-accent hover:underline">
          <ExternalLink size={14} aria-hidden />Open
        </button>
      )}
    </Row>
  )
}
