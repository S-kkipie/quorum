import { useEffect, useState } from 'react'
import { ApiError, confirmTicketLink, getTicket, listCheckouts, launchTicket, proposeStatus, unlinkTicket, type TicketView } from '../lib/api'
import { SESSION_STATE, STATUSES, STATUS_LABEL, TONE_TEXT, projectCheckouts, ticketLine, ticketSessions } from '../lib/projects'
import type { AppState } from '../lib/store'
import type { Checkout } from '../proto.gen'
import { sessionTitle } from '../lib/title'
import { BypassToggle } from './LaunchDialog'
import { loadPrefs, savePrefs } from '../lib/launch'
import ProposalCard from './ProposalCard'

type OnLaunched = (p: { reqId: string; machine: string; label: string }) => void

const field = 'mt-1 w-full rounded border border-zinc-800 bg-zinc-900 p-2 text-sm'
const h3 = 'mb-1 mt-5 text-xs font-semibold uppercase tracking-wide text-zinc-400'

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
      <div className="p-4 text-sm text-zinc-500">
        {onBack && <button onClick={onBack} className="mb-3 text-zinc-400">← Volver</button>}
        <p>{error || (loaded ? 'Ticket no encontrado.' : 'Cargando…')}</p>
      </div>
    )
  }

  const line = ticketLine(state, t)
  const links = ticketSessions(state, t.id)
  const proposals = Object.values(state.proposals).filter((p) => p.ticketId === t.id).sort((a, b) => b.createdAt - a.createdAt)
  const pending = proposals.filter((p) => p.status === 'pendiente')
  const past = proposals.filter((p) => p.status !== 'pendiente')
  const working = links.find((l) => l.confirmed && l.session && l.session.state !== 'closed')

  return (
    <div className="pb-10">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-zinc-800 bg-zinc-950/90 px-3 py-2 backdrop-blur">
        {onBack && <button onClick={onBack} aria-label="Volver" className="text-zinc-400">←</button>}
        <span className="font-mono text-xs text-zinc-500">{t.externalId}</span>
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{t.title}</h2>
        {t.url && <a href={t.url} target="_blank" rel="noreferrer" className="shrink-0 text-xs text-blue-400">Ver en la ticketera</a>}
      </header>
      <div className="px-3">
        <p className={`mt-3 text-sm ${TONE_TEXT[line.tone]}`}>{line.text}</p>
        <p className="mt-1 text-xs text-zinc-500">
          {STATUS_LABEL[t.status] ?? t.status}{t.rawStatus && ` (${t.rawStatus})`}{t.assignee && ` · ${t.assignee}`}
        </p>
        {error && <p role="alert" className="mt-2 text-xs text-red-400">{error}</p>}

        {pending.length > 0 && (
          <section>
            <h3 className={h3}>Propuestas pendientes</h3>
            <div className="space-y-2">{pending.map((p) => <ProposalCard key={p.id} proposal={p} />)}</div>
          </section>
        )}

        <section>
          <h3 className={h3}>Sesión</h3>
          {working ? (
            <div className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate text-zinc-300">Ya hay una sesión con este ticket en {working.session!.machine}.</span>
              <button onClick={() => onOpenSession?.(working.id)} className="shrink-0 rounded bg-blue-600 px-3 py-1 text-xs text-white">Ir a la sesión</button>
            </div>
          ) : (
            <OpenSession state={state} ticketId={t.id} projectId={t.projectId} onLaunched={onLaunched} onOpenSession={onOpenSession} />
          )}
        </section>

        {links.length > 0 && (
          <section>
            <h3 className={h3}>Sesiones asociadas</h3>
            <ul className="divide-y divide-zinc-900 rounded border border-zinc-800">
              {links.map((l) => <LinkRow key={l.id} {...l} ticketId={t.id} onOpenSession={onOpenSession} />)}
            </ul>
          </section>
        )}

        <ProposeStatus ticketId={t.id} current={t.status} />

        {t.body && (
          <section>
            <h3 className={h3}>Descripción</h3>
            <p className="whitespace-pre-wrap break-words text-sm text-zinc-300">{t.body}</p>
          </section>
        )}
        {t.comments?.length > 0 && (
          <section>
            <h3 className={h3}>Comentarios recientes</h3>
            <ul className="space-y-2">
              {t.comments.map((c, i) => (
                <li key={i} className="rounded bg-zinc-900/60 p-2 text-sm">
                  <span className="block text-xs text-zinc-500">{c.author || 'anónimo'}{c.at ? ` · ${new Date(c.at > 1e12 ? c.at : c.at * 1000).toLocaleString()}` : ''}</span>
                  <span className="mt-1 block whitespace-pre-wrap break-words text-zinc-300">{c.body}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {past.length > 0 && (
          <details className="mt-5">
            <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-zinc-400">Propuestas anteriores ({past.length})</summary>
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
  const st = SESSION_STATE[session?.state ?? 'closed'] ?? SESSION_STATE.idle
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
        <span className="text-xs text-zinc-500"> · {session?.machine ?? '?'} · {st.label}{confirmed ? '' : ' · sugerida'}</span>
      </button>
      {error && <span role="alert" className="text-xs text-red-400">{error}</span>}
      {confirmed ? (
        <button disabled={busy} onClick={() => run(() => unlinkTicket(id, ticketId))} className="shrink-0 text-xs text-zinc-400 underline">Desasociar</button>
      ) : (
        <>
          <button disabled={busy} onClick={() => run(() => unlinkTicket(id, ticketId))} className="shrink-0 text-xs text-zinc-400">Descartar</button>
          <button disabled={busy} onClick={() => run(() => confirmTicketLink(id, ticketId))} className="shrink-0 rounded bg-blue-600 px-2 py-0.5 text-xs text-white">Confirmar</button>
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
  // null = sin tocar: sigue al primer checkout conocido de la máquina
  const [typed, setRoot] = useState<string | null>(null)
  const root = typed ?? roots[0] ?? ''
  const [bypass, setBypass] = useState(prefs.bypass)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [other, setOther] = useState('')

  if (machines.length === 0) return <p className="text-sm text-zinc-500">No hay máquinas en línea para abrir una sesión.</p>

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
        <label className="block text-xs text-zinc-400">Máquina
          <select value={machine} onChange={(e) => pick(e.target.value)} className={field}>
            {machines.map((m) => <option key={m}>{m}</option>)}
          </select>
        </label>
        <BypassToggle checked={bypass} root={!!state.machines[machine]?.caps?.root} onChange={setBypass} />
      </div>
      <label className="mt-2 block text-xs text-zinc-400">Checkout
        <input list={`co-${ticketId}`} value={root} onChange={(e) => setRoot(e.target.value)} placeholder="/ruta/al/repo" className={field} />
        <datalist id={`co-${ticketId}`}>{roots.map((r) => <option key={r} value={r} />)}</datalist>
        {roots.length === 0 && <span className="mt-1 block text-[11px] text-zinc-600">Esta máquina no tiene checkouts conocidos del proyecto: escribe la ruta.</span>}
      </label>
      {error && (
        <p role="alert" className="mt-2 flex items-center gap-2 text-xs text-red-400">
          {error}
          {other && <button onClick={() => onOpenSession?.(other)} className="rounded bg-blue-600 px-2 py-0.5 text-white">Ir a la sesión</button>}
        </p>
      )}
      <div className="mt-2 flex justify-end">
        <button disabled={busy || !machine || !root.trim()} onClick={go} className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-40">Abrir sesión</button>
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
      setMsg('Propuesta creada: apruébala arriba para enviarla.')
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section>
      <h3 className={h3}>Cambiar estado</h3>
      <div className="flex items-center gap-2">
        <select aria-label="Estado nuevo" value={to} onChange={(e) => setTo(e.target.value)} className="min-w-0 flex-1 rounded border border-zinc-800 bg-zinc-900 p-1.5 text-sm">
          {options.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        <button disabled={busy} onClick={go} className="shrink-0 rounded bg-zinc-800 px-3 py-1.5 text-xs disabled:opacity-40">Proponer</button>
      </div>
      <p className="mt-1 text-[11px] text-zinc-600">Quorum no escribe solo en la ticketera: queda como propuesta hasta que la apruebes.</p>
      {msg && <p className="mt-1 text-xs text-zinc-400">{msg}</p>}
    </section>
  )
}
