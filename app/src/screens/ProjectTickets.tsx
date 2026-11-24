import { useEffect, useState } from 'react'
import TicketRow from '../components/TicketRow'
import { confirmTicketLink, listTickets, unlinkTicket, type TicketView } from '../lib/api'
import { STATUSES, STATUS_LABEL } from '../lib/projects'
import type { AppState } from '../lib/store'
import { sessionTitle } from '../lib/title'
import { Button } from '@/components/ui/button'

const h3 = 'mb-1 mt-5 px-3 text-[13px] font-medium text-muted-foreground'

/** The project's tickets by status, plus the pending session-ticket link suggestions. */
export default function ProjectTickets({ state, id, selectedTicket, onBack, onOpenTicket, onTickets }: {
  state: AppState
  id: string
  selectedTicket?: string | null
  onBack?: () => void
  onOpenTicket?: (id: string) => void
  onTickets?: (projectId: string, views: TicketView[]) => void
}) {
  const [error, setError] = useState('')
  useEffect(() => {
    let off = false
    listTickets(id).then((v) => { if (!off) onTickets?.(id, v) }).catch((e) => { if (!off) setError(e instanceof Error ? e.message : 'error') })
    return () => { off = true }
  }, [id, onTickets])

  const p = state.projects[id]
  if (!p) return <p className="p-4 text-sm text-muted-foreground">{onBack && <Button variant="ghost" onClick={onBack} className="mr-2 min-h-11 text-muted-foreground">←</Button>}Project not found.</p>

  const tickets = state.tickets[id] ?? []
  const pendingByTicket: Record<string, number> = {}
  for (const x of Object.values(state.proposals)) if (x.status === 'pending') pendingByTicket[x.ticketId] = (pendingByTicket[x.ticketId] ?? 0) + 1
  const suggestions = tickets.flatMap((t) =>
    Object.entries(state.links[t.id] ?? {}).filter(([sid, c]) => !c && state.sessions[sid]).map(([sid]) => ({ t, s: state.sessions[sid] })))

  return (
    <div className="pb-10">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-background/90 px-3 py-2 backdrop-blur">
        {onBack && <Button variant="ghost" onClick={onBack} aria-label="Back" className="min-h-11 min-w-11 text-muted-foreground">←</Button>}
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold">{p.name} · Tickets</h2>
      </header>
      {error && <p role="alert" className="px-3 pt-2 text-xs text-danger">{error}</p>}

      {suggestions.length > 0 && (
        <section>
          <h3 className={h3}>Link suggestions</h3>
          <ul className="divide-y divide-line border-y border-line">
            {suggestions.map(({ t, s }) => <Suggestion key={t.id + s.id} ticketId={t.id} ticketLabel={`${t.externalId} ${t.title}`} sessionId={s.id} sessionLabel={sessionTitle(s).title} />)}
          </ul>
        </section>
      )}

      {tickets.length === 0 && (
        <p className="px-3 pt-6 text-sm text-muted-foreground">{p.connector?.kind === 'none' ? 'This project has no ticket source configured.' : 'No tickets yet.'}</p>
      )}
      {STATUSES.map((st) => {
        const list = tickets.filter((t) => (STATUSES as readonly string[]).includes(t.status) ? t.status === st : st === 'todo')
        if (!list.length) return null
        const rows = <ul className="divide-y divide-line border-y border-line">{list.map((t) => <TicketRow key={t.id} state={state} ticket={t} pending={pendingByTicket[t.id]} active={t.id === selectedTicket} onOpen={onOpenTicket} />)}</ul>
        if (st === 'done') {
          return (
            <details key={st} className="mt-5">
              <summary className="cursor-pointer px-3 pb-1 text-[13px] font-medium text-muted-foreground">{STATUS_LABEL[st]} ({list.length})</summary>
              {rows}
            </details>
          )
        }
        return <section key={st}><h3 className={h3}>{STATUS_LABEL[st]} ({list.length})</h3>{rows}</section>
      })}
    </div>
  )
}

function Suggestion({ ticketId, ticketLabel, sessionId, sessionLabel }: { ticketId: string; ticketLabel: string; sessionId: string; sessionLabel: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try { await fn() } catch (e) { setError(e instanceof Error ? e.message : 'error') } finally { setBusy(false) }
  }
  return (
    <li className="flex items-center gap-2 px-3 py-1.5 text-sm">
      <span className="min-w-0 flex-1 truncate">
        <span className="text-ink">{sessionLabel}</span>
        <span className="text-muted-foreground"> → {ticketLabel}</span>
      </span>
      {error && <span role="alert" className="text-xs text-danger">{error}</span>}
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => run(() => unlinkTicket(sessionId, ticketId))} className="min-h-11 text-xs text-muted-foreground">Dismiss</Button>
      <Button size="sm" disabled={busy} onClick={() => run(() => confirmTicketLink(sessionId, ticketId))} className="min-h-11 text-xs">Confirm</Button>
    </li>
  )
}
