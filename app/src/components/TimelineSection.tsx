import { useCallback, useEffect, useRef, useState } from 'react'
import { History, Redo2, Undo2, X } from 'lucide-react'
import { pluginCommand, pluginState } from '../lib/api'
import { digest, parseTimeMachine, type TmTimeline } from '../lib/timemachine'
import { since } from '../lib/projects'
import type { Event, SessionInfo } from '../proto.gen'
import { Button } from '@/components/ui/button'
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'

const lastTurnEnd = (events: Event[]) => events.reduce((m, e) => (e.kind === 'turn_end' && e.seq > m ? e.seq : m), 0)
const NO_MOVE = 'The timeline did not move. Claude may be working; try again when it finishes.'
const GONE = 'This state no longer exists. The list was refreshed.'
const UNREADABLE = 'Could not read the timeline.'

/** Whether undo/redo can move: the cursor's place among the states (oldest first; no cursor = the newest). */
function moves(t: TmTimeline): { undo: boolean; redo: boolean } {
  const last = t.states.length - 1
  const i = t.cursor == null ? last : t.states.findIndex((s) => s.id === t.cursor)
  if (i < 0) return { undo: true, redo: true } // unknown cursor: let the plugin decide
  return { undo: i > 0, redo: i < last }
}

/** The time-machine plugin's states for the session: view them and move between them. Hidden without the plugin or its state. */
export default function TimelineSection({ session, events }: { session: SessionInfo; events: Event[] }) {
  const id = session.id
  const enabled = (session.plugins ?? []).includes('time-machine')
  const working = session.state === 'working'
  const [t, setT] = useState<TmTimeline | null>(null)
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [error, setError] = useState('')
  const alive = useRef(true)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  const read = useCallback(async (): Promise<TmTimeline | null> => {
    try {
      const next = parseTimeMachine(await pluginState(id, 'time-machine'))
      if (alive.current) setT(next)
      return next
    } catch { return null /* keep what is shown */ }
  }, [id])

  useEffect(() => {
    alive.current = true
    if (enabled) void read()
    return () => { alive.current = false; timers.current.forEach(clearTimeout); timers.current = [] }
  }, [enabled, read])

  // A finished turn adds a state (or the timeline may have just appeared): read again even while
  // closed, so the header count stays true.
  const seen = useRef(lastTurnEnd(events))
  const turn = lastTurnEnd(events)
  useEffect(() => {
    if (turn <= seen.current) return
    seen.current = turn
    if (enabled) void read()
  }, [turn, enabled, read])

  if (!enabled || !t || t.states.length === 0) return null

  async function run(args: string, before: number | null) {
    setError('')
    try {
      await pluginCommand(id, 'timeline', args)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not send')
      return
    }
    timers.current.forEach(clearTimeout)
    timers.current = [
      setTimeout(() => { void read() }, 1000),
      setTimeout(() => { void read().then((n) => { if (n && alive.current && n.cursor === before) setError(NO_MOVE) }) }, 3000),
    ]
  }

  // Read right before moving: the move is checked, and later compared, against the fresh cursor
  async function step(args: 'undo' | 'redo') {
    setError('')
    const fresh = await read()
    if (!fresh) { setError(UNREADABLE); return }
    if (!moves(fresh)[args]) return // nothing to move to: the buttons now show it
    await run(args, fresh.cursor)
  }

  // The plugin takes the state's id, so resolve it from the freshly read list before sending
  async function goTo(stateId: number) {
    setError('')
    const fresh = await read()
    if (!fresh) { setError(UNREADABLE); return }
    if (!fresh.states.some((s) => s.id === stateId)) { setError(GONE); return }
    await run(String(stateId), fresh.cursor)
  }

  const btn = 'min-h-11 px-3 text-sm'
  const list = [...t.states].reverse()
  const can = moves(t)
  return (
    <Sheet open={open} onOpenChange={(o) => { setOpen(o); if (o) void read() }}>
      {/* a compact button in the session's plugin bar, next to Queue */}
      <SheetTrigger className="flex min-h-11 min-w-0 flex-1 items-center justify-center gap-1.5 px-3 text-sm text-zinc-300 [&:not(:last-child)]:border-r [&:not(:last-child)]:border-zinc-800" aria-label={`Timeline (${t.states.length})`}>
        <History size={16} aria-hidden className="shrink-0 text-zinc-500" />
        <span aria-hidden>Timeline</span>
        <span aria-hidden className="text-zinc-500">{t.states.length}</span>
      </SheetTrigger>
      <SheetContent side="bottom" showCloseButton={false} className="max-h-[85dvh] gap-0 border-zinc-800 bg-zinc-950 text-zinc-200">
        <SheetHeader className="flex-row items-center justify-between gap-2 p-3 pb-1">
          <div className="min-w-0">
            <SheetTitle>Timeline</SheetTitle>
            <SheetDescription className="sr-only">States of the files, turn by turn</SheetDescription>
          </div>
          <SheetClose className="flex size-11 shrink-0 items-center justify-center rounded text-zinc-400" aria-label="Close"><X size={18} aria-hidden /></SheetClose>
        </SheetHeader>
        <div className="flex flex-wrap items-center gap-2 px-3 pb-2">
          <Button size="sm" variant="secondary" className={btn} disabled={working || !can.undo} onClick={() => { void step('undo') }}><Undo2 size={14} aria-hidden />Undo</Button>
          <Button size="sm" variant="secondary" className={btn} disabled={working || !can.redo} onClick={() => { void step('redo') }}><Redo2 size={14} aria-hidden />Redo</Button>
          {working && <span className="text-xs text-zinc-500">Wait until Claude finishes</span>}
        </div>
        {error && <p role="alert" className="break-words px-3 pb-2 text-xs text-red-400">{error}</p>}
        <ol className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-4">
          {list.map((s) => {
            const current = s.id === t.cursor
            const isOpen = expanded === s.id
            return (
              <li key={s.id} data-testid="timeline-row" className={`rounded border px-2 ${current ? 'border-blue-500/60 bg-blue-950/20' : 'border-zinc-800'}`}>
                <button type="button" aria-expanded={isOpen} onClick={() => setExpanded(isOpen ? null : s.id)} className="flex min-h-11 w-full items-start gap-2 py-2 text-left text-sm">
                  <span className="min-w-0 flex-1">
                    <span data-testid="timeline-label" className={`text-zinc-200 [overflow-wrap:anywhere] ${isOpen ? 'block' : 'line-clamp-2'}`}>{s.label}</span>
                    <span className="block text-xs text-zinc-500"><span>{since(s.at)}</span> · <span>{digest(s.files)}</span></span>
                  </span>
                  {current && <span className="mt-0.5 shrink-0 rounded bg-blue-600/30 px-1.5 text-xs text-blue-200">Current</span>}
                </button>
                {isOpen && (
                  <div className="space-y-1 pb-2">
                    {s.files.map((f, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs text-zinc-400">
                        <span className="w-4 shrink-0 text-zinc-500">{f.status}</span>
                        <span className="min-w-0 flex-1 break-all">{f.path}</span>
                        <span className="shrink-0">+{f.added} −{f.removed}</span>
                      </div>
                    ))}
                    {!current && <Button size="sm" className={btn} disabled={working} onClick={() => { void goTo(s.id) }}>Go to this state</Button>}
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      </SheetContent>
    </Sheet>
  )
}
