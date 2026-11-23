import { useCallback, useEffect, useRef, useState } from 'react'
import { UNAUTH_EVENT, getToken, listMachines, listProjects, loadProposals, listSessions, listTickets, listWorkspaces, type TicketView } from './lib/api'
import { connectLive, type Live } from './lib/live'
import { addEvents, initialState, reduce, replaceSessions, seed, setCheckouts, setProjectsData, setTicketDetail, setTickets } from './lib/store'
import LaunchDialog from './components/LaunchDialog'
import TicketDetail from './components/TicketDetail'
import type { Checkout, Envelope, Event } from './proto.gen'
import Config from './screens/Config'
import Project from './screens/Project'
import Projects from './screens/Projects'
import Session from './screens/Session'
import Pair from './screens/Pair'
import Sessions from './screens/Sessions'

export default function App() {
  const [authed, setAuthed] = useState(() => !!getToken())
  useEffect(() => {
    const h = () => setAuthed(false)
    window.addEventListener(UNAUTH_EVENT, h)
    return () => window.removeEventListener(UNAUTH_EVENT, h)
  }, [])
  if (!authed) return <Pair onPaired={() => setAuthed(true)} />
  return <Main />
}

type Tab = 'projects' | 'sessions'
/** Navegación guardada en history.state (en el celular, "atrás" del navegador vuelve). */
interface Nav { tab?: Tab; project?: string | null; ticket?: string | null; config?: string | null; session?: string | null; depth?: number }
const navNow = (): Nav => history.state ?? {}

function Main() {
  const [state, setState] = useState(initialState)
  const [tab, setTab] = useState<Tab>(() => navNow().tab ?? 'projects')
  const [project, setProject] = useState<string | null>(() => navNow().project ?? null)
  const [ticket, setTicket] = useState<string | null>(() => navNow().ticket ?? null)
  // null = cerrada; '' = configuración general; id = editar ese proyecto
  const [config, setConfig] = useState<string | null>(() => navNow().config ?? null)
  const [selected, setSelected] = useState<string | null>(() => navNow().session ?? null)
  const [launching, setLaunching] = useState(false)
  const [launchResult, setLaunchResult] = useState<{ reqId: string; ok: boolean; error?: string } | null>(null)
  const wide = useWide()
  const dispatch = useCallback((e: Envelope) => {
    if (e.type === 'launch_result') setLaunchResult(e.payload)
    setState((s) => reduce(s, e))
  }, [])
  const onEvents = useCallback((id: string, evs: Event[]) => setState((s) => addEvents(s, id, evs)), [])
  const onTickets = useCallback((pid: string, v: TicketView[]) => setState((s) => setTickets(s, pid, v)), [])
  const onCheckouts = useCallback((pid: string, cos: Checkout[]) => setState((s) => setCheckouts(s, pid, cos)), [])
  const onTicket = useCallback((v: TicketView) => setState((s) => setTicketDetail(s, v)), [])

  // viewKey identifica el "linaje" de la sesión abierta: cambia al abrir otra, no al reemplazarse (/clear, /resume).
  const [viewKey, setViewKey] = useState(() => selected ?? '')
  const apply = (n: Nav) => {
    setTab(n.tab ?? 'projects')
    setProject(n.project ?? null)
    setTicket(n.ticket ?? null)
    setConfig(n.config ?? null)
    setSelected(n.session ?? null)
    setViewKey(n.session ?? '')
  }
  useEffect(() => {
    const h = (e: PopStateEvent) => apply(e.state ?? {})
    window.addEventListener('popstate', h)
    return () => window.removeEventListener('popstate', h)
  }, [])
  const cur: Nav = { tab, project, ticket, config, session: selected }
  /** Va a otra vista: en el celular apila una entrada en el historial; en escritorio solo cambia. */
  const go = (n: Nav, replace = false) => {
    const depth = history.state?.depth ?? 0
    if (!wide && !replace) {
      const next = { ...cur, ...n, depth: depth + 1 }
      history.pushState(next, '')
      apply(next)
    } else {
      const next = { ...cur, ...n, depth }
      history.replaceState(next, '')
      apply(next)
    }
  }
  /** Atrás: en el celular, la entrada anterior del historial (si la app la apiló); si no, sube un nivel. */
  const back = () => {
    if (!wide && (history.state?.depth ?? 0) > 0) { history.back(); return }
    if (selected) go({ session: null }, true)
    else if (config !== null) go({ config: null }, true)
    else if (ticket) go({ ticket: null }, true)
    else go({ project: null }, true)
  }

  // Si la sesión abierta fue reemplazada, seguir al id nuevo sin remontar el chat.
  let current = selected
  for (let i = 0; current && i < 20 && state.replacedBy[current]; i++) current = state.replacedBy[current]
  const openSession = (id: string) => {
    // la que ya se ve (quizá con otro id tras /clear): no se remonta ni se apila
    if (id === current && (!wide || tab === 'sessions')) { setSelected(id); return }
    // en escritorio la sesión se abre en la pestaña Sesiones (lista + chat)
    if (wide) go({ tab: 'sessions', session: id })
    else go({ session: id })
    setViewKey(id)
  }
  useEffect(() => {
    if (!selected || !current || current === selected) return
    const c = current
    if (history.state?.session === selected) history.replaceState({ ...history.state, session: c }, '')
    setSelected(c)
  }, [selected, current])

  const [connected, setConnected] = useState(false)
  const live = useRef<Live | null>(null)

  const load = useCallback(async (replace: boolean) => {
    // Carga inicial por REST (seed: no pisa lo que ya trajo el WS). Al reconectar,
    // la lista REST reemplaza la del estado: trae lo que cambió durante la caída.
    try {
      const [ms, ss] = await Promise.all([listMachines(), listSessions()])
      setState((s) => (replace ? replaceSessions(s, ms, ss) : seed(s, ms, ss)))
    } catch { /* 401 lo maneja api.ts */ }
    try {
      const [workspaces, projects, proposals] = await Promise.all([listWorkspaces(), listProjects(), loadProposals()])
      setState((s) => setProjectsData(s, { workspaces: workspaces ?? [], projects: projects ?? [], proposals: proposals ?? [] }, replace))
      // tickets de cada proyecto: el tablero cuenta propuestas y muestra estados combinados
      await Promise.all((projects ?? []).map((p) => listTickets(p.id).then((v) => setState((s) => setTickets(s, p.id, v ?? []))).catch(() => {})))
    } catch { /* sin proyectos: el tablero queda vacío */ }
  }, [])

  useEffect(() => {
    load(false)
    let wasConnected = false
    const l = connectLive(dispatch, (c) => {
      setConnected(c)
      if (c && wasConnected) load(true)
      if (c) wasConnected = true
    })
    live.current = l
    return () => l.close()
  }, [load, dispatch])

  const openLaunch = () => { setLaunchResult(null); setLaunching(true) }
  const dialog = launching && <LaunchDialog state={state} result={launchResult} onClose={() => setLaunching(false)} />
  const top = (
    <TopBar tab={tab} connected={connected} onTab={(t) => go({ tab: t, project: null, ticket: null, config: null, session: wide ? selected : null }, true)}
      onLaunch={openLaunch} onConfig={() => go({ config: '' })} />
  )
  const sessionView = current ? <Session key={viewKey} state={state} id={current} onBack={wide ? undefined : back} onEvents={onEvents} /> : null
  const sessionsList = <Sessions state={state} onOpen={openSession} selected={current} />
  const projectsView = <Projects state={state} wide={wide} selected={project} onOpen={(id) => go({ project: id, ticket: null })} onOpenSession={openSession} onConfig={() => go({ config: '' })} />
  const configView = config !== null && <Config key={config} state={state} editProject={config || null} onBack={back} />
  const projectView = project && (
    <Project key={project} state={state} id={project} selectedTicket={ticket} onBack={wide ? () => go({ project: null, ticket: null }) : back}
      onOpenTicket={(id) => go({ ticket: id })} onOpenSession={openSession} onEdit={(id) => go({ config: id })} onTickets={onTickets} onCheckouts={onCheckouts} />
  )
  const ticketView = ticket && (
    <TicketDetail key={ticket} state={state} ticketId={ticket} onBack={wide ? () => go({ ticket: null }) : back} onOpenSession={openSession} onLoaded={onTicket} onCheckouts={onCheckouts} launchResult={launchResult} />
  )

  if (wide) {
    let body
    if (config !== null) body = <main className="min-h-0 flex-1 overflow-y-auto">{configView}</main>
    else if (tab === 'sessions') {
      body = (
        <div className="flex min-h-0 flex-1">
          <aside className="w-[360px] shrink-0 overflow-y-auto border-r border-zinc-800">{sessionsList}</aside>
          <main className="min-w-0 flex-1">{sessionView ?? <p className="p-6 text-sm text-zinc-500">Elige una sesión.</p>}</main>
        </div>
      )
    } else {
      body = (
        <div className="flex min-h-0 flex-1">
          <main className="min-w-0 flex-1 overflow-auto">{projectsView}</main>
          {project && (
            <aside className="w-[min(560px,45vw)] shrink-0 overflow-y-auto border-l border-zinc-800">{ticketView || projectView}</aside>
          )}
        </div>
      )
    }
    return <div className="flex h-dvh flex-col">{top}{body}{dialog}</div>
  }
  let view
  if (sessionView) view = <div className="h-full">{sessionView}</div>
  else if (configView) view = <div className="h-full overflow-y-auto">{configView}</div>
  else if (ticketView) view = <div className="h-full overflow-y-auto">{ticketView}</div>
  else if (projectView) view = <div className="h-full overflow-y-auto">{projectView}</div>
  else view = <div className="flex h-full flex-col">{top}<div className="min-h-0 flex-1 overflow-y-auto">{tab === 'sessions' ? sessionsList : projectsView}</div></div>
  return <div className="h-dvh">{view}{dialog}</div>
}

function TopBar({ tab, connected, onTab, onLaunch, onConfig }: { tab: Tab; connected: boolean; onTab: (t: Tab) => void; onLaunch: () => void; onConfig: () => void }) {
  const tabCls = (t: Tab) => `rounded px-2.5 py-1 text-sm ${tab === t ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200'}`
  return (
    <header className="sticky top-0 z-10 flex shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-950/90 px-3 py-2 backdrop-blur">
      <h1 className="mr-1 hidden text-base font-semibold sm:block">Quorum</h1>
      <nav role="tablist" className="flex gap-1">
        <button role="tab" aria-selected={tab === 'projects'} onClick={() => onTab('projects')} className={tabCls('projects')}>Proyectos</button>
        <button role="tab" aria-selected={tab === 'sessions'} onClick={() => onTab('sessions')} className={tabCls('sessions')}>Sesiones</button>
      </nav>
      <span className="ml-auto flex items-center gap-2">
        <button onClick={onConfig} aria-label="Configuración" title="Configuración" className="rounded bg-zinc-800 px-2 py-1 text-xs">Configurar</button>
        <button onClick={onLaunch} className="rounded bg-blue-600 px-2 py-1 text-xs text-white">Lanzar</button>
        <span className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-amber-500'}`} title={connected ? 'conectado' : 'reconectando…'} />
        <span className={`hidden text-xs sm:inline ${connected ? 'text-emerald-400' : 'text-amber-400'}`}>{connected ? 'conectado' : 'reconectando…'}</span>
      </span>
    </header>
  )
}

function useWide() {
  const q = '(min-width: 1024px)'
  const [wide, setWide] = useState(() => window.matchMedia(q).matches)
  useEffect(() => {
    const m = window.matchMedia(q)
    const h = () => setWide(m.matches)
    m.addEventListener('change', h)
    return () => m.removeEventListener('change', h)
  }, [])
  return wide
}
