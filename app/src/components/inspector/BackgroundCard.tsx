import { lazy, useEffect, useMemo, useState } from 'react'
import { BackgroundContent, hasBackground } from '../BackgroundSheet'
import LazyBoundary from '../LazyBoundary'
import InspectorCard from './InspectorCard'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ago, hhmm, kindIcon } from '../../lib/background'
import { endedTasksOf } from '../../lib/endedTasks'
import { factLine, getTaskOutput, isDead, type TaskFacts } from '../../lib/taskOutput'
import type { BackgroundInfo, BackgroundItem, Event, TaskEnd } from '../../proto.gen'

const TaskOutputView = lazy(() => import('./TaskOutputView'))

const FACTS_MS = 10_000
/** Only commands and monitors have an output file on the machine. */
const hasOutput = (k: string) => k === 'command' || k === 'monitor'

/** What the output view shows: a live task (polled) or an ended one (its saved tail). */
type Viewing = { id: string; title: string; ended?: TaskEnd }

/**
 * The session's background work: running items first (with the machine's facts about commands and
 * monitors, refreshed every 10 s while this card is mounted, that is while the inspector is open),
 * then the tasks that ended. A command, monitor or ended task opens its output; a subagent opens its screen.
 */
export default function BackgroundCard({ background, sessionId = '', sessionState = '', events = [], onOpenAgent, phone = false }: {
  background?: BackgroundInfo
  sessionId?: string
  sessionState?: string
  events?: Event[]
  onOpenAgent?: (id: string) => void
  phone?: boolean
}) {
  const ended = useMemo(() => endedTasksOf(events), [events])
  // an item whose end is already in the history is not listed twice (the live list lags)
  const endedIds = useMemo(() => new Set(ended.map((t) => t.taskId)), [ended])
  const rawItems = background?.items
  const items = useMemo(() => rawItems?.filter((i) => !endedIds.has(i.id)), [rawItems, endedIds])
  const closed = sessionState === 'closed'
  const [now, setNow] = useState(Date.now)
  const [facts, setFacts] = useState<Record<string, TaskFacts>>({})
  const [viewing, setViewing] = useState<Viewing | null>(null)
  const watched = (items ?? []).filter((i) => hasOutput(i.kind)).map((i) => i.id).join('\u0000')

  // keeps "started X ago" and next wake current
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (!sessionId || !watched || closed) return
    const ids = watched.split('\u0000')
    let stop = false
    const poll = () => {
      for (const id of ids) {
        getTaskOutput(sessionId, id).then((f) => { if (!stop) { setFacts((m) => ({ ...m, [id]: f })); setNow(Date.now()) } }, () => {})
      }
    }
    poll()
    const t = setInterval(poll, FACTS_MS)
    return () => { stop = true; clearInterval(t) }
  }, [sessionId, watched, closed])

  if (!hasBackground(background) && !ended.length) return null
  if (rawItems === undefined && !ended.length) return <InspectorCard title="Background"><BackgroundContent background={background} /></InspectorCard>

  const row = 'flex min-h-11 w-full items-start gap-2.5 rounded-xl bg-chip p-2.5 text-left'
  const body = (it: BackgroundItem) => {
    const f = facts[it.id]
    const dead = isDead(it, f, sessionState)
    const sub = f && !closed ? factLine(f, now) : `started ${ago(it.startedAt, now)}`
    const Icon = kindIcon(it.kind)
    return (
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
  }
  const open = (it: BackgroundItem) =>
    it.kind === 'subagent' ? () => onOpenAgent?.(it.id) : hasOutput(it.kind) ? () => setViewing({ id: it.id, title: it.label || `Background ${it.kind}` }) : undefined

  return (
    <InspectorCard title="Background">
      <ScrollArea className="max-h-80" viewportClassName="max-h-80">
        <div className="flex flex-col gap-1 px-3 pb-2">
          {!!items?.length && (
            <ul className="flex flex-col gap-1">
              {items.map((it) => {
                const go = open(it)
                return (
                  <li key={it.id}>
                    {go ? <button type="button" onClick={go} className={`${row} press`}>{body(it)}</button> : <div className={row}>{body(it)}</div>}
                  </li>
                )
              })}
            </ul>
          )}
          {!items?.length && <p className="px-1 py-2 text-center text-sm text-muted-foreground">Nothing is running in the background.</p>}
          {ended.length > 0 && (
            <>
              <h4 className="px-1 pt-2 text-xs font-medium text-muted-foreground">Ended</h4>
              <ul className="flex flex-col gap-1">
                {ended.map((t) => {
                  const Icon = kindIcon(t.kind)
                  return (
                    <li key={t.taskId}>
                      <button type="button" onClick={() => setViewing({ id: t.taskId, title: t.summary || t.taskId, ended: t })} className={`${row} press`}>
                        <span className="mt-0.5 flex size-[22px] shrink-0 items-center justify-center rounded-md bg-chip text-muted-foreground"><Icon size={13} role="img" aria-label={t.kind} /></span>
                        <span className="block min-w-0 flex-1 text-sm">
                          <span title={t.summary} className="line-clamp-2 block text-ink [overflow-wrap:anywhere]">{t.summary || `Background ${t.kind}`}</span>
                          <span className="block text-xs text-muted-foreground">{t.exitCode === undefined ? t.status : `${t.status} · exit ${t.exitCode}`}</span>
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </div>
      </ScrollArea>
      {viewing && (
        <LazyBoundary>
          <TaskOutputView sessionId={sessionId} task={viewing.id} title={viewing.title} ended={viewing.ended} phone={phone} onClose={() => setViewing(null)} />
        </LazyBoundary>
      )}
    </InspectorCard>
  )
}
