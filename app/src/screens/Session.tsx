import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, MonitorPlay, MoreHorizontal, Plus, Square, XCircle } from 'lucide-react'
import AskCard from '../components/AskCard'
import Composer from '../components/Composer'
import StatePill from '../components/StatePill'
import Transcript from '../components/Transcript'
import { abortSession, closeSession, listEvents } from '../lib/api'
import { launchIn, loadPrefs } from '../lib/launch'
import type { AppState } from '../lib/store'
import { sessionTitle } from '../lib/title'
import type { Event } from '../proto.gen'

const PAGE = 50

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
  onOpenFile?: (machine: string, path: string) => void
}) {
  const s = state.sessions[id]
  const events = state.events[id] ?? []
  const [hasMore, setHasMore] = useState(true)
  const [dismissed, setDismissed] = useState<Record<string, true>>({})
  const [failed, setFailed] = useState(false)
  const [error, setError] = useState('')
  const [menu, setMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
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

  useEffect(() => {
    if (!menu) return
    const down = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false) }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key) }
  }, [menu])

  const act = async (f: () => Promise<unknown>) => {
    setError('')
    try { await f() } catch (e) { setError(e instanceof Error ? e.message : 'error') }
  }

  if (!s) return <div className="p-6 text-sm text-zinc-500">Session not found.</div>
  const asks = Object.values(state.asks).filter((a) => a.session === id && !dismissed[a.askId])
  const closed = s.state === 'closed'
  const item = 'flex min-h-11 w-full items-center gap-2.5 px-3 text-left hover:bg-zinc-800 disabled:opacity-40'
  const sub = [s.machine, s.model, s.branch].filter(Boolean).join(' · ')

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-zinc-800 bg-zinc-950 px-1.5 py-1">
        <div className="flex min-h-11 items-center gap-1.5">
          {onBack && (
            <button onClick={onBack} aria-label="Back" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-200">
              <ChevronLeft size={22} aria-hidden />
            </button>
          )}
          <div className={`min-w-0 flex-1 truncate text-[15px] font-semibold ${onBack ? '' : 'pl-1.5'}`}>{sessionTitle(s).title}</div>
          <StatePill state={s.state} />
          {s.state === 'working' && (
            <button onClick={() => act(() => abortSession(id))}
              className="flex min-h-11 shrink-0 items-center gap-1 rounded-lg bg-zinc-800 px-2.5 text-xs text-zinc-200 hover:bg-zinc-700">
              <Square size={11} aria-hidden className="fill-current" />Interrupt
            </button>
          )}
          <div ref={menuRef} className="relative shrink-0">
            <button aria-label="More actions" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)}
              className="flex h-11 w-11 items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-200">
              <MoreHorizontal size={20} aria-hidden />
            </button>
            {menu && (
              <div role="menu" className="absolute right-0 z-20 mt-1 w-56 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 py-1 text-sm shadow-xl">
                <button role="menuitem" disabled={busy} onClick={() => { setMenu(false); act(async () => {
                  const dir = s.root || s.cwd
                  await onGuard?.(() => launchIn({ machine: s.machine, dir, bypass: loadPrefs(s.projectId || '_').bypass, root: !!state.machines[s.machine]?.caps?.root, projectId: s.projectId }))
                }) }} className={item}><Plus size={16} aria-hidden className="text-zinc-400" />New session here</button>
                {!closed && s.herdrPane && state.machines[s.machine]?.caps?.terminal && (
                  <button role="menuitem" onClick={() => { setMenu(false); onViewTerminal?.(s.machine, s.herdrPane) }} className={item}>
                    <MonitorPlay size={16} aria-hidden className="text-zinc-400" />View in terminal
                  </button>
                )}
                {!closed && (
                  <button role="menuitem" onClick={() => { setMenu(false); if (confirm('Close this session?')) act(() => closeSession(id)) }} className={`${item} text-red-400`}>
                    <XCircle size={16} aria-hidden />Close session
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
        {sub && <div className="truncate pb-1 pl-2.5 text-xs text-zinc-500">{sub}</div>}
      </header>
      {error && <p role="alert" className="bg-red-950/40 px-3 py-1 text-xs text-red-400">{error}</p>}
      <Transcript
        events={events}
        base={s.root || s.cwd}
        machine={s.machine}
        live={state.live[id]}
        liveAgent={state.liveAgent[id]}
        hasMore={hasMore}
        autoLoad={!failed}
        onLoadMore={() => oldest.current !== undefined && load(oldest.current)}
        onOpenFile={onOpenFile ? (path) => onOpenFile(s.machine, path) : undefined}
      />
      {asks.map((a) => <AskCard key={a.askId} session={id} ask={a} onDone={() => setDismissed((d) => ({ ...d, [a.askId]: true }))} />)}
      <Composer session={s} />
    </div>
  )
}
