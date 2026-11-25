import { useEffect, useState } from 'react'
import { ApiError, confirmTicketLink, getTicket, listCheckouts, launchTicket, proposeStatus, unlinkTicket, type TicketView } from '../lib/api'
import { displayState } from '../lib/sessions'
import { STATUSES, STATUS_LABEL, TONE_TEXT, projectCheckouts, readOnlyKind, stateStyle, ticketLine, ticketSessions } from '../lib/projects'
import type { AppState } from '../lib/store'
import type { Checkout } from '../proto.gen'
import { sessionTitle } from '../lib/title'
import { BypassToggle } from './LaunchDialog'
import { loadPrefs, savePrefs } from '../lib/launch'
import ProposalCard from './ProposalCard'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type OnLaunched = (p: { reqId: string; machine: string; label: string }) => void

const field = 'mt-1 min-h-11 w-full rounded-lg border border-line bg-surface p-2 text-sm md:text-sm'
const h3 = 'mb-1 mt-5 text-[13px] font-medium text-muted-foreground'

export default function TicketDetail({ state, ticketId, onBack, onOpenSession, onLoaded, onCheckouts, onLaunched }: {
  state: AppState
  ticketId: string
  onBack?: () => void
  onOpenSession?: (id: string) => void
  onLoaded?: (v: TicketView) => void
  onCheckouts?: (projectId: string, cos: Checkout[]) => void
  onLaunched?: OnLaunched
}) {
  const t = Object.values(state.tickets).flat().find((x) => x.id === ticketId)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let off = false
    setLoaded(false)
    getTicket(ticketId)
      .then((v) => { if (!off) { onLoaded?.(v); setLoaded(true) } })
      .catch((e) => { if (!off) setError(e instanceof Error ? e.message : 'error') })
    return () => { off = true }
  }, [ticketId, onLoaded])
  const projectId = t?.projectId
  useEffect(() => {
    if (!projectId) return
    let off = false
    listCheckouts(projectId).then((c) => { if (!off) onCheckouts?.(projectId, c ?? []) }).catch(() => {})
    return () => { off = true }
  }, [projectId, onCheckouts])

  if (!t) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {onBack && <Button variant="ghost" onClick={onBack} className="mb-3 min-h-11 text-muted-foreground">← Back</Button>}
        <p>{error || (loaded ? 'Ticket not found.' : 'Loading…')}</p>
      </div>
    )
  }

  const line = ticketLine(state, t)
  const links = ticketSessions(state, t.id)
  const proposals = Object.values(state.proposals).filter((p) => p.ticketId === t.id).sort((a, b) => b.createdAt - a.createdAt)
  const pending = proposals.filter((p) => p.status === 'pending')
  const past = proposals.filter((p) => p.status !== 'pending')
  const working = links.find((l) => l.confirmed && l.session && l.session.state !== 'closed')
  // a read-only source (Moontech): nothing is ever written back, so no proposals and no status change
  const readOnly = readOnlyKind(state.projects[t.projectId]?.connector?.kind)

  return (
    <div className="pb-10">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-background/90 px-3 py-2 backdrop-blur">
        {onBack && <Button variant="ghost" onClick={onBack} aria-label="Back" className="min-h-11 min-w-11 text-muted-foreground">←</Button>}
        <span className="font-mono text-xs text-muted-foreground">{t.externalId}</span>
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{t.title}</h2>
        {t.url && <a href={t.url} target="_blank" rel="noopener noreferrer" className="shrink-0 text-xs text-accent">View in the ticket source</a>}
      </header>
      <div className="px-3">
        <p className={`mt-3 text-sm ${TONE_TEXT[line.tone]}`}>{line.text}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {STATUS_LABEL[t.status] ?? t.status}{t.rawStatus && ` (${t.rawStatus})`}{t.assignee && ` · ${t.assignee}`}
        </p>
        {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
        {readOnly && <p className="mt-2 text-xs text-muted-foreground">Read-only source: Quorum never writes to it.</p>}

        {!readOnly && pending.length > 0 && (
          <section>
            <h3 className={h3}>Pending proposals</h3>
            <div className="space-y-2">{pending.map((p) => <ProposalCard key={p.id} proposal={p} />)}</div>
          </section>
        )}

        <section>
          <h3 className={h3}>Session</h3>
          {working ? (
            <div className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate text-ink">A session is already working on this ticket on {working.session!.machine}.</span>
              <Button size="sm" onClick={() => onOpenSession?.(working.id)} className="min-h-11 text-xs">Go to session</Button>
            </div>
          ) : (
            <OpenSession state={state} ticketId={t.id} projectId={t.projectId} onLaunched={onLaunched} onOpenSession={onOpenSession} />
          )}
        </section>

        {links.length > 0 && (
          <section>
            <h3 className={h3}>Linked sessions</h3>
            <ul className="divide-y divide-line rounded-xl border border-line">
              {links.map((l) => <LinkRow key={l.id} {...l} ticketId={t.id} onOpenSession={onOpenSession} />)}
            </ul>
          </section>
        )}

        {!readOnly && <ProposeStatus ticketId={t.id} current={t.status} />}

        {t.body && (
          <section>
            <h3 className={h3}>Description</h3>
            <p className="whitespace-pre-wrap break-words text-sm text-ink">{t.body}</p>
          </section>
        )}
        {t.comments?.length > 0 && (
          <section>
            <h3 className={h3}>Recent comments</h3>
            <ul className="space-y-2">
              {t.comments.map((c, i) => (
                <li key={i} className="rounded-xl bg-chip p-3 text-sm">
                  <span className="block text-xs text-muted-foreground">{c.author || 'anonymous'}{c.at ? ` · ${new Date(c.at > 1e12 ? c.at : c.at * 1000).toLocaleString()}` : ''}</span>
                  <span className="mt-1 block whitespace-pre-wrap break-words text-ink">{c.body}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {!readOnly && past.length > 0 && (
          <details className="mt-5">
            <summary className="cursor-pointer text-[13px] font-medium text-muted-foreground">Past proposals ({past.length})</summary>
            <div className="mt-2 space-y-2">{past.map((p) => <ProposalCard key={p.id} proposal={p} />)}</div>
          </details>
        )}
      </div>
    </div>
  )
}

function LinkRow({ id, session, confirmed, ticketId, onOpenSession }: { id: string; session?: AppState['sessions'][string]; confirmed: boolean; ticketId: string; onOpenSession?: (id: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const st = stateStyle(session ? displayState(session) : 'closed')
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try { await fn() } catch (e) { setError(e instanceof Error ? e.message : 'error') } finally { setBusy(false) }
  }
  return (
    <li className="flex items-center gap-2 px-2 py-1.5 text-sm">
      <span className={`h-2 w-2 shrink-0 rounded-full ${st.dot}`} />
      <button onClick={() => onOpenSession?.(id)} className="min-w-0 flex-1 truncate text-left">
        {session ? sessionTitle(session).title : id.slice(0, 8)}
        <span className="text-xs text-muted-foreground"> · {session?.machine ?? '?'} · {st.label}{confirmed ? '' : ' · suggested'}</span>
      </button>
      {error && <span role="alert" className="text-xs text-danger">{error}</span>}
      {confirmed ? (
        <Button variant="link" size="sm" disabled={busy} onClick={() => run(() => unlinkTicket(id, ticketId))} className="min-h-11 text-xs text-muted-foreground">Unlink</Button>
      ) : (
        <>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => run(() => unlinkTicket(id, ticketId))} className="min-h-11 text-xs text-muted-foreground">Dismiss</Button>
          <Button size="sm" disabled={busy} onClick={() => run(() => confirmTicketLink(id, ticketId))} className="min-h-11 text-xs">Confirm</Button>
        </>
      )}
    </li>
  )
}

function OpenSession({ state, ticketId, projectId, onLaunched, onOpenSession }: { state: AppState; ticketId: string; projectId: string; onLaunched?: OnLaunched; onOpenSession?: (id: string) => void }) {
  const checkouts = projectCheckouts(state, projectId)
  const online = Object.values(state.machines).filter((m) => m.online).map((m) => m.name)
  const withCheckout = [...new Set(checkouts.map((c) => c.machine))].filter((m) => online.includes(m))
  const machines = [...withCheckout, ...online.filter((m) => !withCheckout.includes(m)).sort()]
  const prefs = loadPrefs(projectId)
  const [picked, setMachine] = useState(prefs.machine ?? '')
  const machine = machines.includes(picked) ? picked : machines[0] ?? ''
  const roots = checkouts.filter((c) => c.machine === machine).map((c) => c.root)
  // null = untouched: follows the machine's first known checkout
  const [typed, setRoot] = useState<string | null>(null)
  const root = typed ?? roots[0] ?? ''
  const [bypass, setBypass] = useState(prefs.bypass)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [other, setOther] = useState('')

  if (machines.length === 0) return <p className="text-sm text-muted-foreground">No machines online to open a session.</p>

  async function go() {
    setBusy(true)
    setError('')
    setOther('')
    try {
      const useBypass = bypass && !state.machines[machine]?.caps?.root
      const r = await launchTicket(ticketId, { machine, checkoutRoot: root.trim(), permissionMode: useBypass ? 'bypass' : 'default' })
      savePrefs(projectId, { machine, bypass })
      onLaunched?.({ reqId: r.reqId, machine, label: root.trim() })
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.data?.session) setOther(e.data.session)
      setError(e instanceof Error ? e.message : 'error')
    } finally {
      setBusy(false)
    }
  }
  const pick = (m: string) => {
    setMachine(m)
    setRoot(null)
  }
  return (
    <div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-xs text-muted-foreground">Machine
          <select value={machine} onChange={(e) => pick(e.target.value)} className={field}>
            {machines.map((m) => <option key={m}>{m}</option>)}
          </select>
        </label>
        <BypassToggle checked={bypass} root={!!state.machines[machine]?.caps?.root} onChange={setBypass} />
      </div>
      <label className="mt-2 block text-xs text-muted-foreground">Checkout
        <Input list={`co-${ticketId}`} value={root} onChange={(e) => setRoot(e.target.value)} placeholder="/path/to/repo" className={field} />
        <datalist id={`co-${ticketId}`}>{roots.map((r) => <option key={r} value={r} />)}</datalist>
        {roots.length === 0 && <span className="mt-1 block text-xs text-muted-foreground">This machine has no known checkouts of the project: type the path.</span>}
      </label>
      {error && (
        <p role="alert" className="mt-2 flex items-center gap-2 text-xs text-danger">
          {error}
          {other && <Button size="sm" onClick={() => onOpenSession?.(other)} className="min-h-11 text-xs">Go to session</Button>}
        </p>
      )}
      <div className="mt-2 flex justify-end">
        <Button className="min-h-11" disabled={busy || !machine || !root.trim()} onClick={go}>Open session</Button>
      </div>
    </div>
  )
}

function ProposeStatus({ ticketId, current }: { ticketId: string; current: string }) {
  const options = STATUSES.filter((s) => s !== current)
  const [to, setTo] = useState<string>(options[0])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  async function go() {
    setBusy(true)
    setMsg('')
    try {
      await proposeStatus(ticketId, to)
      setMsg('Proposal created: approve it above to send it.')
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section>
      <h3 className={h3}>Change status</h3>
      <div className="flex items-center gap-2">
        <select aria-label="New status" value={to} onChange={(e) => setTo(e.target.value)} className="min-h-11 min-w-0 flex-1 rounded-lg border border-line bg-surface p-1.5 text-sm">
          {options.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        <Button variant="secondary" disabled={busy} onClick={go} className="min-h-11 text-xs">Propose</Button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">Quorum never writes to the ticket source on its own: it stays a proposal until you approve it.</p>
      {msg && <p className="mt-1 text-xs text-muted-foreground">{msg}</p>}
    </section>
  )
}
