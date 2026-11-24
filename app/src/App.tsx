import { lazy, useCallback, useEffect, useRef, useState } from 'react'
import { Plus, Settings } from 'lucide-react'
import { UNAUTH_EVENT, getToken, listMachines, openTerminal, listProjects, loadProposals, listSessions, listTickets, listWorkspaces, setDevApi, type TicketView } from './lib/api'
import { connectLive, type Live } from './lib/live'
import { EarlyLaunches, pendingReducer, type Pending } from './lib/launch'
import { addEvents, initialState, reduce, replaceSessions, seed, setCheckouts, setConversations, setProjectsData, setTicketDetail, setTickets } from './lib/store'
import LaunchDialog from './components/LaunchDialog'
import TicketDetail from './components/TicketDetail'
import type { Checkout, Conversation, Envelope, Event, TermFrame } from './proto.gen'
import Config from './screens/Config'
import Project from './screens/Project'
import ProjectTickets from './screens/ProjectTickets'
import Projects from './screens/Projects'
import Pair from './screens/Pair'
import Sessions from './screens/Sessions'
import Starting from './screens/Starting'
import Terminal from './screens/Terminal'
import Viewer from './screens/Viewer'
import { frames } from './lib/frames'
import LazyBoundary from './components/LazyBoundary'
import { Button } from './components/ui/button'

// The session view (AI Elements, markdown) is the heaviest screen: it loads on first open.
const Session = lazy(() => import('./screens/Session'))

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
/** Navigation saved in history.state (on the phone, the browser's "back" goes back). */
/** Open terminal; root/label (if they come from "Terminal") let the screen offer "Open another". */
export interface TermNav { machine: string; pane: string; root?: string; label?: string }
/** Open local artifact of a session. */
export interface ViewNav { machine: string; sessionId: string; path: string }
interface Nav { tab?: Tab; project?: string | null; projectTickets?: string | null; checkouts?: boolean; ticket?: string | null; config?: string | null; session?: string | null; starting?: boolean; terminal?: TermNav | null; viewer?: ViewNav | null; depth?: number }
const navNow = (): Nav => history.state ?? {}

type Toggle = typeof import('./dev/DataToggle').default
const FIXTURE_MODES = ['worst', 'empty', 'one', 'huge'] as const
type FixtureMode = (typeof FIXTURE_MODES)[number]
/** Dev only: the ?data= fixture mode, or null (always null in production builds). */
const devMode = (): FixtureMode | null => {
  if (!import.meta.env.DEV) return null
  const m = new URLSearchParams(location.search).get('data')
  return (FIXTURE_MODES as readonly string[]).includes(m ?? '') ? (m as FixtureMode) : null
}

function Main() {
  const [mode] = useState(devMode)
  const [dev, setDev] = useState<{ Toggle: Toggle } | null>(null)
  const [state, setState] = useState(initialState)
  const [tab, setTab] = useState<Tab>(() => navNow().tab ?? 'projects')
  const [project, setProject] = useState<string | null>(() => navNow().project ?? null)
  // id of the project whose tickets screen is open
  const [projectTickets, setProjectTickets] = useState<string | null>(() => navNow().projectTickets ?? null)
  const [checkoutsOpen, setCheckoutsOpen] = useState(() => !!navNow().checkouts)
  const [ticket, setTicket] = useState<string | null>(() => navNow().ticket ?? null)
  // null = closed; '' = general settings; id = edit that project
  const [config, setConfig] = useState<string | null>(() => navNow().config ?? null)
  const [selected, setSelected] = useState<string | null>(() => navNow().session ?? null)
  const [starting, setStarting] = useState(() => !!navNow().starting)
  const [terminal, setTerminal] = useState<TermNav | null>(() => navNow().terminal ?? null)
  const [viewer, setViewer] = useState<ViewNav | null>(() => navNow().viewer ?? null)
  const [launching, setLaunching] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null)
  const pendingRef = useRef<Pending | null>(null)
  // results that arrive over the WS before the POST /api/launch answers
  const early = useRef(new EarlyLaunches())
  const startingRef = useRef(starting)
  startingRef.current = starting
  // always up-to-date handler for the dispatch (which is stable)
  const onOpenNew = useRef<(id: string) => void>(() => {})
  const wide = useWide()
  const dispatch = useCallback((e: Envelope) => {
    // terminal snapshots arrive up to 8/s: they go to their own store, not the reducer
    if (e.type === 'term_frame') {
      const f = e.payload as TermFrame
      if (f) frames.set(e.machine, f.pane, f)
      return
    }
    if (e.type === 'launch_result' || e.type === 'launch_session') {
      if (!pendingRef.current || pendingRef.current.reqId !== e.payload?.reqId) early.current.remember(e, Date.now())
      const r = pendingReducer(pendingRef.current, e, Date.now())
      pendingRef.current = r.pending
      setPending(r.pending)
      // even after the 60 s: only if the user is still on "Starting…" for that launch
      if (r.open && startingRef.current) onOpenNew.current(r.open)
    }
    setState((s) => reduce(s, e))
  }, [])
  const onEvents = useCallback((id: string, evs: Event[]) => setState((s) => addEvents(s, id, evs)), [])
  const onTickets = useCallback((pid: string, v: TicketView[]) => setState((s) => setTickets(s, pid, v)), [])
  const onCheckouts = useCallback((pid: string, cos: Checkout[]) => setState((s) => setCheckouts(s, pid, cos)), [])
  const onConversations = useCallback((m: string, root: string, l: Conversation[]) => setState((s) => setConversations(s, m, root, l)), [])
  const onTicket = useCallback((v: TicketView) => setState((s) => setTicketDetail(s, v)), [])

  // viewKey identifies the "lineage" of the open session: it changes when another is opened, not when replaced (/clear, /resume).
  const [viewKey, setViewKey] = useState(() => selected ?? '')
  const apply = (n: Nav) => {
    setTab(n.tab ?? 'projects')
    setProject(n.project ?? null)
    setProjectTickets(n.projectTickets ?? null)
    setCheckoutsOpen(!!n.checkouts)
    setTicket(n.ticket ?? null)
    setConfig(n.config ?? null)
    setSelected(n.session ?? null)
    setStarting(!!n.starting)
    setTerminal(n.terminal ?? null)
    setViewer(n.viewer ?? null)
    setViewKey(n.session ?? '')
  }
  useEffect(() => {
    const h = (e: PopStateEvent) => apply(e.state ?? {})
    window.addEventListener('popstate', h)
    return () => window.removeEventListener('popstate', h)
  }, [])
  const cur: Nav = { tab, project, projectTickets, checkouts: checkoutsOpen, ticket, config, session: selected, starting, terminal, viewer }
  /** Goes to another view: on the phone it pushes a history entry; on desktop it just switches. */
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
  /** Back: on the phone, the previous history entry (if the app pushed it); otherwise go up one level. */
  const back = () => {
    if (!wide && (history.state?.depth ?? 0) > 0) { history.back(); return }
    if (checkoutsOpen) go({ checkouts: false }, true)
    else if (viewer) go({ viewer: null }, true)
    else if (terminal) go({ terminal: null }, true)
    else if (starting) go({ starting: false }, true)
    else if (selected) go({ session: null }, true)
    else if (config !== null) go({ config: null }, true)
    else if (ticket) go({ ticket: null }, true)
    else if (projectTickets) go({ projectTickets: null }, true)
    else go({ project: null }, true)
  }

  // If the open session was replaced, follow the new id without remounting the chat.
  let current = selected
  for (let i = 0; current && i < 20 && state.replacedBy[current]; i++) current = state.replacedBy[current]
  const openSession = (id: string) => {
    // the one already shown (maybe with another id after /clear): not remounted or pushed
    if (id === current && (!wide || tab === 'sessions')) { setSelected(id); return }
    // on desktop the session opens in the Sessions tab (list + chat)
    if (wide) go({ tab: 'sessions', session: id })
    else go({ session: id })
    setViewKey(id)
  }
  onOpenNew.current = (id: string) => {
    pendingRef.current = null
    setPending(null)
    // replaces the "Starting…" history entry
    go({ starting: false, terminal: null, viewer: null, session: id, ...(wide ? { tab: 'sessions' as Tab } : {}) }, true)
    setViewKey(id)
  }
  // when leaving "Starting…" the launch is no longer awaited
  useEffect(() => {
    if (!starting) { pendingRef.current = null; setPending(null) }
  }, [starting])
  useEffect(() => {
    if (!selected || !current || current === selected) return
    const c = current
    if (history.state?.session === selected) history.replaceState({ ...history.state, session: c }, '')
    setSelected(c)
  }, [selected, current])

  // The open session vanished after having been present (closed before its first prompt): leave the dead end.
  const seenSession = useRef<string | null>(null)
  // Set while going back from a vanished session, so its view is not drawn as "Session not found." meanwhile.
  const vanished = useRef<string | null>(null)
  if (current && vanished.current !== current && seenSession.current === current && !state.sessions[current]) vanished.current = current
  useEffect(() => {
    if (!current) { seenSession.current = null; vanished.current = null; return }
    if (state.sessions[current]) { seenSession.current = current; vanished.current = null }
    else if (seenSession.current === current) { seenSession.current = null; back() }
  }, [current, state.sessions]) // eslint-disable-line react-hooks/exhaustive-deps

  const [connected, setConnected] = useState(false)
  const live = useRef<Live | null>(null)

  const load = useCallback(async (replace: boolean) => {
    // Initial REST load (seed: does not overwrite what the WS already brought). On reconnect,
    // the REST list replaces the state's: it brings what changed during the outage.
    try {
      const [ms, ss] = await Promise.all([listMachines(), listSessions()])
      setState((s) => (replace ? replaceSessions(s, ms, ss) : seed(s, ms, ss)))
    } catch { /* 401 is handled by api.ts */ }
    try {
      const [workspaces, projects, proposals] = await Promise.all([listWorkspaces(), listProjects(), loadProposals()])
      setState((s) => setProjectsData(s, { workspaces: workspaces ?? [], projects: projects ?? [], proposals: proposals ?? [] }, replace))
      // tickets of each project: the board counts proposals and shows combined states
      await Promise.all((projects ?? []).map((p) => listTickets(p.id).then((v) => setState((s) => setTickets(s, p.id, v ?? []))).catch(() => {})))
    } catch { /* no projects: the board stays empty */ }
  }, [])

  useEffect(() => {
    if (!import.meta.env.DEV || !mode) return
    let off = false
    Promise.all([import('./dev/fixtures'), import('./dev/DataToggle')]).then(([f, t]) => {
      if (off) return
      setDevApi({ listConversations: f.fixtureConversations(mode), listEvents: async () => [] })
      setState(f.fixtureState(mode))
      setConnected(true)
      setDev({ Toggle: t.default })
    })
    return () => { off = true; setDevApi(null) }
  }, [mode])

  useEffect(() => {
    if (mode) return
    load(false)
    let wasConnected = false
    const l = connectLive(dispatch, (c) => {
      setConnected(c)
      if (c && wasConnected) load(true)
      if (c) wasConnected = true
    })
    live.current = l
    return () => l.close()
  }, [mode, load, dispatch])

  const openLaunch = () => setLaunching(true)
  const onLaunched = (p: { reqId: string; machine: string; label: string }) => {
    const now = Date.now()
    const r = early.current.replay({ ...p, startedAt: now }, now)
    setLaunching(false)
    if (r.open) { onOpenNew.current(r.open); return }
    pendingRef.current = r.pending
    setPending(r.pending)
    go({ starting: true, terminal: null })
  }
  // Single synchronous guard for all launches: card, resume and menu go through here.
  const launchingRef = useRef(false)
  const [inflight, setInflight] = useState(false)
  const guardLaunch = async (fn: () => Promise<{ reqId: string; machine: string; label: string }>) => {
    if (launchingRef.current || pendingRef.current) return
    launchingRef.current = true
    setInflight(true)
    try { onLaunched(await fn()) } finally { launchingRef.current = false; setInflight(false) }
  }
  const launchBusy = inflight || !!pending
  const onTerminal = async (machine: string, root: string) => {
    const label = root.split('/').filter(Boolean).pop() || root
    const r = await openTerminal(machine, root, label)
    go({ terminal: { machine, pane: r.pane, root, label } })
  }
  const onViewTerminal = (machine: string, pane: string) => go({ terminal: { machine, pane } })
  const openConfig = (id: string) => go({ config: id, starting: false })
  const dialog = launching && <LaunchDialog state={state} onClose={() => setLaunching(false)} onLaunched={onLaunched} />
  const top = (
    <TopBar tab={tab} connected={connected} onTab={(t) => go({ tab: t, project: null, projectTickets: null, checkouts: false, ticket: null, config: null, starting: false, terminal: null, viewer: null, session: wide ? selected : null }, true)}
      onLaunch={openLaunch} onConfig={() => openConfig('')} />
  )
  const terminalView = terminal && (
    <Terminal key={terminal.machine + '\x00' + terminal.pane} machine={terminal.machine} pane={terminal.pane} root={terminal.root} label={terminal.label}
      onBack={back} onReopen={(pane) => go({ terminal: { ...terminal, pane } }, true)} />
  )
  const viewerView = viewer && (
    <Viewer key={viewer.machine + '\x00' + viewer.sessionId + '\x00' + viewer.path} {...viewer}
      base={state.sessions[viewer.sessionId]?.root || state.sessions[viewer.sessionId]?.cwd || ''} onBack={back} />
  )
  const startingView = starting && <Starting pending={pending} terminal={!!(pending && state.machines[pending.machine]?.caps?.terminal)} onBack={back} onViewTerminal={onViewTerminal} />
  const sessionView = current && vanished.current !== current ? <LazyBoundary><Session key={viewKey} state={state} id={current} onBack={wide ? undefined : back} onEvents={onEvents} onGuard={guardLaunch} busy={launchBusy} onViewTerminal={onViewTerminal} onOpenFile={(machine, path) => current && go({ viewer: { machine, sessionId: current, path } })} /></LazyBoundary> : null
  const sessionsList = <Sessions state={state} onOpen={openSession} selected={current} />
  const projectsView = <Projects state={state} wide={wide} selected={project} onOpen={(id) => go({ project: id, projectTickets: null, checkouts: false, ticket: null })} onOpenSession={openSession} onConfig={() => openConfig('')} />
  const configView = config !== null && <Config key={config} state={state} editProject={config || null} onBack={back} />
  const projectView = project && (
    <Project key={project} state={state} id={project} onBack={wide ? () => go({ project: null, projectTickets: null, checkouts: false, ticket: null }) : back}
      onOpenTickets={(id) => go({ projectTickets: id })} onOpenSession={openSession} onEdit={openConfig} onTickets={onTickets} onCheckouts={onCheckouts} onConversations={onConversations}
      checkoutsOpen={checkoutsOpen} onCheckoutsOpenChange={(o) => (o ? go({ checkouts: true }) : back())}
      pending={launchBusy} onLaunched={onLaunched} onGuard={guardLaunch} onTerminal={onTerminal} />
  )
  const ticketsView = projectTickets && (
    <ProjectTickets key={projectTickets} state={state} id={projectTickets} selectedTicket={ticket} onBack={wide ? () => go({ projectTickets: null, ticket: null }) : back}
      onOpenTicket={(id) => go({ ticket: id })} onTickets={onTickets} />
  )
  const ticketView = ticket && (
    <TicketDetail key={ticket} state={state} ticketId={ticket} onBack={wide ? () => go({ ticket: null }) : back} onOpenSession={openSession} onLoaded={onTicket} onCheckouts={onCheckouts} onLaunched={onLaunched} />
  )

  const toggle = mode && dev && (
    <dev.Toggle mode={mode} onChange={(m) => {
      const u = new URL(location.href)
      if (m === 'demo') u.searchParams.delete('data'); else u.searchParams.set('data', m)
      location.href = u.toString()
    }} />
  )
  if (wide) {
    let body
    if (viewerView) body = <main className="min-h-0 flex-1">{viewerView}</main>
    else if (terminalView) body = <main className="min-h-0 flex-1">{terminalView}</main>
    else if (starting) body = <main className="min-h-0 flex-1">{startingView}</main>
    else if (config !== null) body = <main className="min-h-0 flex-1 overflow-y-auto">{configView}</main>
    else if (tab === 'sessions') {
      body = (
        <div className="flex min-h-0 flex-1">
          <aside className="w-[360px] shrink-0 overflow-y-auto border-r border-zinc-800">{sessionsList}</aside>
          <main className="min-w-0 flex-1">{sessionView ?? <p className="p-6 text-sm text-zinc-500">Pick a session.</p>}</main>
        </div>
      )
    } else {
      body = (
        <div className="flex min-h-0 flex-1">
          <main className="min-w-0 flex-1 overflow-auto">{projectsView}</main>
          {project && (
            <aside className="w-[min(560px,45vw)] shrink-0 overflow-y-auto border-l border-zinc-800">{ticketView || ticketsView || projectView}</aside>
          )}
        </div>
      )
    }
    return <div className="flex h-dvh flex-col">{top}{body}{dialog}{toggle}</div>
  }
  let view
  if (viewerView) view = <div className="h-full">{viewerView}</div>
  else if (terminalView) view = <div className="h-full">{terminalView}</div>
  else if (startingView) view = <div className="h-full">{startingView}</div>
  else if (sessionView) view = <div className="h-full">{sessionView}</div>
  else if (configView) view = <div className="h-full overflow-y-auto">{configView}</div>
  else if (ticketView) view = <div className="h-full overflow-y-auto">{ticketView}</div>
  else if (ticketsView) view = <div className="h-full overflow-y-auto">{ticketsView}</div>
  else if (projectView) view = <div className="h-full overflow-y-auto">{projectView}</div>
  else view = <div className="flex h-full flex-col">{top}<div className="min-h-0 flex-1 overflow-y-auto">{tab === 'sessions' ? sessionsList : projectsView}</div></div>
  return <div className="h-dvh">{view}{dialog}{toggle}</div>
}

function TopBar({ tab, connected, onTab, onLaunch, onConfig }: { tab: Tab; connected: boolean; onTab: (t: Tab) => void; onLaunch: () => void; onConfig: () => void }) {
  const tabCls = (t: Tab) => `min-h-11 px-2.5 ${tab === t ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200'}`
  return (
    <header className="sticky top-0 z-10 flex shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-950/90 px-3 py-2 backdrop-blur">
      <h1 className="mr-1 hidden text-base font-semibold sm:block">Quorum</h1>
      <nav role="tablist" className="flex min-w-0 gap-1">
        <Button variant="ghost" role="tab" aria-selected={tab === 'projects'} onClick={() => onTab('projects')} className={tabCls('projects')}>Projects</Button>
        <Button variant="ghost" role="tab" aria-selected={tab === 'sessions'} onClick={() => onTab('sessions')} className={tabCls('sessions')}>Sessions</Button>
      </nav>
      <span className="ml-auto flex shrink-0 items-center gap-2">
        <Button variant="secondary" size="sm" onClick={onConfig} aria-label="Settings" title="Settings" className="size-11 text-xs min-[380px]:w-auto min-[380px]:px-3">
          <Settings size={16} aria-hidden className="min-[380px]:hidden" /><span className="hidden min-[380px]:inline">Settings</span>
        </Button>
        <Button size="sm" onClick={onLaunch} aria-label="New session" title="New session" className="size-11 text-xs min-[380px]:w-auto min-[380px]:px-3">
          <Plus size={16} aria-hidden className="min-[380px]:hidden" /><span className="hidden min-[380px]:inline">New session</span>
        </Button>
        <span className={`h-2 w-2 shrink-0 rounded-full ${connected ? 'bg-emerald-500' : 'bg-amber-500'}`} title={connected ? 'connected' : 'reconnecting…'} />
        <span className={`hidden text-xs sm:inline ${connected ? 'text-emerald-400' : 'text-amber-400'}`}>{connected ? 'connected' : 'reconnecting…'}</span>
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
