import { lazy, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { UNAUTH_EVENT, getToken, listMachines, listUsage, openTerminal, listProjects, loadProposals, listSessions, listTickets, listWorkspaces, setDevApi, type TicketView } from './lib/api'
import { connectLive, type Live } from './lib/live'
import { EarlyLaunches, pendingReducer, type Pending } from './lib/launch'
import { addEvents, evictEvents, idleSessions, initialState, trimEvents, loadCommands, markSeen, reduce, replaceSessions, seed, setCheckouts, setConversations, setProjectsData, setTicketDetail, setTickets, setUsage } from './lib/store'
import LaunchDialog from './components/LaunchDialog'
import type { Checkout, Conversation, Envelope, Event, SessionCommands, TermFrame } from './proto.gen'
import Projects from './screens/Projects'
import Pair from './screens/Pair'
import Inbox from './screens/Inbox'
import { attentionCount } from './lib/sessions'
import Viewer from './screens/Viewer'
import { usePageVisible } from './lib/useMarkSeen'
import { isNative } from './lib/native'
import { frames } from './lib/frames'
import { CLEAR, centreNav, centreOf, type Centre, type Nav, type Tab, type TermNav } from './lib/nav'
import { useLayout } from './lib/useLayout'
import AppShell from './components/shell/AppShell'
import LazyBoundary from './components/LazyBoundary'
import BottomNav, { type NavTab } from './components/shell/BottomNav'
import PhoneHeader from './components/shell/PhoneHeader'

// The session view (AI Elements, markdown) is the heaviest screen: it loads on first open.
const Session = lazy(() => import('./screens/Session'))
// Pages that are not the landing view load on first open too, so the initial bundle stays small.
const Config = lazy(() => import('./screens/Config'))
const Project = lazy(() => import('./screens/Project'))
const ProjectTickets = lazy(() => import('./screens/ProjectTickets'))
const TicketDetail = lazy(() => import('./components/TicketDetail'))
const Terminal = lazy(() => import('./screens/Terminal'))
const Starting = lazy(() => import('./screens/Starting'))

/** Forgets the local event cache (unpair / logout); loaded on demand like the session view. */
const clearLocalCache = () => import('./lib/cache').then((c) => c.clearCache()).catch(() => { /* no storage */ })

export default function App() {
  const [authed, setAuthed] = useState(() => !!getToken())
  useEffect(() => {
    const h = () => { setAuthed(false); clearLocalCache() }
    window.addEventListener(UNAUTH_EVENT, h)
    return () => window.removeEventListener(UNAUTH_EVENT, h)
  }, [])
  // a new pairing starts without what another hub (or an earlier pairing) left in the cache
  if (!authed) return <Pair onPaired={async () => { await clearLocalCache(); setAuthed(true) }} />
  return <Main />
}

export type { TermNav, ViewNav } from './lib/nav'
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
  const [tab, setTab] = useState<Tab>(() => navNow().tab ?? 'sessions')
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
  const [viewer, setViewer] = useState<Nav['viewer']>(() => navNow().viewer ?? null)
  // the launch dialog, with its scope (the sidebar's job + or a project's "Start one")
  const [launching, setLaunching] = useState<{ projectId?: string; workspaceId?: string } | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const pendingRef = useRef<Pending | null>(null)
  // results that arrive over the WS before the POST /api/launch answers
  const early = useRef(new EarlyLaunches())
  const startingRef = useRef(starting)
  startingRef.current = starting
  // always up-to-date handler for the dispatch (which is stable)
  const onOpenNew = useRef<(id: string) => void>(() => {})
  const wide = useLayout().mode === 'desktop'
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
  const onTrim = useCallback((id: string, o: { max?: number; below?: number; keepOldest?: number }) => setState((s) => trimEvents(s, id, o)), [])
  const onSeen = useCallback((id: string) => setState((s) => markSeen(s, id)), [])
  const onCommands = useCallback((sc: SessionCommands, rev: number | undefined) => setState((s) => loadCommands(s, sc, rev)), [])
  const onTickets = useCallback((pid: string, v: TicketView[]) => setState((s) => setTickets(s, pid, v)), [])
  const onCheckouts = useCallback((pid: string, cos: Checkout[]) => setState((s) => setCheckouts(s, pid, cos)), [])
  const onConversations = useCallback((m: string, root: string, l: Conversation[]) => setState((s) => setConversations(s, m, root, l)), [])
  const onTicket = useCallback((v: TicketView) => setState((s) => setTicketDetail(s, v)), [])

  // viewKey identifies the "lineage" of the open session: it changes when another is opened, not when replaced (/clear, /resume).
  const [viewKey, setViewKey] = useState(() => selected ?? '')
  const apply = (n: Nav) => {
    setTab(n.tab ?? 'sessions')
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
  // Desktop: what the centre pane shows (the open session follows /clear through `current` below).
  const centre = centreOf(cur)
  /** Goes to another view: pushes a history entry (so Back returns), or replaces the current one. */
  const go = (n: Nav, replace = false) => {
    const depth = history.state?.depth ?? 0
    if (!replace) {
      const next = { ...cur, ...n, depth: depth + 1 }
      history.pushState(next, '')
      apply(next)
    } else {
      const next = { ...cur, ...n, depth }
      history.replaceState(next, '')
      apply(next)
    }
  }
  /** Desktop: shows a page in the centre, with nothing of the previous page left over. */
  const goCentre = (c: Centre) => go(centreNav(c))
  /** Back: the previous history entry (if the app pushed it); otherwise go up one level. */
  const back = () => {
    if ((history.state?.depth ?? 0) > 0) { history.back(); return }
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
    if (id === current && (!wide || centre.kind === 'session')) { setSelected(id); return }
    // on desktop the session takes the centre, whatever page was there
    if (wide) go({ ...CLEAR, session: id })
    else go({ session: id })
    setViewKey(id)
  }
  // Android app: push registration and notification taps. The Capacitor code is a lazy chunk the web build never loads.
  const openRef = useRef(openSession)
  openRef.current = openSession
  useEffect(() => {
    if (!isNative()) return
    let off = false
    const push = import('./lib/push')
    push.then((p) => { if (!off) return p.startPush((id) => openRef.current(id)) }).catch(() => { /* no push: the app still works */ })
    return () => { off = true; push.then((p) => p.stopPush()).catch(() => {}) }
  }, [])
  onOpenNew.current = (id: string) => {
    pendingRef.current = null
    setPending(null)
    // replaces the "Starting…" history entry
    go(wide ? { ...CLEAR, session: id } : { starting: false, terminal: null, viewer: null, session: id }, true)
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

  // Sessions not open for 2 minutes keep only their newest page in memory (the rest is saved to the
  // local cache first, and read back from it, the hub or the machine when the session is opened).
  const viewed = useRef<Record<string, number>>({})
  const latestState = useRef(state)
  latestState.current = state
  const openId = useRef(current)
  openId.current = current
  useEffect(() => {
    const c = current
    return () => { if (c) viewed.current[c] = Date.now() }
  }, [current])
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now()
      const open = openId.current
      if (open) viewed.current[open] = now
      const s = latestState.current
      const ids = idleSessions(s, open, viewed.current, now)
      if (!ids.length) return
      if (!mode) import('./lib/cache').then((c) => { for (const id of ids) c.saveCached(id, s.events[id]) }).catch(() => { /* no storage */ })
      setState((x) => evictEvents(x, ids))
    }, 30_000)
    return () => clearInterval(t)
  }, [mode])

  // The session the owner is looking at (open and the page visible) reads as seen everywhere, so a
  // turn that ends in front of them never flickers "unread" before useMarkSeen's mark lands.
  const visible = usePageVisible()
  // On desktop only the session in the centre counts (a project page or Settings in the centre is not viewing it).
  const viewing = !!current && vanished.current !== current && visible && !viewer && (wide ? centre.kind === 'session' : !terminal && !starting)
  const shown = useMemo(() => (viewing && current ? markSeen(state, current) : state), [viewing, current, state])
  const attention = attentionCount(Object.values(shown.sessions).filter((x) => x.role !== 'service'))

  const [connected, setConnected] = useState(false)
  // bumped on every reconnect of the live feed: the open session re-reads its command list
  const [reconnects, setReconnects] = useState(0)
  const live = useRef<Live | null>(null)

  const load = useCallback(async (replace: boolean) => {
    // Initial REST load (seed: does not overwrite what the WS already brought). On reconnect,
    // the REST list replaces the state's: it brings what changed during the outage.
    try {
      const [ms, ss] = await Promise.all([listMachines(), listSessions()])
      setState((s) => (replace ? replaceSessions(s, ms, ss) : seed(s, ms, ss)))
    } catch { /* 401 is handled by api.ts */ }
    try {
      const usage = await listUsage()
      setState((s) => setUsage(s, usage ?? [], replace))
    } catch { /* usage is optional */ }
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
      setDevApi({ listConversations: f.fixtureConversations(mode), listEvents: f.fixtureEvents(mode), history: f.fixtureHistory(mode), listCommands: f.fixtureCommands(mode) })
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
      if (c && wasConnected) { load(true); setReconnects((n) => n + 1) }
      if (c) wasConnected = true
    })
    live.current = l
    return () => l.close()
  }, [mode, load, dispatch])

  const openLaunch = (scope: { projectId?: string; workspaceId?: string } = {}) => setLaunching(scope)
  const onLaunched = (p: { reqId: string; machine: string; label: string }) => {
    const now = Date.now()
    const r = early.current.replay({ ...p, startedAt: now }, now)
    setLaunching(null)
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
  const dialog = launching && <LaunchDialog state={shown} projectId={launching.projectId} workspaceId={launching.workspaceId} onClose={() => setLaunching(null)} onLaunched={onLaunched} />
  const terminalView = terminal && (
    <LazyBoundary><Terminal key={terminal.machine + '\x00' + terminal.pane} machine={terminal.machine} pane={terminal.pane} root={terminal.root} label={terminal.label}
      onBack={back} onReopen={(pane) => go({ terminal: { ...terminal, pane } }, true)} /></LazyBoundary>
  )
  const viewerView = viewer && (
    <Viewer key={viewer.machine + '\x00' + viewer.sessionId + '\x00' + viewer.path} {...viewer}
      base={state.sessions[viewer.sessionId]?.root || state.sessions[viewer.sessionId]?.cwd || ''}
      worktrees={state.sessions[viewer.sessionId]?.worktrees} onBack={back} />
  )
  const startingView = starting && <LazyBoundary><Starting pending={pending} terminal={!!(pending && state.machines[pending.machine]?.caps?.terminal)} onBack={back} onViewTerminal={onViewTerminal} /></LazyBoundary>
  const sessionView = current && vanished.current !== current ? <LazyBoundary><Session key={viewKey} state={shown} id={current} onBack={wide ? undefined : back} onEvents={onEvents} onTrim={onTrim} onSeen={onSeen} onCommands={onCommands} reconnects={reconnects} onGuard={guardLaunch} busy={launchBusy} onViewTerminal={onViewTerminal} onOpenFile={(machine, path, o) => current && go({ viewer: { machine, sessionId: current, path, ...(o && 'images' in o ? { images: true } : o && 'read' in o ? { read: true } : {}) } })} /></LazyBoundary> : null
  const sessionsList = <Inbox state={shown} connected={connected} onOpen={openSession} onLaunch={() => openLaunch()} />
  const projectsView = <Projects state={shown} wide={wide} selected={project} onOpen={(id) => (wide ? goCentre({ kind: 'project', id }) : go({ project: id, projectTickets: null, checkouts: false, ticket: null }))} onOpenSession={openSession} onConfig={() => openConfig('')} />
  const configView = config !== null && <LazyBoundary><Config key={config} state={shown} editProject={config || null} onBack={back} /></LazyBoundary>
  const projectView = project && (
    <LazyBoundary><Project key={project} state={shown} id={project} onBack={back}
      onOpenTickets={(id) => go({ projectTickets: id })} onOpenSession={openSession} onEdit={openConfig} onTickets={onTickets} onCheckouts={onCheckouts} onConversations={onConversations}
      checkoutsOpen={checkoutsOpen} onCheckoutsOpenChange={(o) => (o ? go({ checkouts: true }) : back())}
      pending={launchBusy} onLaunched={onLaunched} onGuard={guardLaunch} onTerminal={onTerminal} /></LazyBoundary>
  )
  const ticketsView = projectTickets && (
    <LazyBoundary><ProjectTickets key={projectTickets} state={shown} id={projectTickets} selectedTicket={ticket} onBack={back}
      onOpenTicket={(id) => go({ ticket: id })} onTickets={onTickets} /></LazyBoundary>
  )
  const ticketView = ticket && (
    <LazyBoundary><TicketDetail key={ticket} state={shown} ticketId={ticket} onBack={back} onOpenSession={openSession} onLoaded={onTicket} onCheckouts={onCheckouts} onLaunched={onLaunched} /></LazyBoundary>
  )

  const toggle = mode && dev && (
    <dev.Toggle mode={mode} onChange={(m) => {
      const u = new URL(location.href)
      if (m === 'demo') u.searchParams.delete('data'); else u.searchParams.set('data', m)
      location.href = u.toString()
    }} />
  )
  if (wide) {
    // the Viewer covers the whole window, as on the phone
    if (viewerView) return <div className="app-shell">{viewerView}{dialog}{toggle}</div>
    const scroll = 'min-h-0 flex-1 overflow-y-auto'
    let page
    switch (centre.kind) {
      case 'terminal': page = <div className="min-h-0 flex-1">{terminalView}</div>; break
      case 'starting': page = <div className="min-h-0 flex-1">{startingView}</div>; break
      case 'settings': page = <div className={scroll}>{configView}</div>; break
      // project pages keep a readable line length in a wide centre
      case 'tickets': page = <div className={scroll}><div className="mx-auto w-full max-w-3xl">{ticketView || ticketsView}</div></div>; break
      case 'project': page = <div className={scroll}><div className="mx-auto w-full max-w-3xl">{projectView}</div></div>; break
      case 'session': page = <div className="min-h-0 flex-1">{sessionView}</div>; break
      default: page = <div className="min-h-0 flex-1 overflow-auto">{projectsView}</div>
    }
    return (
      <>
        <AppShell state={shown} centre={current && centre.kind === 'session' ? { kind: 'session', id: current } : centre} connected={connected}
          onOpenSession={openSession} onOpenProject={(id) => goCentre({ kind: 'project', id })}
          onLaunch={openLaunch} onSettings={() => goCentre({ kind: 'settings' })}>
          {page}
        </AppShell>
        {dialog}{toggle}
      </>
    )
  }
  // the bottom nav: Sessions and Projects replace the root page; Settings opens general settings
  const onNav = (n: NavTab) => {
    if (n === 'settings') { if (config !== '') openConfig(''); return }
    go({ tab: n, project: null, projectTickets: null, checkouts: false, ticket: null, config: null, starting: false, terminal: null, viewer: null, session: null }, true)
  }
  let view
  // the bottom nav is hidden only in a session and the Viewer
  const withNav = (page: ReactNode, active: NavTab, scroll = true) => (
    <div className="flex h-full flex-col"><div className={`min-h-0 flex-1 ${scroll ? 'overflow-y-auto' : ''}`}>{page}</div><BottomNav active={active} attention={attention} onNav={onNav} /></div>
  )
  if (viewerView) view = <div className="h-full">{viewerView}</div>
  else if (terminalView) view = withNav(terminalView, tab, false)
  else if (startingView) view = withNav(startingView, tab, false)
  else if (sessionView) view = <div className="h-full">{sessionView}</div>
  else if (configView) view = withNav(configView, 'settings')
  else if (ticketView) view = withNav(ticketView, tab)
  else if (ticketsView) view = withNav(ticketsView, tab)
  else if (projectView) view = withNav(projectView, tab)
  else if (tab === 'sessions') view = <div className="flex h-full flex-col">{sessionsList}<BottomNav active="sessions" attention={attention} onNav={onNav} /></div>
  else view = <div className="flex h-full flex-col"><PhoneHeader title="Projects" connected={connected} onLaunch={() => openLaunch()} /><div className="min-h-0 flex-1 overflow-y-auto">{projectsView}</div><BottomNav active="projects" attention={attention} onNav={onNav} /></div>
  return <div className="app-shell">{view}{dialog}{toggle}</div>
}
