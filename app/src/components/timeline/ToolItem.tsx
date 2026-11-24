import type { ReactNode } from 'react'
import {
  Ban, Bot, Check, Circle, CircleCheck, CircleDot, ExternalLink, FilePen, FilePlus, FileText, Globe,
  ListTodo, Loader2, Plug, Search, Sparkles, Terminal, Wrench, X, type LucideIcon,
} from 'lucide-react'
import { Tool as ToolBox, ToolContent, ToolHeader } from '@/components/ai-elements/tool'
import { cn } from '@/lib/utils'
import { toolPartState, toolView, type ToolView } from '../../lib/elements'
import { absPath, inBase, type AgentItem, type ReadsItem, type ToolItem as Tool, type ToolKind } from '../../lib/timeline'

const KIND: Record<ToolKind, { icon: LucideIcon; tint: string }> = {
  read: { icon: FileText, tint: 'bg-sky-500/15 text-sky-300' },
  search: { icon: Search, tint: 'bg-sky-500/15 text-sky-300' },
  edit: { icon: FilePen, tint: 'bg-amber-500/15 text-amber-300' },
  write: { icon: FilePlus, tint: 'bg-emerald-500/15 text-emerald-300' },
  bash: { icon: Terminal, tint: 'bg-zinc-500/20 text-zinc-300' },
  web_search: { icon: Search, tint: 'bg-cyan-500/15 text-cyan-300' },
  web_fetch: { icon: Globe, tint: 'bg-cyan-500/15 text-cyan-300' },
  skill: { icon: Sparkles, tint: 'bg-fuchsia-500/15 text-fuchsia-300' },
  agent: { icon: Bot, tint: 'bg-violet-500/15 text-violet-300' },
  todo: { icon: ListTodo, tint: 'bg-teal-500/15 text-teal-300' },
  mcp: { icon: Plug, tint: 'bg-indigo-500/15 text-indigo-300' },
  other: { icon: Wrench, tint: 'bg-zinc-500/20 text-zinc-300' },
}

/** Files the viewer can show when they were edited (Edit of a .md or an image gets no card). */
const OPENABLE_EDIT = /\.(md|png|jpe?g|gif|webp)$/i
const MAX_LINES = 200
const MAX_CHARS = 4000

function StateIcon({ state }: { state: ToolView['state'] }) {
  switch (state) {
    case 'running': return <Loader2 size={14} aria-label="running" className="shrink-0 animate-spin text-blue-400" />
    case 'done': return <Check size={14} aria-label="done" className="shrink-0 text-zinc-600" />
    case 'error': return <X size={14} aria-label="failed" className="shrink-0 text-red-400" />
    case 'denied': return <Ban size={14} aria-label="denied" className="shrink-0 text-amber-400" />
  }
}

function clip(s: string): string {
  return s.length > MAX_CHARS ? s.slice(0, MAX_CHARS) + '\n[truncated]' : s
}

function Pre({ children }: { children: ReactNode }) {
  return <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-zinc-400">{children}</pre>
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
    <div className="max-h-72 overflow-auto font-mono text-[11px] leading-relaxed">
      {shown.map((r, k) => r
        ? <div key={k} className={`whitespace-pre-wrap break-words px-1 ${r.sign === '-' ? 'bg-red-500/10 text-red-300' : 'bg-emerald-500/10 text-emerald-300'}`}>{`${r.sign} ${r.text}`}</div>
        : <div key={k} className="my-1 border-t border-zinc-800" />)}
      {rows.length > shown.length && <div className="px-1 text-zinc-500">{rows.length - shown.length} more lines</div>}
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
            {done ? <CircleCheck size={14} aria-label="completed" className="mt-0.5 shrink-0 text-emerald-400" />
              : status === 'in_progress' ? <CircleDot size={14} aria-label="in progress" className="mt-0.5 shrink-0 text-blue-400" />
              : <Circle size={14} aria-label="pending" className="mt-0.5 shrink-0 text-zinc-600" />}
            <span className={done ? 'text-zinc-500 line-through' : 'text-zinc-300'}>{String(t?.content ?? t?.activeForm ?? '')}</span>
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
  return <div className="mb-1 mt-2 text-[10px] font-medium uppercase tracking-wide text-zinc-600 first:mt-0">{children}</div>
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
        {t.detail && <div className="mb-1 truncate font-mono text-[11px] text-zinc-500">{t.detail}</div>}
        <Pre>{output(t)}</Pre>
      </>
    )
  }
}

/** A collapsed row on the vendored Tool (Radix Collapsible); the header toggles the detail. */
function Row({ name, view, tint, Icon, right, nested, children }: {
  name: string; view: ToolView; tint: string; Icon: LucideIcon; right?: ReactNode; nested?: boolean; children: ReactNode
}) {
  return (
    <ToolBox className={cn('my-0.5 mb-0.5 rounded-lg border-0', nested && 'ml-5')}>
      <ToolHeader
        type="dynamic-tool" toolName={name} title={view.title} state={toolPartState(view.state)}
        className="min-h-11 gap-2.5 rounded-lg px-1.5 py-0 text-left hover:bg-zinc-900 active:bg-zinc-900 text-zinc-300"
        icon={<span className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md ${tint}`}><Icon size={13} aria-hidden /></span>}
        meta={right}
        status={<StateIcon state={view.state} />}
      />
      <ToolContent className="mb-1 ml-[2.4rem] mr-1 space-y-0 rounded-lg border border-zinc-800 bg-zinc-950 p-2.5 text-zinc-300">{children}</ToolContent>
    </ToolBox>
  )
}

/**
 * One timeline action as a short, collapsed row; tapping it shows the detail for its kind.
 * Handles single tools, merged reads and subagents.
 */
export default function ToolItem({ item, live, base = '', onOpenFile }: {
  item: Tool | ReadsItem | AgentItem
  /** streamed text of a running subagent */
  live?: string
  /** session base: decides whether an edited file can be opened */
  base?: string
  onOpenFile?: (path: string) => void
}) {
  if (item.t === 'agent') {
    const running = item.status === 'running'
    const view: ToolView = { title: item.description || 'Subagent', icon: 'agent', state: running ? 'running' : /error|fail/i.test(item.status) ? 'error' : 'done' }
    return (
      <Row name="Agent" view={view} Icon={Bot} tint={KIND.agent.tint} right={item.type ? <span className="shrink-0 truncate text-[13px] text-zinc-600">{item.type}</span> : undefined}>
        <Pre>{clip(item.answer || live || (running ? 'Working…' : '(no answer)'))}</Pre>
      </Row>
    )
  }
  const view = toolView(item)
  const k = KIND[view.icon]
  if (item.t === 'reads') {
    return (
      <Row name="Read" view={view} Icon={k.icon} tint={k.tint} nested={!!item.agent}>
        <Pre>{clip(item.files.join('\n'))}</Pre>
      </Row>
    )
  }
  const canOpen = item.kind === 'edit' && item.state === 'ok' && !!item.file && OPENABLE_EDIT.test(item.file) && inBase(item.file, base)
  // same text as view.meta, coloured per side
  const diff = item.diff && (
    <span className="shrink-0 font-mono text-[11px]">
      <span className="text-emerald-400">+{item.diff.add}</span> <span className="text-red-400">{'\u2212'}{item.diff.del}</span>
    </span>
  )
  return (
    <Row name={item.name} view={view} Icon={k.icon} tint={k.tint} right={diff} nested={!!item.agent}>
      <ToolDetail t={item} />
      {canOpen && (
        <button type="button" onClick={() => onOpenFile?.(absPath(item.file!, base))}
          className="mt-2 flex min-h-11 items-center gap-1.5 rounded-lg px-1 text-sm text-blue-400 hover:text-blue-300">
          <ExternalLink size={14} aria-hidden />Open
        </button>
      )}
    </Row>
  )
}
