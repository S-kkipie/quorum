import { useEffect, useState } from 'react'
import { listConversations } from '../lib/api'
import { since } from '../lib/projects'
import type { Conversation } from '../proto.gen'

const SHOWN = 6

/** Previous conversations of the folder: open ones lead to their session, closed ones are resumed. */
export default function Conversations({ machine, root, liveIds, busy = false, outdated = false, onOpen, onResume }: {
  machine: string
  root: string
  liveIds: ReadonlySet<string>
  /** A launch is in progress: closed ones cannot be resumed. */
  busy?: boolean
  /** The machine sends no caps (old quorumd): it cannot list conversations. */
  outdated?: boolean
  onOpen: (sessionId: string) => void
  onResume: (convId: string) => void
}) {
  const [list, setList] = useState<Conversation[] | null>(null)
  const [error, setError] = useState('')
  const [all, setAll] = useState(false)
  const [q, setQ] = useState('')

  useEffect(() => {
    if (outdated) return
    let off = false
    setList(null)
    setError('')
    listConversations(machine, root).then((l) => { if (!off) setList(l ?? []) }).catch((e) => { if (!off) { setError(e instanceof Error ? e.message : 'error'); setList([]) } })
    return () => { off = true }
  }, [machine, root, outdated])

  if (outdated) return <p className="px-3 text-xs text-zinc-600">Update quorumd on this machine to see conversations</p>

  if (list === null) return <p className="px-3 text-xs text-zinc-600">Loading conversations…</p>
  if (error) return <p role="alert" className="px-3 text-xs text-red-400">{error}</p>
  if (list.length === 0) return <p className="px-3 text-xs text-zinc-600">No previous conversations on this machine</p>
  const title = (c: Conversation) => c.title || c.firstPrompt || c.id
  const needle = q.trim().toLowerCase()
  const rows = all ? list.filter((c) => !needle || title(c).toLowerCase().includes(needle)) : list.slice(0, SHOWN)
  return (
    <div>
      {all && <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by title" aria-label="Search by title" className="mx-3 mb-2 w-[calc(100%-1.5rem)] rounded border border-zinc-800 bg-zinc-900 p-2 text-sm" />}
      <ul className="divide-y divide-zinc-900 border-y border-zinc-900">
        {rows.map((c) => {
          const open = c.open || liveIds.has(c.id)
          return (
            <li key={c.id}>
              <button disabled={!open && busy} onClick={() => (open ? onOpen(c.id) : onResume(c.id))} className="flex min-h-11 w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-zinc-900 disabled:opacity-40">
                <span aria-label={open ? 'open' : undefined} className={`h-2 w-2 shrink-0 rounded-full ${open ? 'bg-emerald-500' : 'bg-transparent'}`} />
                <span className="min-w-0 flex-1 truncate">{title(c)}</span>
                <span className="shrink-0 text-xs text-zinc-500">{since(c.updatedAt)} · {c.messages} msgs</span>
              </button>
            </li>
          )
        })}
      </ul>
      {!all && list.length > SHOWN && <button onClick={() => setAll(true)} className="px-3 pt-2 text-xs text-blue-400">See all ({list.length})</button>}
    </div>
  )
}
