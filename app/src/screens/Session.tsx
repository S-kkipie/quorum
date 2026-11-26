import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronLeft, Loader2, MonitorPlay, MoreHorizontal, PanelRight, Plus, Square, XCircle } from 'lucide-react'
import AskCard from '../components/AskCard'
import Composer from '../components/Composer'
import ModelEffortSheet from '../components/ModelEffortSheet'
import BackgroundSheet from '../components/BackgroundSheet'
import StatePill from '../components/StatePill'
import Inspector from '../components/inspector/Inspector'
import Transcript from '../components/Transcript'
import { UsageInline } from '../components/UsageStrip'
import { artifactPath } from '../lib/artifacts'
import { abortSession, hubUrl, closeSession, listCommands, setModel } from '../lib/api'
import { accountUsageOf, contextTone, formatTokens, toneClass } from '../lib/meters'
import { launchIn, loadPrefs } from '../lib/launch'
import { shortcutBlocked } from '../lib/shortcuts'
import { useLayout } from '../lib/useLayout'
import { useMarkSeen } from '../lib/useMarkSeen'
import { useSessionEvents, type Trim } from '../lib/useSessionEvents'
import type { AppState } from '../lib/store'
import type { OpenOpts } from '../lib/timeline'
import { currentModelOption, modelLabel } from '../lib/slash'
import { sessionTitle } from '../lib/title'
import type { Event, SessionCommands } from '../proto.gen'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

/** A model switch with no answer from the mod by then stops spinning (an older mod emits no card). */
const PICK_WAIT_MS = 20_000

/**
 * A `queued` model command older than this no longer spins the chip (the mod always sends a final
 * status, but a lost one must not leave it spinning forever).
 */
const QUEUED_MAX_MS = 2 * 60_000

/** The latest status of the most recent model command (set_model), if any. */
function modelCommand(events: Event[]): { seq: number; ts: number; status: string } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.kind === 'command' && e.data?.name === 'model') return { seq: e.seq, ts: e.ts, status: String(e.data.status ?? '') }
  }
  return undefined
}

/** True below the Tailwind `sm` breakpoint (640 px). */
function useNarrow() {
  const q = '(max-width: 639px)'
  const [narrow, setNarrow] = useState(() => !!window.matchMedia?.(q).matches)
  useEffect(() => {
    const m = window.matchMedia?.(q)
    if (!m) return
    const h = () => setNarrow(m.matches)
    m.addEventListener('change', h)
    return () => m.removeEventListener('change', h)
  }, [])
  return narrow
}

export default function Session({ state, id, onBack, onEvents, onTrim, onSeen, onCommands, reconnects = 0, onGuard, busy = false, onViewTerminal, onOpenFile }: {
  state: AppState
  id: string
  onBack?: () => void
  onEvents: (id: string, evs: Event[]) => void
  /** Drops events of the session from memory (store.trimEvents). */
  onTrim?: (id: string, o: Trim) => void
  /** The session was marked seen (clears unread locally before the hub answers). */
  onSeen?: (id: string) => void
  /** A GET of the command list answered; `rev` is commandsRev[id] read before it was sent (store.loadCommands). */
  onCommands?: (sc: SessionCommands, rev: number | undefined) => void
  /** Counts live feed reconnects: each one re-reads the command list (it may have changed meanwhile). */
  reconnects?: number
  onGuard?: (fn: () => Promise<{ reqId: string; machine: string; label: string }>) => Promise<void>
  /** A launch is in progress. */
  busy?: boolean
  onViewTerminal?: (machine: string, pane: string) => void
  /** opens a file of the session in the viewer */
  onOpenFile?: (machine: string, path: string, o?: OpenOpts) => void
}) {
  const s = state.sessions[id]
  const narrow = useNarrow()
  const events = state.events[id] ?? []
  const [dismissed, setDismissed] = useState<Record<string, true>>({})
  const { hasMore, loading, notice, error, setError, failed, loadOlder, setAtBottom, lastSeq: newestSeq, restoreFailed, retryNewest } = useSessionEvents({ id, events, reconnects, onEvents, onTrim })

  // The command list is not in the snapshot: read it on open and after every reconnect of the live
  // feed (envelopes sent during the outage are lost). The revision is taken before the request so
  // a live session_commands envelope that lands meanwhile wins over this answer.
  const latest = useRef({ state, onCommands })
  latest.current = { state, onCommands }
  useEffect(() => {
    let off = false
    const rev = latest.current.state.commandsRev[id]
    listCommands(id).then((sc) => { if (!off && sc) latest.current.onCommands?.(sc, rev) }).catch(() => { /* an older hub: no list */ })
    return () => { off = true }
  }, [id, reconnects])

  const layout = useLayout()
  const toggleRef = useRef<HTMLButtonElement>(null)
  // Ctrl/Cmd+. toggles the inspector (not while a modal dialog is open)
  const toggle = useRef(layout.toggleInspector)
  toggle.current = layout.toggleInspector
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key === '.' && !shortcutBlocked(e)) { e.preventDefault(); toggle.current() }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])
  const [sheet, setSheet] = useState(false)
  const [bgSheet, setBgSheet] = useState(false)
  const [wantAgent, setWantAgent] = useState<{ id: string; n: number }>()
  // a background row whose task left the live items (or whose session is closed) stopped without a task_end;
  // older mods (no items) and working sessions (the list may lag) keep rows running
  const bgItems = s?.background?.items
  const bgState = s?.state
  const bgEnded = useCallback((taskId: string) => bgState === 'closed' || (bgItems !== undefined && bgState !== 'working' && !bgItems.some((i) => i.id === taskId)), [bgItems, bgState])
  // a model picked here: the chip spins until the mod answers with a model command card (or a timeout)
  const [pick, setPick] = useState<{ seq: number } | null>(null)
  useEffect(() => {
    if (!pick) return
    const t = setTimeout(() => setPick(null), PICK_WAIT_MS)
    return () => clearTimeout(t)
  }, [pick])

  // the newest hub seq, also when the newest events were dropped from memory while scrolled up
  const lastSeq = events.reduce((m, e) => Math.max(m, e.seq), newestSeq)
  const modelCmd = modelCommand(events)
  // a queued model command spins the chip until it is QUEUED_MAX_MS old (a re-render at that age)
  const queuedLeft = modelCmd?.status === 'queued' ? modelCmd.ts + QUEUED_MAX_MS - Date.now() : 0
  const [, setTick] = useState(0)
  useEffect(() => {
    if (queuedLeft <= 0) return
    const t = setTimeout(() => setTick((n) => n + 1), queuedLeft + 1)
    return () => clearTimeout(t)
  }, [modelCmd?.seq, queuedLeft > 0]) // eslint-disable-line react-hooks/exhaustive-deps
  useMarkSeen(id, lastSeq, !!s && s.state !== 'closed', onSeen)

  const act = async (f: () => Promise<unknown>) => {
    setError('')
    try { await f() } catch (e) { setError(e instanceof Error ? e.message : 'error') }
  }

  if (!s) {
    return (
      <div className="flex h-full flex-col">
        {onBack && (
          <div className="border-b border-line px-1.5 py-1">
            <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back" className="size-11 shrink-0 text-muted-foreground hover:text-ink"><ChevronLeft size={22} aria-hidden /></Button>
          </div>
        )}
        <div className="p-6 text-sm text-muted-foreground">Session not found.</div>
      </div>
    )
  }
  const asks = Object.values(state.asks).filter((a) => a.session === id && !dismissed[a.askId])
  const dismissAsk = (askId: string) => setDismissed((d) => ({ ...d, [askId]: true }))
  const closed = s.state === 'closed'
  const item = 'min-h-11 gap-2.5 px-3'
  const ctxTone = contextTone(s.contextPct)
  const tokens = s.tokens && s.tokens.in + s.tokens.out > 0 ? `↑${formatTokens(s.tokens.in)} ↓${formatTokens(s.tokens.out)}` : ''
  const usage = accountUsageOf(state.usage, s)
  const meters = !!(s.account || usage || s.contextPct > 0 || tokens)
  const modelOptions = s.modelOptions ?? []
  const efforts = s.effortOptions ?? []
  const current = currentModelOption(modelOptions, s.model)
  const showModel = modelOptions.length > 0
  const showEffort = efforts.length > 0 && !!s.effort
  const sub = [s.machine, showModel ? '' : s.model, s.branch].filter(Boolean).join(' · ')
  // the exact option's own label (e.g. "Opus (1M context)"), else a short name for a full model id
  const modelText = current && current.value === s.model ? current.label : modelLabel(s.model) || 'Model'
  const answered = !!pick && !!modelCmd && modelCmd.seq > pick.seq && modelCmd.status !== 'queued'
  const spinning = queuedLeft > 0 || (!!pick && !answered)
  const chip = 'press relative inline-flex shrink-0 items-center gap-1 rounded-lg bg-chip px-2 py-0.5 text-ink hover:bg-line after:absolute after:-inset-y-3 after:inset-x-0 after:content-[\'\']'
  const chooseModel = (value: string) => {
    setSheet(false)
    if (value === current?.value) return
    setPick({ seq: lastSeq })
    act(async () => {
      try { await setModel(id, value) } catch (e) { setPick(null); throw e }
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-line bg-background px-1.5 py-1">
        <div className="flex min-h-11 items-center gap-1.5">
          {onBack && (
            <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back" className="size-11 shrink-0 text-muted-foreground hover:text-ink">
              <ChevronLeft size={22} aria-hidden />
            </Button>
          )}
          <div className={`min-w-0 flex-1 truncate text-[15px] font-semibold ${onBack ? '' : 'pl-1.5'}`}>{sessionTitle(s).title}</div>
          {!narrow && <StatePill session={s} onPress={() => setBgSheet(true)} />}
          {s.state === 'working' && (
            <Button variant="secondary" onClick={() => act(() => abortSession(id))} aria-label="Interrupt" title="Interrupt"
              className={narrow ? 'size-11 shrink-0' : 'min-h-11 shrink-0 gap-1 px-2.5 text-xs'}>
              <Square size={narrow ? 14 : 11} aria-hidden className="fill-current" />{!narrow && 'Interrupt'}
            </Button>
          )}
          <Button ref={toggleRef} variant="ghost" size="icon" onClick={layout.toggleInspector} aria-label="Inspector" aria-pressed={layout.inspectorOpen} title="Inspector (Ctrl+.)"
            className="size-11 shrink-0 text-muted-foreground hover:text-ink"><PanelRight size={20} aria-hidden /></Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="More actions" className="size-11 shrink-0 text-muted-foreground hover:text-ink"><MoreHorizontal size={20} aria-hidden /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem className={item} disabled={busy} onSelect={() => { act(async () => {
                const dir = s.root || s.cwd
                await onGuard?.(() => launchIn({ machine: s.machine, dir, bypass: loadPrefs(s.projectId || '_').bypass, root: !!state.machines[s.machine]?.caps?.root, projectId: s.projectId }))
              }) }}><Plus size={16} aria-hidden className="text-muted-foreground" />New session here</DropdownMenuItem>
              {!closed && s.herdrPane && state.machines[s.machine]?.caps?.terminal && (
                <DropdownMenuItem className={item} onSelect={() => onViewTerminal?.(s.machine, s.herdrPane)}>
                  <MonitorPlay size={16} aria-hidden className="text-muted-foreground" />View in terminal
                </DropdownMenuItem>
              )}
              {!closed && (
                <DropdownMenuItem variant="destructive" className={item} onSelect={() => { if (confirm('Close this session?')) act(() => closeSession(id)) }}>
                  <XCircle size={16} aria-hidden />Close session
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {(sub || narrow || meters || showModel || showEffort) && (
          // wraps at 320 px: pill + subtitle + account + usage + ctx + tokens never overflow the header
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pb-1 pl-2.5 text-xs text-muted-foreground">
            {narrow && <StatePill session={s} onPress={() => setBgSheet(true)} />}
            {sub && <span className="min-w-0 max-w-full shrink truncate">{sub}</span>}
            {s.account && <span className="max-w-24 shrink-0 truncate rounded-lg bg-chip px-2 py-0.5 text-muted-foreground">{s.account}</span>}
            {showModel && (
              <button type="button" aria-label={`Model: ${modelText}`} aria-busy={spinning} onClick={() => setSheet(true)} className={`${chip} max-w-40`}>
                <span className="min-w-0 truncate">{modelText}</span>
                {spinning ? <Loader2 size={12} aria-hidden className="shrink-0 animate-spin" /> : <ChevronDown size={12} aria-hidden className="shrink-0" />}
              </button>
            )}
            {showEffort && (
              <button type="button" aria-label={`Effort: ${s.effort}`} onClick={() => setSheet(true)} className={chip}>
                {`effort: ${s.effort}`}<ChevronDown size={12} aria-hidden />
              </button>
            )}
            {usage && <UsageInline usage={usage} />}
            {s.contextPct > 0 && <span data-tone={ctxTone} className={`shrink-0 ${toneClass[ctxTone]}`}>{`ctx ${s.contextEstimate ? '~' : ''}${Math.round(s.contextPct)}%`}</span>}
            {tokens && <span className="shrink-0">{tokens}</span>}
          </div>
        )}
      </header>
      <div className="relative flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
      {error && (
        <p role="alert" className="flex items-center gap-2 bg-del-soft px-3 py-1 text-xs text-danger">
          <span className="min-w-0 flex-1">{error}</span>
          {restoreFailed && <button type="button" onClick={retryNewest} className="min-h-11 shrink-0 px-2 font-medium hover:underline">Try again</button>}
        </p>
      )}
      <Transcript
        events={events}
        base={s.root || s.cwd}
        worktrees={s.worktrees}
        machine={s.machine}
        sessionId={id}
        live={state.live[id]}
        liveAgent={state.liveAgent[id]}
        working={s.state === 'working'}
        bgEnded={bgEnded}
        asks={asks}
        onAskDone={dismissAsk}
        hasMore={hasMore}
        loading={loading}
        notice={notice}
        autoLoad={!failed}
        onLoadMore={loadOlder}
        onAtBottom={setAtBottom}
        openAgent={wantAgent}
        onOpenFile={onOpenFile ? (path, o) => (o ? onOpenFile(s.machine, path, o) : onOpenFile(s.machine, path)) : undefined}
      />
      {asks.map((a) => <AskCard key={a.askId} session={id} ask={a} onDone={() => dismissAsk(a.askId)} />)}
      <Composer session={s} commands={state.commands[id]} />
      </div>
      <Inspector placement={layout.inspector} open={layout.inspectorOpen} onClose={layout.toggleInspector} ignore={toggleRef}
        session={s} usage={usage} events={events} hasMore={hasMore}
        // a floating inspector would cover the subagent's screen: it closes, a docked one stays
        onOpenAgent={(aid) => { setWantAgent((w) => ({ id: aid, n: (w?.n ?? 0) + 1 })); if (layout.inspector !== 'docked' && layout.inspectorOpen) layout.toggleInspector() }}
        // the old /v/ token may be gone (hub restart, expiry): open the file in the Viewer, which mints a fresh link
        onOpenArtifact={(l) => {
          const file = artifactPath(l.url, s.root || s.cwd)
          if (file && onOpenFile) onOpenFile(s.machine, file)
          else window.open(/^https?:/.test(l.url) ? l.url : hubUrl() + l.url, '_blank', 'noopener')
        }} />
      </div>
      <BackgroundSheet open={bgSheet} onOpenChange={setBgSheet} background={s.background} />
      {(showModel || showEffort) && (
        <ModelEffortSheet open={sheet} onOpenChange={setSheet} options={modelOptions} current={current?.value} effort={s.effort} efforts={efforts} onPick={chooseModel} />
      )}
    </div>
  )
}
