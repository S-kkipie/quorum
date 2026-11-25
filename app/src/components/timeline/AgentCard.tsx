import { useEffect, useId, useState } from 'react'
import { Bot, Check, ChevronDown, ChevronRight, Loader2, MessageCircleQuestion, Square, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatTokens } from '../../lib/meters'
import type { AgentItem } from '../../lib/timeline'
import { bgState } from './ToolItem'

/** What a subagent's card shows: working, working in the background, or how it ended. */
export type AgentPhase = 'running' | 'asking' | 'background' | 'done' | 'failed' | 'stopped' | 'ended'

/** `asking`: an ask of the session waits on this subagent (or one of its own). */
export function agentPhase(a: AgentItem, bgEnded?: (taskId: string) => boolean, asking = false): AgentPhase {
  if (a.status !== 'running') return /error|fail/i.test(a.status) ? 'failed' : a.status === 'killed' ? 'stopped' : 'done'
  const bg = bgState(a, bgEnded)
  if (asking && (!bg || bg === 'running')) return 'asking'
  switch (bg) {
    case 'running': return 'background'
    case 'ended': return 'ended'
    case 'done': return 'done'
    case 'failed': return 'failed'
    case 'stopped': return 'stopped'
  }
  return 'running'
}

export const PHASE_LABEL: Record<AgentPhase, string> = {
  running: 'Working', asking: 'Needs your answer', background: 'Running in background', done: 'Done', failed: 'Failed', stopped: 'Stopped', ended: 'Ended',
}

export const live = (p: AgentPhase) => p === 'running' || p === 'asking' || p === 'background'

/** Elapsed time, short: 42s, 3m 05s, 1h 02m. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** "Now", re-read every second while `active` (a running clock is shown); no timer otherwise. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return now
}

/** The clock of a subagent: from its start to its end, or to now while it works. */
export function agentClock(a: AgentItem, phase: AgentPhase, now: number): string | undefined {
  if (!a.startedAt) return undefined
  const to = a.endedAt ?? (live(phase) ? now : undefined)
  return to === undefined ? undefined : elapsed(to - a.startedAt)
}

export const steps = (n = 0) => `${n} ${n === 1 ? 'step' : 'steps'}`

export function PhaseIcon({ phase, className }: { phase: AgentPhase; className?: string }) {
  switch (phase) {
    case 'running': return <span role="img" aria-label="running" className={cn('mx-[3px] size-2 shrink-0 animate-pulse rounded-full bg-state-background motion-reduce:animate-none', className)} />
    case 'asking': return <MessageCircleQuestion size={14} aria-label="needs your answer" className={cn('shrink-0 text-state-needs', className)} />
    case 'background': return <Loader2 size={14} aria-label="running in background" className={cn('shrink-0 animate-spin text-state-background motion-reduce:animate-none', className)} />
    case 'done': return <Check size={14} aria-label="done" className={cn('shrink-0 text-success', className)} />
    case 'failed': return <X size={14} aria-label="failed" className={cn('shrink-0 text-danger', className)} />
    default: return <Square size={12} aria-label={phase} className={cn('shrink-0 fill-current text-muted-foreground', className)} />
  }
}

function Tile({ busy }: { busy?: boolean }) {
  return (
    <span className="relative flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md bg-state-background-soft text-state-background">
      <Bot size={13} aria-hidden />
      {busy && <span aria-hidden className="absolute -right-0.5 -top-0.5 size-2 animate-pulse rounded-full bg-state-background motion-reduce:animate-none" />}
    </span>
  )
}

/** One subagent: a 44 px row that opens its own screen. */
function AgentLine({ a, phase, now, tile, onOpen }: { a: AgentItem; phase: AgentPhase; now: number; tile?: boolean; onOpen: (id: string) => void }) {
  const clock = agentClock(a, phase, now)
  return (
    <button type="button" onClick={() => onOpen(a.key)} data-testid="agent-line"
      className="group/row flex min-h-11 w-full min-w-0 items-center gap-2.5 px-2 py-1.5 text-left transition-colors duration-100 hover:bg-chip active:bg-chip">
      {tile ? <Tile /> : <span className="flex w-[22px] shrink-0 justify-center"><PhaseIcon phase={phase} /></span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-ink">{a.description || 'Subagent'}</span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          {a.type && <span className="max-w-[40%] truncate text-state-background">{a.type}</span>}
          <span className={phase === 'asking' ? 'font-medium text-state-needs' : undefined}>{PHASE_LABEL[phase]}</span>
          {(!!a.steps || live(phase)) && <span>{steps(a.steps)}</span>}
          {clock && <span className="tabular-nums">{clock}</span>}
          {!!a.tokens && <span>{`${formatTokens(a.tokens)} tok`}</span>}
        </span>
        {live(phase) && a.lastTool && <span className="block truncate font-mono text-xs text-muted-foreground">{a.lastTool}</span>}
      </span>
      {tile && <PhaseIcon phase={phase} />}
      <ChevronRight size={16} aria-hidden className="shrink-0 text-muted-foreground" />
    </button>
  )
}

/** Rows a group shows before "Show all". */
const FIRST = 5

/**
 * A subagent in the main transcript, or several launched together: one card, one line each with its
 * state, steps and clock. A line opens the subagent's own screen; its work never shows here.
 */
export default function AgentCard({ agents, bgEnded, asking, onOpen }: {
  agents: AgentItem[]
  bgEnded?: (taskId: string) => boolean
  /** keys of the subagents an ask waits on */
  asking?: ReadonlySet<string>
  /** opens a subagent by its stable key */
  onOpen: (key: string) => void
}) {
  const [open, setOpen] = useState(true)
  const [all, setAll] = useState(false)
  const listId = useId()
  const rows = agents.map((a) => ({ a, phase: agentPhase(a, bgEnded, asking?.has(a.key)) }))
  const now = useNow(rows.some((r) => live(r.phase) && !!r.a.startedAt))
  if (rows.length === 1) {
    const { a, phase } = rows[0]
    return (
      <div data-testid="agent-card" className="my-1 overflow-hidden rounded-xl border border-line bg-surface">
        <AgentLine a={a} phase={phase} now={now} tile onOpen={onOpen} />
      </div>
    )
  }
  const working = rows.filter((r) => live(r.phase) && r.phase !== 'asking').length
  const done = rows.filter((r) => r.phase === 'done').length
  const failed = rows.filter((r) => r.phase === 'failed').length
  const tokens = agents.reduce((s, a) => s + (a.tokens ?? 0), 0)
  const shown = all ? rows : rows.slice(0, FIRST)
  const waiting = rows.filter((r) => r.phase === 'asking').length
  const summary = [waiting ? `${waiting} need your answer` : '', working ? `${working} running` : '', `${done} done`, failed ? `${failed} failed` : '', tokens ? `${formatTokens(tokens)} tok` : ''].filter(Boolean).join(' · ')
  return (
    <div data-testid="agent-group" className="my-1 overflow-hidden rounded-xl border border-line bg-surface">
      <button type="button" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((o) => !o)}
        className="flex min-h-11 w-full min-w-0 items-center gap-2.5 px-2 py-1.5 text-left transition-colors duration-100 hover:bg-chip active:bg-chip">
        <Tile busy={working > 0} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-ink">{`${agents.length} subagents`}</span>
          <span className="block truncate text-xs text-muted-foreground">{summary}</span>
        </span>
        <ChevronDown size={16} aria-hidden className={cn('shrink-0 text-muted-foreground transition-transform duration-150', !open && '-rotate-90')} />
      </button>
      <div aria-hidden className="mx-2 mb-2 flex h-1 overflow-hidden rounded-full bg-chip">
        <div className="h-full bg-success transition-[width] duration-300" style={{ width: `${(done / agents.length) * 100}%` }} />
        <div className="h-full bg-danger transition-[width] duration-300" style={{ width: `${(failed / agents.length) * 100}%` }} />
      </div>
      {open && (
        <div id={listId} className="border-t border-line">
          {shown.map(({ a, phase }) => <AgentLine key={a.seq} a={a} phase={phase} now={now} onOpen={onOpen} />)}
          {rows.length > FIRST && (
            <button type="button" onClick={() => setAll((v) => !v)} className="min-h-11 w-full text-sm text-state-background hover:underline">
              {all ? 'Show fewer' : `Show all ${rows.length}`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
