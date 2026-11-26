import { lazy, useEffect, useMemo, useState } from 'react'
import { Square } from 'lucide-react'
import { BackgroundContent, hasBackground } from '../BackgroundSheet'
import LazyBoundary from '../LazyBoundary'
import InspectorCard from './InspectorCard'
import { ScrollArea } from '@/components/ui/scroll-area'
import { stopBackgroundTask } from '../../lib/api'
import { ago, hhmm, kindIcon } from '../../lib/background'
import { endedTasksOf } from '../../lib/endedTasks'
import { factLine, getTaskOutput, isDead, type TaskFacts } from '../../lib/taskOutput'
import type { BackgroundInfo, BackgroundItem, Event } from '../../proto.gen'

const TaskOutputView = lazy(() => import('./TaskOutputView'))

const FACTS_MS = 10_000
/** How long a first Stop tap waits for the confirming second tap. */
const CONFIRM_MS = 3_000
/** Only commands and monitors have an output file on the machine. */
const hasOutput = (k: string) => k === 'command' || k === 'monitor'
/** What Claude Code's TaskStop can end: background commands, monitors and subagents (not loops or crons). */
const stoppable = (k: string) => hasOutput(k) || k === 'subagent'

type Viewing = { id: string; title: string }

/**
 * The session's live background work in two cards: Background tasks (commands, monitors, loops, crons,
 * with the machine's facts about commands and monitors, refreshed every 10 s while mounted, that is while
 * the inspector is open) and Background agents (subagents). Ended work is not listed. A command or monitor
 * opens its output, a subagent its screen; Stop (tapped twice) asks Claude Code to end it.
 */
export default function BackgroundCard({ background, sessionId = '', sessionState = '', events = [], onOpenAgent, phone = false }: {
  background?: BackgroundInfo
  sessionId?: string
  sessionState?: string
  events?: Event[]
  onOpenAgent?: (id: string) => void
  phone?: boolean
}) {
  // an item whose end is already in the history is not listed (the live list lags)
  const endedIds = useMemo(() => new Set(endedTasksOf(events).map((t) => t.taskId)), [events])
  const rawItems = background?.items
  const items = useMemo(() => rawItems?.filter((i) => !endedIds.has(i.id)) ?? [], [rawItems, endedIds])
  const closed = sessionState === 'closed'
  const [now, setNow] = useState(Date.now)
  const [facts, setFacts] = useState<Record<string, TaskFacts>>({})
  const [viewing, setViewing] = useState<Viewing | null>(null)
  const [confirming, setConfirming] = useState('')
  const [stopping, setStopping] = useState<Record<string, true>>({})
  const [stopError, setStopError] = useState('')
  const watched = items.filter((i) => hasOutput(i.kind)).map((i) => i.id).join('\u0000')

  // keeps "started X ago" and next wake current
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (!confirming) return
    const t = setTimeout(() => setConfirming(''), CONFIRM_MS)
    return () => clearTimeout(t)
  }, [confirming])

  useEffect(() => {
    if (!sessionId || !watched || closed) return
    const ids = watched.split('\u0000')
    let stop = false
    const poll = () => {
      for (const id of ids) {
        getTaskOutput(sessionId, id).then((f) => { if (!stop) { setFacts((m) => ({ ...m, [id]: f })); setNow(Date.now()) } }, () => {
          // never show an old reading as current
          if (!stop) setFacts((m) => { const { [id]: _gone, ...rest } = m; return rest })
        })
      }
    }
    poll()
    const t = setInterval(poll, FACTS_MS)
    return () => { stop = true; clearInterval(t) }
  }, [sessionId, watched, closed])

  if (!hasBackground(background)) return null
  if (rawItems === undefined) return <InspectorCard title="Background"><BackgroundContent background={background} /></InspectorCard>

  const stopItem = (it: BackgroundItem) => {
    if (confirming !== it.id) { setConfirming(it.id); return }
    setConfirming('')
    setStopError('')
    setStopping((m) => ({ ...m, [it.id]: true }))
    stopBackgroundTask(sessionId, it.id).catch((e: unknown) => {
      setStopping((m) => { const { [it.id]: _gone, ...rest } = m; return rest })
      setStopError(e instanceof Error ? e.message : 'Could not stop it')
    })
  }

  const row = (it: BackgroundItem) => {
    const f = facts[it.id]
    const dead = isDead(it, f, sessionState)
    const sub = stopping[it.id] ? 'stopping…' : f && !closed ? factLine(f, now) : `started ${ago(it.startedAt, now)}`
    const Icon = kindIcon(it.kind)
    const go = it.kind === 'subagent' ? () => onOpenAgent?.(it.id)
      : hasOutput(it.kind) ? () => setViewing({ id: it.id, title: it.label || `Background ${it.kind}` }) : undefined
    const inner = (
      <>
        <span className="mt-0.5 flex size-[22px] shrink-0 items-center justify-center rounded-md bg-state-background-soft text-state-background">
          <Icon size={13} role="img" aria-label={it.kind} />
        </span>
        <span className="block min-w-0 flex-1 text-sm">
          <span title={it.label} className="line-clamp-2 block text-ink [overflow-wrap:anywhere]">{it.label || `Background ${it.kind}`}</span>
          <span className="block text-xs text-muted-foreground">
            {sub}
            {!!it.nextWake && it.nextWake > now && (it.kind === 'loop' || it.kind === 'cron') && ` · next wake ${hhmm(it.nextWake)}`}
          </span>
        </span>
        {dead && <span className="shrink-0 rounded-md bg-del-soft px-1.5 py-0.5 text-xs font-medium text-danger">Dead</span>}
      </>
    )
    const main = 'flex min-h-11 min-w-0 flex-1 items-start gap-2.5 p-2.5 text-left'
    const asking = confirming === it.id
    return (
      <li key={it.id} className="flex items-stretch rounded-xl bg-chip">
        {go ? <button type="button" onClick={go} className={`${main} press rounded-xl`}>{inner}</button> : <div className={main}>{inner}</div>}
        {stoppable(it.kind) && !closed && !stopping[it.id] && (
          <button type="button" onClick={() => stopItem(it)} aria-label={asking ? 'Tap again to stop' : 'Stop'} title={asking ? 'Tap again to stop' : 'Stop'}
            className={`press flex min-h-11 shrink-0 items-center justify-center gap-1 rounded-xl px-2.5 text-xs ${asking ? 'font-medium text-danger' : 'text-muted-foreground hover:text-danger'}`}>
            <Square size={12} aria-hidden className="fill-current" />
            {asking && <span>Stop?</span>}
          </button>
        )}
      </li>
    )
  }

  const tasks = items.filter((i) => i.kind !== 'subagent')
  const agents = items.filter((i) => i.kind === 'subagent')
  const list = (xs: BackgroundItem[]) => (
    <ScrollArea className="max-h-64" viewportClassName="max-h-64">
      <ul className="flex flex-col gap-1 px-3 pb-2">{xs.map(row)}</ul>
    </ScrollArea>
  )

  return (
    <>
      {tasks.length > 0 && <InspectorCard title="Background tasks">{list(tasks)}</InspectorCard>}
      {agents.length > 0 && <InspectorCard title="Background agents">{list(agents)}</InspectorCard>}
      {stopError && <p role="alert" className="px-1 text-xs text-danger">{stopError}</p>}
      {viewing && (
        <LazyBoundary>
          <TaskOutputView sessionId={sessionId} task={viewing.id} title={viewing.title} phone={phone} onClose={() => setViewing(null)} />
        </LazyBoundary>
      )}
    </>
  )
}
