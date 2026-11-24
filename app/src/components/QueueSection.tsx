import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, MoreHorizontal } from 'lucide-react'
import { pluginCommand, pluginState, type PluginCommandName } from '../lib/api'
import { addArgs, parseQueue, taskTextError, type AfterQueueState, type QueueItem } from '../lib/afterQueue'
import { onPluginStateChanged } from '../lib/pluginBus'
import type { Event, SessionInfo } from '../proto.gen'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Textarea } from '@/components/ui/textarea'
import { Spinner } from '@/components/ui/spinner'

const lastTurnEnd = (events: Event[]) => events.reduce((m, e) => (e.kind === 'turn_end' && e.seq > m ? e.seq : m), 0)
const GONE = 'This task is no longer in the queue. The list was refreshed.'
const UNREADABLE = 'Could not read the queue.'
// the same task in another read: by its id, or by its text when the plugin gave none
const sameTask = (a: QueueItem, b: QueueItem) => (a.id != null || b.id != null ? a.id === b.id : a.text === b.text)

/** The after plugin's task queue for the session: view and drive it. Hidden without the plugin or its state. */
export default function QueueSection({ session, events }: { session: SessionInfo; events: Event[] }) {
  const id = session.id
  const enabled = (session.plugins ?? []).includes('after')
  const [q, setQ] = useState<AfterQueueState | null>(null)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const [text, setText] = useState('')
  const [editing, setEditing] = useState<{ item: QueueItem; text: string } | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const alive = useRef(true)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  const refresh = useCallback(async (): Promise<AfterQueueState | null> => {
    try {
      const next = parseQueue(await pluginState(id, 'after'))
      if (alive.current) setQ(next)
      return next
    } catch { return null /* keep what is shown */ }
  }, [id])

  // The plugin applies a command a moment later: read again at 1 s and 3 s.
  const refreshSoon = useCallback(() => {
    timers.current.forEach(clearTimeout)
    timers.current = [1000, 3000].map((ms) => setTimeout(() => { void refresh() }, ms))
  }, [refresh])

  useEffect(() => {
    alive.current = true
    if (enabled) void refresh()
    return () => { alive.current = false; timers.current.forEach(clearTimeout); timers.current = [] }
  }, [enabled, refresh])

  // The composer queued a task with /after
  useEffect(() => {
    if (!enabled) return
    return onPluginStateChanged((sid, plugin) => { if (sid === id && plugin === 'after') refreshSoon() })
  }, [enabled, id, refreshSoon])

  // A turn that ended may have started the next task (or the queue may have just appeared): read
  // again even while collapsed or hidden, so the header count stays true.
  const seen = useRef(lastTurnEnd(events))
  const turn = lastTurnEnd(events)
  useEffect(() => {
    if (turn <= seen.current) return
    seen.current = turn
    if (enabled) void refresh()
  }, [turn, enabled, refresh])

  if (!enabled || !q) return null

  async function run(command: PluginCommandName, args: string): Promise<boolean> {
    setError('')
    try {
      await pluginCommand(id, command, args)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not send')
      return false
    }
    refreshSoon()
    return true
  }

  async function add(command: 'after' | 'before') {
    const bad = taskTextError(text)
    if (bad) { setError(bad); return }
    if (await run(command, addArgs(text))) setText('')
  }

  // The plugin takes 1-based positions, which move as tasks run: resolve the task's position from
  // a fresh read right before sending, and send nothing when it is gone.
  async function onTask(item: QueueItem, args: (n: number) => string): Promise<boolean> {
    setError('')
    const fresh = await refresh()
    if (!fresh) { setError(UNREADABLE); return false }
    const i = fresh.items.findIndex((x) => sameTask(x, item))
    if (i < 0) { setError(GONE); setEditing(null); return false }
    return run('after', args(i + 1))
  }

  async function save() {
    if (!editing) return
    const bad = taskTextError(editing.text)
    if (bad) { setError(bad); return }
    const t = editing.text.trim()
    if (await onTask(editing.item, (n) => `edit ${n} ${t}`)) setEditing(null)
  }

  const btn = 'min-h-11 px-3 text-sm'
  return (
    // `contents`: the trigger is a compact button in the session's plugin bar (a wrapping flex row,
    // next to Timeline) and the panel takes a full line below it
    <Collapsible open={open} onOpenChange={(o) => { setOpen(o); if (o) void refresh() }} className="contents">
      <CollapsibleTrigger className="flex min-h-11 min-w-0 flex-1 items-center justify-center gap-1.5 px-3 text-sm text-zinc-300" aria-label={`Queue (${q.items.length})`}>
        <span aria-hidden>Queue</span>
        <span aria-hidden className="text-zinc-500">{q.items.length}</span>
        <ChevronDown size={16} aria-hidden className={`shrink-0 text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </CollapsibleTrigger>
      <CollapsibleContent className="order-last max-h-[40dvh] w-full basis-full space-y-2 overflow-y-auto border-t border-zinc-800 px-3 py-2">
        {session.state === 'working' && <p className="text-xs text-zinc-500">Changes apply when Claude finishes this turn.</p>}
        {error && <p role="alert" className="break-words text-xs text-red-400">{error}</p>}
        {q.running && (
          <div className="flex min-h-11 items-start gap-2 text-sm text-zinc-200">
            <Spinner className="mt-0.5 shrink-0 text-blue-400" />
            <span className="min-w-0 break-words">{q.running.text}</span>
          </div>
        )}
        <ol className="space-y-1">
          {q.items.map((it, i) => (
            <li key={it.id ?? i} className="flex min-h-11 items-start gap-2 text-sm text-zinc-300">
              <span data-testid="queue-number" className="mt-0.5 w-6 shrink-0 text-right text-zinc-500">{i + 1}</span>
              {editing && sameTask(editing.item, it) ? (
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <Textarea rows={2} aria-label="Edit task" value={editing.text} onChange={(e) => setEditing({ item: editing.item, text: e.target.value })} className="min-h-11 text-sm" />
                  <div className="flex gap-2">
                    <Button size="sm" className={btn} onClick={save}>Save</Button>
                    <Button size="sm" variant="ghost" className={btn} onClick={() => setEditing(null)}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <>
                  <span className="min-w-0 flex-1 break-words">{it.text}</span>
                  <DropdownMenu modal={false}>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" aria-label="Item actions" className="size-11 shrink-0 text-zinc-400"><MoreHorizontal size={18} aria-hidden /></Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem className="min-h-11 px-3" onSelect={() => setEditing({ item: it, text: it.text })}>Edit</DropdownMenuItem>
                      <DropdownMenuItem className="min-h-11 px-3" onSelect={() => { void onTask(it, (n) => `top ${n}`) }}>Move to top</DropdownMenuItem>
                      <DropdownMenuItem variant="destructive" className="min-h-11 px-3" onSelect={() => { void onTask(it, (n) => `rm ${n}`) }}>Remove</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              )}
            </li>
          ))}
        </ol>
        <Textarea rows={2} aria-label="New task" value={text} onChange={(e) => setText(e.target.value)} placeholder="New task" className="min-h-11 text-sm" />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" className={btn} onClick={() => add('after')}>Add after</Button>
          <Button size="sm" variant="secondary" className={btn} onClick={() => add('before')}>Add before</Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" className={btn} onClick={() => { void run('after', q.paused ? 'resume' : 'pause') }}>{q.paused ? 'Resume' : 'Pause'}</Button>
          <Button size="sm" variant="secondary" className={btn} onClick={() => { void run('after', 'undo') }}>Undo</Button>
          {confirmClear ? (
            <>
              <span className="text-sm text-zinc-300">Clear the queue?</span>
              <Button size="sm" variant="destructive" aria-label="Confirm clear" className={btn} onClick={() => { setConfirmClear(false); void run('after', 'clear') }}>Yes</Button>
              <Button size="sm" variant="ghost" className={btn} onClick={() => setConfirmClear(false)}>No</Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" className={`${btn} text-red-300`} onClick={() => setConfirmClear(true)}>Clear</Button>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
