import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, MonitorPlay, MoreHorizontal, Plus, Square, XCircle } from 'lucide-react'
import AskCard from '../components/AskCard'
import Composer from '../components/Composer'
import QueueSection from '../components/QueueSection'
import TimelineSection from '../components/TimelineSection'
import StatePill from '../components/StatePill'
import Transcript from '../components/Transcript'
import { abortSession, closeSession, listEvents } from '../lib/api'
import { contextTone, formatTokens, toneClass } from '../lib/meters'
import { launchIn, loadPrefs } from '../lib/launch'
import type { AppState } from '../lib/store'
import { sessionTitle } from '../lib/title'
import type { Event } from '../proto.gen'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

const PAGE = 50

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

export default function Session({ state, id, onBack, onEvents, onGuard, busy = false, onViewTerminal, onOpenFile }: {
  state: AppState
  id: string
  onBack?: () => void
  onEvents: (id: string, evs: Event[]) => void
  onGuard?: (fn: () => Promise<{ reqId: string; machine: string; label: string }>) => Promise<void>
  /** A launch is in progress. */
  busy?: boolean
  onViewTerminal?: (machine: string, pane: string) => void
  /** opens a file of the session in the viewer */
  onOpenFile?: (machine: string, path: string, o?: { images: true }) => void
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
  const meters = !!(s.account || s.contextPct > 0 || tokens)
  const sub = [s.machine, s.model, s.branch].filter(Boolean).join(' · ')

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
          {!narrow && <StatePill state={s.state} />}
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
        {(sub || narrow || meters) && (
          // wraps at 320 px: pill + subtitle + account + ctx + tokens never overflow the header
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pb-1 pl-2.5 text-xs text-zinc-500">
            {narrow && <StatePill state={s.state} />}
            {sub && <span className="min-w-0 max-w-full shrink truncate">{sub}</span>}
            {s.account && <span className="max-w-24 shrink-0 truncate rounded bg-zinc-800 px-1.5 text-zinc-300">{s.account}</span>}
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
      {/* one row for the plugin sections (hidden when neither shows): Timeline and Queue side by side */}
      <div data-testid="plugin-bar" className="flex flex-wrap border-t border-zinc-800 bg-zinc-950 empty:hidden">
        <TimelineSection session={s} events={events} />
        <QueueSection session={s} events={events} />
      </div>
      <Composer session={s} />
    </div>
  )
}
