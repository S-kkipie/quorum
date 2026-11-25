import { useEffect, useRef, useState } from 'react'
import { getBriefing, visitProject, type Briefing as Data } from '../../lib/api'
import { emptyBriefing } from '../../lib/briefing'
import WhereLeftOff from './WhereLeftOff'
import NewSince from './NewSince'
import MyTickets from './MyTickets'
import Meetings, { meetingCount } from './Meetings'
import PinnedNotes from './PinnedNotes'

const arr = <T,>(x: T[] | null | undefined): T[] => (Array.isArray(x) ? x : [])

/** Fills in what an older or partial answer leaves out, so the sections can rely on every list. */
export function normalizeBriefing(x: Partial<Data> | null | undefined): Data {
  const e = emptyBriefing()
  if (!x || typeof x !== 'object') return e
  const m = x.meetings ?? e.meetings
  return {
    whereLeftOff: x.whereLeftOff?.text ? x.whereLeftOff : null,
    newSince: arr(x.newSince), myTickets: arr(x.myTickets), pinned: arr(x.pinned), sessions: arr(x.sessions),
    meetings: { decisions: arr(m.decisions), openPoints: arr(m.openPoints), actions: arr(m.actions) },
    seenAt: x.seenAt ?? 0, prevSeenAt: x.prevSeenAt ?? 0,
  }
}

/** The project's briefing, refetched whenever `rev` changes (project_briefing_changed); the last answer stays shown meanwhile. */
export function useBriefing(projectId: string, rev: number) {
  const [b, setB] = useState<Data | null>(null)
  const [error, setError] = useState('')
  const seq = useRef(0)
  useEffect(() => {
    const n = ++seq.current
    getBriefing(projectId)
      .then((x) => { if (n === seq.current) { setB(normalizeBriefing(x)); setError('') } })
      .catch((e) => { if (n === seq.current) setError(e instanceof Error ? e.message : 'error') })
  }, [projectId, rev])
  // a response that arrives after unmount or a project switch is dropped
  useEffect(() => () => { seq.current++ }, [projectId])
  return { b, error, setB }
}

/**
 * Records the visit once the page has been visible for `delay` ms in a row (document.visibilityState),
 * once per mount: re-renders and refetches never post it again.
 */
export function useVisit(projectId: string, delay = 5000) {
  useEffect(() => {
    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = () => {
      clearTimeout(timer)
      timer = undefined
      if (done || document.visibilityState !== 'visible') return
      timer = setTimeout(() => {
        done = true
        document.removeEventListener('visibilitychange', arm)
        visitProject(projectId).catch(() => { /* best effort: the next open records it */ })
      }, delay)
    }
    document.addEventListener('visibilitychange', arm)
    arm()
    return () => {
      done = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', arm)
    }
  }, [projectId, delay])
}

const row = 'grid min-w-0 grid-cols-1 items-start gap-3'

/**
 * The project briefing at the top of the project page, in the mockup's order. Two columns once the page
 * itself is 900 px wide (container query), one below. Empty sections are hidden.
 */
export default function Briefing({ b, projectId, hasSource, hasPerson = true, pinOpen = false, onBriefing, onOpenSession, onEditSource }: {
  b: Data
  projectId: string
  /** The project has a ticket source; without one a hint links to its settings. */
  hasSource: boolean
  /** The ticket source says who "you" are (setting person); without it a hint replaces "Your tickets". */
  hasPerson?: boolean
  /** The Pin a note menu item was used: the pinned card shows even with no notes. */
  pinOpen?: boolean
  /** Applies a local change (a pinned note added or removed) to the shown briefing. */
  onBriefing: (update: (b: Data) => Data) => void
  onOpenSession?: (id: string) => void
  onEditSource?: () => void
}) {
  const left = !!b.whereLeftOff || b.newSince.length > 0
  const right = b.myTickets.length > 0
  const meetings = meetingCount(b.meetings) > 0
  const pinned = b.pinned.length > 0 || pinOpen
  const noPerson = hasSource && !hasPerson
  if (!left && !right && !meetings && !pinned && hasSource && !noPerson) return null
  const hint = (text: string) => onEditSource
    ? <button type="button" onClick={onEditSource} className="min-h-11 text-left text-sm text-accent hover:underline">{text}</button>
    : <p className="text-sm text-muted-foreground">{text}</p>
  return (
    <div className="@container min-w-0 px-3 pt-3">
      {!hasSource && hint('Connect a ticket source to see your tickets here')}
      {noPerson && hint('Set “You are” in the ticket source to see your tickets')}
      {(left || right) && (
        <div data-briefing-row className={`${row} ${left && right ? '@min-[900px]:grid-cols-2' : ''} ${hasSource && !noPerson ? '' : 'mt-2'}`}>
          {left && (
            <div className="flex min-w-0 flex-col gap-3">
              {b.whereLeftOff && <WhereLeftOff w={b.whereLeftOff} />}
              {b.newSince.length > 0 && <NewSince items={b.newSince} prevSeenAt={b.prevSeenAt} onOpenSession={onOpenSession} />}
            </div>
          )}
          {right && <MyTickets tickets={b.myTickets} />}
        </div>
      )}
      {(meetings || pinned) && (
        <div data-briefing-row className={`${row} mt-3 ${meetings && pinned ? '@min-[900px]:grid-cols-2' : ''}`}>
          {meetings && <Meetings m={b.meetings} />}
          {pinned && <PinnedNotes projectId={projectId} notes={b.pinned} autoFocus={pinOpen && b.pinned.length === 0} onChange={(f) => onBriefing((x) => ({ ...x, pinned: f(x.pinned) }))} />}
        </div>
      )}
    </div>
  )
}
