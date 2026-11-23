import { useCallback, useEffect, useState } from 'react'
import Conversations from '../components/Conversations'
import NewSessionCard from '../components/NewSessionCard'
import { Progress } from '../components/ProjectCard'
import TicketRow from '../components/TicketRow'
import { confirmTicketLink, listCheckouts, listTickets, syncProject, unlinkTicket, type TicketView } from '../lib/api'
import { launchIn, loadPrefs } from '../lib/launch'
import { SESSION_STATE, STATUSES, STATUS_LABEL, projectCheckouts, projectSessions, since } from '../lib/projects'
import type { AppState } from '../lib/store'
import type { Checkout } from '../proto.gen'
import { sessionTitle } from '../lib/title'

const h3 = 'mb-1 mt-5 px-3 text-xs font-semibold uppercase tracking-wide text-zinc-400'

export default function Project({ state, id, selectedTicket, onBack, onOpenTicket, onOpenSession, onEdit, onTickets, onCheckouts, pending = false, onLaunched, onGuard, onTerminal }: {
  state: AppState
  id: string
  selectedTicket?: string | null
  onBack?: () => void
  onOpenTicket?: (id: string) => void
  onOpenSession?: (id: string) => void
  onEdit?: (id: string) => void
  onTickets?: (projectId: string, views: TicketView[]) => void
  onCheckouts?: (projectId: string, cos: Checkout[]) => void
  /** Hay un lanzamiento en curso (esperando que la sesión se registre). */
  pending?: boolean
  onLaunched?: (p: { reqId: string; machine: string; label: string }) => void
  onGuard?: (fn: () => Promise<{ reqId: string; machine: string; label: string }>) => Promise<void>
  onTerminal?: (machine: string, root: string) => Promise<unknown> | void
}) {
  const p = state.projects[id]
  const [error, setError] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [sel, setSel] = useState<{ machine: string; root: string } | null>(null)
  const onSelect = useCallback((machine: string, root: string) => setSel((c) => (c && c.machine === machine && c.root === root ? c : { machine, root })), [])

  useEffect(() => {
    let off = false
    listTickets(id).then((v) => { if (!off) onTickets?.(id, v) }).catch((e) => { if (!off) setError(e instanceof Error ? e.message : 'error') })
    listCheckouts(id).then((c) => { if (!off) onCheckouts?.(id, c ?? []) }).catch(() => { /* quedan los deducidos de las sesiones */ })
    return () => { off = true }
  }, [id, onTickets, onCheckouts])
  // "Actualizando…" hasta que llegue el project_upsert de la sincronización
  useEffect(() => { setSyncing(false) }, [p?.syncedAt, p?.syncError])

  if (!p) return <p className="p-4 text-sm text-zinc-500">{onBack && <button onClick={onBack} className="mr-2 text-zinc-400">←</button>}Proyecto no encontrado.</p>

  const ws = state.workspaces[p.workspaceId]
  const tickets = state.tickets[id] ?? []
  const sessions = projectSessions(state, id)
  const checkouts = projectCheckouts(state, id)
  const pendingByTicket: Record<string, number> = {}
  for (const x of Object.values(state.proposals)) if (x.status === 'pendiente') pendingByTicket[x.ticketId] = (pendingByTicket[x.ticketId] ?? 0) + 1
  const suggestions = tickets.flatMap((t) =>
    Object.entries(state.links[t.id] ?? {}).filter(([sid, c]) => !c && state.sessions[sid]).map(([sid]) => ({ t, s: state.sessions[sid] })))

  async function resume(convId: string) {
    if (!sel || pending) return
    setError('')
    try {
      const prefs = loadPrefs(id)
      await onGuard?.(() => launchIn({ machine: sel.machine, dir: sel.root, bypass: prefs.bypass, root: !!state.machines[sel.machine]?.caps?.root, resume: convId, projectId: id }))
    } catch (e) { setError(e instanceof Error ? e.message : 'error') }
  }
  const liveIds = new Set(sessions.map((s) => s.id))

  async function sync() {
    setSyncing(true)
    setError('')
    setTimeout(() => setSyncing(false), 30000)
    try { await syncProject(id) } catch (e) { setError(e instanceof Error ? e.message : 'error'); setSyncing(false) }
  }

  return (
    <div className="pb-10">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-zinc-800 bg-zinc-950/90 px-3 py-2 backdrop-blur">
        {onBack && <button onClick={onBack} aria-label="Volver" className="text-zinc-400">←</button>}
        {ws && <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: ws.color || '#71717a' }} title={ws.name} />}
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold">{p.name}</h2>
        {p.connector?.kind !== 'none' && (
          <button disabled={syncing} onClick={sync} className="shrink-0 rounded bg-zinc-800 px-2 py-1 text-xs disabled:opacity-50">{syncing ? 'Actualizando…' : 'Actualizar'}</button>
        )}
        {onEdit && <button onClick={() => onEdit(id)} className="shrink-0 rounded bg-zinc-800 px-2 py-1 text-xs">Editar</button>}
      </header>
      <div className="px-3 pt-3">
        <Progress done={p.progress?.done ?? 0} total={p.progress?.total ?? 0} />
        {p.summary && <p className="mt-2 text-sm text-zinc-300">{p.summary}</p>}
        <p className="mt-1 text-xs text-zinc-600">
          {ws?.name}{p.repoUrl && ` · ${p.repoUrl}`}{p.syncedAt ? ` · ${p.syncError ? 'último intento' : 'sincronizado'} ${since(p.syncedAt)}` : ''}
        </p>
        {p.syncError && <p role="alert" className="mt-2 rounded bg-red-500/10 px-2 py-1 text-xs text-red-300">Error de sincronización: {p.syncError}</p>}
        {error && <p role="alert" className="mt-2 text-xs text-red-400">{error}</p>}
      </div>

      <NewSessionCard state={state} projectId={id} pending={pending} onLaunched={(p) => onLaunched?.(p)} onGuard={(f) => onGuard?.(f) ?? Promise.resolve()} onTerminal={(m, r) => onTerminal?.(m, r)} onSelect={onSelect} />

      {sessions.length > 0 && (
        <section>
          <h3 className={h3}>Sesiones abiertas</h3>
          <ul className="divide-y divide-zinc-900 border-y border-zinc-900">
            {sessions.map((s) => {
              const st = SESSION_STATE[s.state] ?? SESSION_STATE.idle
              return (
                <li key={s.id}>
                  <button onClick={() => onOpenSession?.(s.id)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-zinc-900">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${st.dot}`} />
                    <span className="min-w-0 flex-1 truncate">{sessionTitle(s).title}</span>
                    <span className="shrink-0 text-xs text-zinc-500">{s.machine}</span>
                    <span className={`shrink-0 text-xs ${st.text}`}>{st.label}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {sel && (
        <section>
          <h3 className={h3}>Conversaciones</h3>
          <Conversations machine={sel.machine} root={sel.root} liveIds={liveIds} busy={pending} outdated={!state.machines[sel.machine]?.caps} onOpen={(sid) => onOpenSession?.(sid)} onResume={resume} />
        </section>
      )}

      {suggestions.length > 0 && (
        <section>
          <h3 className={h3}>Sugerencias de asociación</h3>
          <ul className="divide-y divide-zinc-900 border-y border-zinc-900">
            {suggestions.map(({ t, s }) => <Suggestion key={t.id + s.id} ticketId={t.id} ticketLabel={`${t.externalId} ${t.title}`} sessionId={s.id} sessionLabel={sessionTitle(s).title} />)}
          </ul>
        </section>
      )}

      {tickets.length === 0 && (
        <p className="px-3 pt-6 text-sm text-zinc-500">{p.connector?.kind === 'none' ? 'Este proyecto no tiene ticketera configurada.' : 'Sin tickets todavía.'}</p>
      )}
      {STATUSES.map((st) => {
        const list = tickets.filter((t) => (STATUSES as readonly string[]).includes(t.status) ? t.status === st : st === 'por_hacer')
        if (!list.length) return null
        const rows = <ul className="divide-y divide-zinc-900 border-y border-zinc-900">{list.map((t) => <TicketRow key={t.id} state={state} ticket={t} pending={pendingByTicket[t.id]} active={t.id === selectedTicket} onOpen={onOpenTicket} />)}</ul>
        if (st === 'hecho') {
          return (
            <details key={st} className="mt-5">
              <summary className="cursor-pointer px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">{STATUS_LABEL[st]} ({list.length})</summary>
              {rows}
            </details>
          )
        }
        return <section key={st}><h3 className={h3}>{STATUS_LABEL[st]} ({list.length})</h3>{rows}</section>
      })}

      <section>
        <h3 className={h3}>Checkouts</h3>
        {checkouts.length ? (
          <ul className="px-3 text-xs text-zinc-400">
            {checkouts.map((c) => (
              <li key={c.machine + c.root} className="truncate py-0.5">
                <span className={state.machines[c.machine]?.online ? 'text-emerald-400' : 'text-zinc-600'}>●</span> {c.machine} · <span className="font-mono">{c.root}</span>{c.branch && ` · ${c.branch}`}
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-3 text-xs text-zinc-600">Ninguno todavía: aparecen solos cuando hay sesiones en el repo del proyecto.</p>
        )}
      </section>
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
        <span className="text-zinc-300">{sessionLabel}</span>
        <span className="text-zinc-500"> → {ticketLabel}</span>
      </span>
      {error && <span role="alert" className="text-xs text-red-400">{error}</span>}
      <button disabled={busy} onClick={() => run(() => unlinkTicket(sessionId, ticketId))} className="shrink-0 text-xs text-zinc-400">Descartar</button>
      <button disabled={busy} onClick={() => run(() => confirmTicketLink(sessionId, ticketId))} className="shrink-0 rounded bg-blue-600 px-2 py-0.5 text-xs text-white">Confirmar</button>
    </li>
  )
}
