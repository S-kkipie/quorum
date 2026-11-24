import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronLeft, Loader2, MonitorPlay, MoreHorizontal, Plus, Square, XCircle } from 'lucide-react'
import AskCard from '../components/AskCard'
import Composer from '../components/Composer'
import ModelEffortSheet from '../components/ModelEffortSheet'
import StatePill from '../components/StatePill'
import Transcript from '../components/Transcript'
import { UsageInline } from '../components/UsageStrip'
import { abortSession, closeSession, listCommands, listEvents, setModel } from '../lib/api'
import { accountUsageOf, contextTone, formatTokens, toneClass } from '../lib/meters'
import { launchIn, loadPrefs } from '../lib/launch'
import { useMarkSeen } from '../lib/useMarkSeen'
import type { AppState } from '../lib/store'
import type { OpenOpts } from '../lib/timeline'
import { currentModelOption, modelLabel } from '../lib/slash'
import { sessionTitle } from '../lib/title'
import type { Event, SessionCommands } from '../proto.gen'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

const PAGE = 50
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

export default function Session({ state, id, onBack, onEvents, onSeen, onCommands, reconnects = 0, onGuard, busy = false, onViewTerminal, onOpenFile }: {
  state: AppState
  id: string
  onBack?: () => void
  onEvents: (id: string, evs: Event[]) => void
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
  const [hasMore, setHasMore] = useState(true)
  const [dismissed, setDismissed] = useState<Record<string, true>>({})
  const [failed, setFailed] = useState(false)
  const [error, setError] = useState('')
  const loading = useRef(false)
  const oldest = useRef<number | undefined>(undefined)
  oldest.current = events[0]?.seq

  const load = useCallback(async (before: number) => {
    if (loading.current) return
    loading.current = true
    try {
      setFailed(false)
      const page = await listEvents(id, before, PAGE)
      if (page.length) onEvents(id, page)
      if (page.length < PAGE) setHasMore(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'error')
      setFailed(true)
    } finally {
      loading.current = false
    }
  }, [id, onEvents])

  useEffect(() => {
    setHasMore(true)
    setError('')
    load(0)
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

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

  const [sheet, setSheet] = useState(false)
  // a model picked here: the chip spins until the mod answers with a model command card (or a timeout)
  const [pick, setPick] = useState<{ seq: number } | null>(null)
  useEffect(() => {
    if (!pick) return
    const t = setTimeout(() => setPick(null), PICK_WAIT_MS)
    return () => clearTimeout(t)
  }, [pick])

  const lastSeq = events.reduce((m, e) => Math.max(m, e.seq), 0)
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
          <div className="border-b border-zinc-800 px-1.5 py-1">
            <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back" className="size-11 shrink-0 text-zinc-400 hover:text-zinc-200"><ChevronLeft size={22} aria-hidden /></Button>
          </div>
        )}
        <div className="p-6 text-sm text-zinc-500">Session not found.</div>
      </div>
    )
  }
  const asks = Object.values(state.asks).filter((a) => a.session === id && !dismissed[a.askId])
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
  const chip = 'relative inline-flex shrink-0 items-center gap-1 rounded-full border border-zinc-700 bg-zinc-900 px-2 py-px text-zinc-300 hover:border-zinc-500 after:absolute after:-inset-y-3 after:inset-x-0 after:content-[\'\']'
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
      <header className="border-b border-zinc-800 bg-zinc-950 px-1.5 py-1">
        <div className="flex min-h-11 items-center gap-1.5">
          {onBack && (
            <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back" className="size-11 shrink-0 text-zinc-400 hover:text-zinc-200">
              <ChevronLeft size={22} aria-hidden />
            </Button>
          )}
          <div className={`min-w-0 flex-1 truncate text-[15px] font-semibold ${onBack ? '' : 'pl-1.5'}`}>{sessionTitle(s).title}</div>
          {!narrow && <StatePill session={s} />}
          {s.state === 'working' && (
            <Button variant="secondary" onClick={() => act(() => abortSession(id))} aria-label="Interrupt" title="Interrupt"
              className={narrow ? 'size-11 shrink-0' : 'min-h-11 shrink-0 gap-1 px-2.5 text-xs'}>
              <Square size={narrow ? 14 : 11} aria-hidden className="fill-current" />{!narrow && 'Interrupt'}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="More actions" className="size-11 shrink-0 text-zinc-400 hover:text-zinc-200"><MoreHorizontal size={20} aria-hidden /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem className={item} disabled={busy} onSelect={() => { act(async () => {
                const dir = s.root || s.cwd
                await onGuard?.(() => launchIn({ machine: s.machine, dir, bypass: loadPrefs(s.projectId || '_').bypass, root: !!state.machines[s.machine]?.caps?.root, projectId: s.projectId }))
              }) }}><Plus size={16} aria-hidden className="text-zinc-400" />New session here</DropdownMenuItem>
              {!closed && s.herdrPane && state.machines[s.machine]?.caps?.terminal && (
                <DropdownMenuItem className={item} onSelect={() => onViewTerminal?.(s.machine, s.herdrPane)}>
                  <MonitorPlay size={16} aria-hidden className="text-zinc-400" />View in terminal
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
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pb-1 pl-2.5 text-xs text-zinc-500">
            {narrow && <StatePill session={s} />}
            {sub && <span className="min-w-0 max-w-full shrink truncate">{sub}</span>}
            {s.account && <span className="max-w-24 shrink-0 truncate rounded bg-zinc-800 px-1.5 text-zinc-300">{s.account}</span>}
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
      {error && <p role="alert" className="bg-red-950/40 px-3 py-1 text-xs text-red-400">{error}</p>}
      <Transcript
        events={events}
        base={s.root || s.cwd}
        machine={s.machine}
        sessionId={id}
        live={state.live[id]}
        liveAgent={state.liveAgent[id]}
        working={s.state === 'working'}
        hasMore={hasMore}
        autoLoad={!failed}
        onLoadMore={() => oldest.current !== undefined && load(oldest.current)}
        onOpenFile={onOpenFile ? (path, o) => (o ? onOpenFile(s.machine, path, o) : onOpenFile(s.machine, path)) : undefined}
      />
      {asks.map((a) => <AskCard key={a.askId} session={id} ask={a} onDone={() => setDismissed((d) => ({ ...d, [a.askId]: true }))} />)}
      <Composer session={s} commands={state.commands[id]} />
      {(showModel || showEffort) && (
        <ModelEffortSheet open={sheet} onOpenChange={setSheet} options={modelOptions} current={current?.value} effort={s.effort} efforts={efforts} onPick={chooseModel} />
      )}
    </div>
  )
}
