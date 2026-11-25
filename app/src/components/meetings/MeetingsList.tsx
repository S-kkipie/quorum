import { useEffect, useRef, useState } from 'react'
import { listMeetings, type MeetingQuery } from '../../lib/meetingsApi'
import type { MeetingLive } from '../../lib/store'
import type { Meeting } from '../../proto.gen'
import { date, duration, liveStatus, meetingTitle, statusText, statusTone } from './util'

/** Meetings of a project (or the unassigned inbox), refetched on every meeting_changed that is not only progress. */
export function useMeetings(q: MeetingQuery, rev: number | string) {
  const [list, setList] = useState<Meeting[] | null>(null)
  const [error, setError] = useState('')
  const seq = useRef(0)
  const { projectId, unassigned } = q
  useEffect(() => {
    const n = ++seq.current
    listMeetings({ projectId, unassigned })
      .then((x) => { if (n === seq.current) { setList(Array.isArray(x) ? x : []); setError('') } })
      .catch((e) => { if (n === seq.current) setError(e instanceof Error ? e.message : 'error') })
  }, [projectId, unassigned, rev])
  useEffect(() => () => { seq.current++ }, [])
  return { list, error }
}

/** Rows with title, date, duration and status (with the live progress); a tap opens the meeting page. */
export default function MeetingsList({ list, live, onOpen, empty }: { list: Meeting[]; live: Record<string, MeetingLive>; onOpen: (id: string) => void; empty: string }) {
  if (!list.length) return <p className="text-xs text-muted-foreground">{empty}</p>
  return (
    <ul className="divide-y divide-line">
      {list.map((m) => {
        const st = liveStatus(m, live[m.id])
        const meta = [date(m.startedAt || m.createdAt), duration(m.durationS)].filter(Boolean).join(' · ')
        return (
          <li key={m.id}>
            <button type="button" onClick={() => onOpen(m.id)} className="flex min-h-11 w-full min-w-0 items-center gap-2 py-1.5 text-left hover:bg-chip focus-visible:outline-2 focus-visible:outline-accent">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-ink">{meetingTitle(m)}</span>
                {meta && <span className="block truncate text-xs text-muted-foreground">{meta}</span>}
              </span>
              {st.status !== 'ready' && <span className={`shrink-0 text-xs ${statusTone(st.status)}`}>{statusText(st.status, st.progress)}</span>}
            </button>
          </li>
        )
      })}
    </ul>
  )
}
