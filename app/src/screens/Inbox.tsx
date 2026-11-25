import { useState } from 'react'
import SessionCloseMenu from '../components/SessionCloseMenu'
import PhoneHeader from '../components/shell/PhoneHeader'
import { stateStyle } from '../lib/projects'
import { displayState } from '../lib/sessions'
import { inboxJobs, inboxSections, loadInboxJob, saveInboxJob } from '../lib/inbox'
import type { AppState } from '../lib/store'
import { sessionTitle } from '../lib/title'
import { useWakeClock } from '../lib/useWakeClock'
import type { SessionInfo } from '../proto.gen'
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area'

/** The phone home: sessions grouped by state (ATTENTION order), filtered by job with chips. */
export default function Inbox({ state, connected, onOpen, onLaunch }: { state: AppState; connected: boolean; onOpen: (id: string) => void; onLaunch: () => void }) {
  const [stored, setStored] = useState(loadInboxJob)
  const jobs = inboxJobs(state)
  // a job that no longer exists reads as "All" (the stored choice is kept)
  const job = jobs.some((j) => j.id === stored) ? stored : ''
  const choose = (id: string) => { setStored(id); saveInboxJob(id) }
  const now = useWakeClock(Object.values(state.sessions))
  const sections = inboxSections(state, job, now)
  // a machine the hub does not know (yet) reads as offline, as do known ones that are down
  const offline = (m: string) => !state.machines[m]?.online
  const noMachines = Object.keys(state.machines).length === 0 && Object.values(state.sessions).every((x) => !x.machine)
  const chip = (id: string, label: string) => (
    <button key={id || 'all'} type="button" aria-pressed={job === id} onClick={() => choose(id)} title={label}
      className={`min-h-11 max-w-[14rem] shrink-0 truncate rounded-full border px-4 text-sm ${job === id ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted-foreground hover:text-ink'}`}>{label}</button>
  )
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PhoneHeader title="Sessions" connected={connected} onLaunch={onLaunch} />
      <ScrollArea className="min-h-0 flex-1">
        {jobs.length > 0 && <ScrollArea className="w-full whitespace-nowrap"><div role="group" aria-label="Filter by job" className="flex gap-2 px-3 py-2">{chip('', 'All')}{jobs.map((j) => chip(j.id, j.name))}</div><ScrollBar orientation="horizontal" /></ScrollArea>}
        {sections.length === 0 && (noMachines
          ? <p className="p-6 text-center text-sm text-muted-foreground">No machines yet. Connect a daemon to the hub.</p>
          : <p className="p-6 text-center text-sm text-muted-foreground">No sessions{job ? ' in this job' : ''}.</p>)}
        {sections.map((sec) => (
          <section key={sec.key} aria-label={sec.label} className="mt-2 min-w-0">
            <h2 className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground">{sec.label}</h2>
            <ul className="divide-y divide-line border-y border-line">
              {sec.rows.map(({ session: s, project, reason }) => <InboxRow key={s.id} s={s} project={project} reason={reason} offline={offline(s.machine)} onOpen={onOpen} />)}
            </ul>
          </section>
        ))}
      </ScrollArea>
    </div>
  )
}

function InboxRow({ s, project, reason, offline, onOpen }: { s: SessionInfo; project: string; reason: string; offline: boolean; onOpen: (id: string) => void }) {
  const [error, setError] = useState('')
  const display = displayState(s)
  const st = stateStyle(display)
  return (
    <li className="min-w-0">
      <div className="flex min-w-0 items-center">
        <button type="button" onClick={() => onOpen(s.id)} className="flex min-h-14 min-w-0 flex-1 items-center gap-3 px-3 py-1.5 text-left hover:bg-chip active:bg-chip">
          <span role="img" aria-label={display === 'done' ? 'Unread' : st.label} className={`h-2.5 w-2.5 shrink-0 rounded-full ${st.dot}`} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{sessionTitle(s).title}</span>
            {/* the reason first so a narrow row never truncates it away; an offline machine says so */}
            <span className="block truncate text-xs text-muted-foreground">{[reason, project, s.machine, offline ? 'offline' : ''].filter(Boolean).join(' · ')}</span>
          </span>
        </button>
        {s.role !== 'service' && <SessionCloseMenu id={s.id} onError={setError} />}
      </div>
      {error && <p role="alert" className="px-3 pb-1 text-xs text-danger">{error}</p>}
    </li>
  )
}
