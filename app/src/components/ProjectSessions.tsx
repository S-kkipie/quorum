import { useEffect, useRef, useState } from 'react'
import { listConversations } from '../lib/api'
import { projectCheckouts, projectSessions } from '../lib/projects'
import { mergeSessions, type SessionRow } from '../lib/sessions'
import type { AppState } from '../lib/store'
import { sessionTitle } from '../lib/title'
import type { Conversation } from '../proto.gen'
import SessionRowView from './SessionRow'

const SHOWN = 8
const PAGE = 100
type Closed = Extract<SessionRow, { kind: 'closed' }>

/** The project's sessions: live ones first, then the previous conversations of every online checkout. */
export default function ProjectSessions({ state, projectId, busy = false, onOpen, onResume, onConversations }: {
  state: AppState
  projectId: string
  /** A launch is in progress: closed rows cannot be resumed. */
  busy?: boolean
  onOpen: (id: string) => void
  onResume: (row: Closed) => Promise<unknown> | void
  onConversations: (machine: string, root: string, list: Conversation[]) => void
}) {
  const checkouts = projectCheckouts(state, projectId)
  const online = checkouts.filter((c) => state.machines[c.machine]?.online)
  const fetchable = online.filter((c) => !!state.machines[c.machine]?.caps)
  const outdated = [...new Set(online.filter((c) => !state.machines[c.machine]?.caps).map((c) => c.machine))]
  const [errors, setErrors] = useState<Record<string, true>>({})
  const [settled, setSettled] = useState(false)
  const [resumeError, setResumeError] = useState('')
  const [all, setAll] = useState(false)
  const [q, setQ] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const cb = useRef(onConversations)
  cb.current = onConversations

  const key = fetchable.map((c) => c.machine + '\u0000' + c.root).join('\n')
  useEffect(() => {
    let off = false
    setSettled(false)
    setErrors({})
    const targets = key ? key.split('\n').map((k) => k.split('\u0000') as [string, string]) : []
    Promise.all(targets.map(([machine, root]) =>
      listConversations(machine, root)
        .then((l) => { if (!off) cb.current(machine, root, l ?? []) })
        .catch(() => { if (!off) setErrors((e) => ({ ...e, [machine]: true })) })))
      .then(() => { if (!off) setSettled(true) })
    return () => { off = true }
  }, [key])

  const live = projectSessions(state, projectId)
  const lists = checkouts.map((c) => ({ machine: c.machine, root: c.root, list: state.conversations[c.machine + '\u0000' + c.root] ?? [] }))
  const closedSessions = state.order.map((id) => state.sessions[id]).filter((x) => x && x.projectId === projectId && x.role !== 'service' && x.state === 'closed')
  const rows = mergeSessions(live, lists, closedSessions)
  const closedCount = rows.filter((r) => r.kind === 'closed').length
  const needle = q.trim().toLowerCase()
  const title = (r: SessionRow) => (r.kind === 'live' ? sessionTitle(r.session).title : r.title)
  let shown = rows
  let left = 0
  if (all) {
    const matches = rows.filter((r) => !needle || title(r).toLowerCase().includes(needle))
    let n = 0
    shown = matches.filter((r) => r.kind === 'live' || ++n <= limit)
    left = matches.filter((r) => r.kind === 'closed').length - limit
  } else {
    let n = 0
    shown = rows.filter((r) => r.kind === 'live' || ++n <= SHOWN)
  }

  async function resume(row: Closed) {
    setResumeError('')
    try { await onResume(row) } catch (e) { setResumeError(e instanceof Error ? e.message : 'error') }
  }

  const note = 'px-3 pt-1 text-xs'
  return (
    <section>
      <h3 className="mb-1 mt-5 px-3 text-[13px] font-medium text-muted-foreground">Sessions</h3>
      {all && <input value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE) }} placeholder="Search by title" aria-label="Search by title" className="mx-3 mb-2 w-[calc(100%-1.5rem)] rounded-lg border border-line bg-surface p-2 text-sm" />}
      {shown.length > 0 && (
        <ul className="divide-y divide-line border-y border-line">
          {shown.map((r) => <SessionRowView key={r.id} row={r} disabled={busy} onOpen={onOpen} onResume={resume} />)}
        </ul>
      )}
      {all && left > 0 && <button onClick={() => setLimit((l) => l + PAGE)} className="min-h-11 px-3 text-xs text-accent">Show more ({left} left)</button>}
      {!all && closedCount > SHOWN && <button onClick={() => setAll(true)} className="min-h-11 px-3 text-xs text-accent">See all ({closedCount})</button>}
      {rows.length === 0 && settled && Object.keys(errors).length === 0 && <p className={`${note} text-muted-foreground`}>No sessions yet. Start one above.</p>}
      {rows.length === 0 && !settled && fetchable.length > 0 && <p className={`${note} text-muted-foreground`}>Loading sessions…</p>}
      {Object.keys(errors).map((m) => <p key={m} role="alert" className={`${note} text-danger`}>{m}: could not list conversations</p>)}
      {outdated.map((m) => <p key={m} className={`${note} text-muted-foreground`}>Update quorumd on {m} to see its conversations</p>)}
      {resumeError && <p role="alert" className={`${note} text-danger`}>{resumeError}</p>}
    </section>
  )
}
