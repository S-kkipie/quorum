import { useCallback, useEffect, useRef, useState } from 'react'
import AskCard from '../components/AskCard'
import Composer from '../components/Composer'
import Transcript from '../components/Transcript'
import { abortSession, closeSession, listEvents } from '../lib/api'
import { launchIn, loadPrefs } from '../lib/launch'
import type { AppState } from '../lib/store'
import { sessionTitle } from '../lib/title'
import type { Event } from '../proto.gen'

const PAGE = 50

export default function Session({ state, id, onBack, onEvents, onGuard, busy = false, onViewTerminal }: {
  state: AppState
  id: string
  onBack?: () => void
  onEvents: (id: string, evs: Event[]) => void
  onGuard?: (fn: () => Promise<{ reqId: string; machine: string; label: string }>) => Promise<void>
  /** Hay un lanzamiento en curso. */
  busy?: boolean
  onViewTerminal?: (machine: string, pane: string) => void
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

  if (!s) return <div className="p-6 text-sm text-zinc-500">Sesión no encontrada.</div>
  const asks = Object.values(state.asks).filter((a) => a.session === id && !dismissed[a.askId])
  const closed = s.state === 'closed'
  const btn = 'rounded bg-zinc-800 px-2 py-1 text-xs disabled:opacity-40'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
        {onBack && <button onClick={onBack} aria-label="Volver" className="text-lg text-zinc-400">‹</button>}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{sessionTitle(s).title}</div>
          <div className="truncate text-xs text-zinc-500">{s.machine} · {sessionTitle(s).short} · {s.cwd}</div>
        </div>
        <button disabled={closed} onClick={() => act(() => abortSession(id))} className={btn}>Interrumpir</button>
        <button disabled={closed} onClick={() => { if (confirm('¿Cerrar esta sesión?')) act(() => closeSession(id)) }} className={btn}>Cerrar</button>
        <div ref={menuRef} className="relative">
          <button aria-label="Más acciones" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)} className={btn}>⋯</button>
          {menu && (
            <div role="menu" className="absolute right-0 z-20 mt-1 w-48 rounded border border-zinc-800 bg-zinc-900 py-1 text-sm shadow-lg">
              <button role="menuitem" disabled={busy} onClick={() => { setMenu(false); act(async () => {
                const dir = s.root || s.cwd
                await onGuard?.(() => launchIn({ machine: s.machine, dir, bypass: loadPrefs(s.projectId || '_').bypass, root: !!state.machines[s.machine]?.caps?.root, projectId: s.projectId }))
              }) }} className="block min-h-10 w-full px-3 text-left hover:bg-zinc-800 disabled:opacity-40">Nueva sesión aquí</button>
              {!closed && s.herdrPane && state.machines[s.machine]?.caps?.terminal && (
                <button role="menuitem" onClick={() => { setMenu(false); onViewTerminal?.(s.machine, s.herdrPane) }} className="block min-h-10 w-full px-3 text-left hover:bg-zinc-800">Ver en terminal</button>
              )}
            </div>
          )}
        </div>
      </header>
      {error && <p role="alert" className="bg-red-950/40 px-3 py-1 text-xs text-red-400">{error}</p>}
      <Transcript
        events={events}
        live={state.live[id]}
        liveAgent={state.liveAgent[id]}
        hasMore={hasMore}
        autoLoad={!failed}
        onLoadMore={() => oldest.current !== undefined && load(oldest.current)}
      />
      {asks.map((a) => <AskCard key={a.askId} session={id} ask={a} onDone={() => setDismissed((d) => ({ ...d, [a.askId]: true }))} />)}
      <Composer session={s} />
    </div>
  )
}
