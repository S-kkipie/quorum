import { useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { closeSession } from '../lib/api'
import { SESSION_STATE, since, toMs } from '../lib/projects'
import type { SessionRow } from '../lib/sessions'
import { sessionTitle } from '../lib/title'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu'

/** One row of a merged session list: a live session opens, a closed conversation is resumed. */
export default function SessionRowView({ row, project, active, disabled, detailed, onOpen, onResume }: {
  row: SessionRow
  /** Project name shown before the details (lists that mix projects). */
  project?: string
  active?: boolean
  /** A launch is in progress: closed rows cannot be resumed. */
  disabled?: boolean
  /** Live rows also show the working directory, context usage and age. */
  detailed?: boolean
  onOpen?: (id: string) => void
  onResume?: (row: Extract<SessionRow, { kind: 'closed' }>) => void
}) {
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const cls = `flex min-h-11 w-full items-center gap-3 px-3 py-1.5 text-left hover:bg-zinc-900 disabled:opacity-40 ${active ? 'bg-zinc-900' : ''}`
  if (row.kind === 'live') {
    const s = row.session
    const st = SESSION_STATE[s.state] ?? SESSION_STATE.idle
    const { title, short } = sessionTitle(s)
    const closable = s.role !== 'service'
    async function close() {
      setBusy(true)
      setError('')
      try {
        await closeSession(s.id)
        setConfirm(false)
      } catch (e) {
        setConfirm(false)
        setError(e instanceof Error ? e.message : 'error')
      } finally {
        setBusy(false)
      }
    }
    return (
      <li>
        <div className="flex items-center">
          <button onClick={() => onOpen?.(s.id)} className={`${cls} min-w-0 flex-1`}>
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${st.dot}`} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{title}</span>
              <span className="block truncate text-xs text-zinc-500">
                {project && <span className="text-zinc-400">{project} · </span>}{short} · {detailed ? s.cwd : s.machine}
              </span>
            </span>
            <span className="shrink-0 text-right text-xs">
              <span className={`block ${st.text}`}>{st.label}</span>
              {detailed && <span className="block text-zinc-600">{s.contextPct > 0 ? `${s.contextPct}% · ` : ''}{since(toMs(s.updatedAt))}</span>}
            </span>
          </button>
          {closable && (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Session actions" className="size-11 shrink-0 text-zinc-400"><MoreHorizontal /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem className="min-h-11" onSelect={() => setConfirm(true)}>Close session</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        {error && <p role="alert" className="px-3 pb-1 text-xs text-red-400">{error}</p>}
        <Dialog open={confirm} onOpenChange={setConfirm}>
          <DialogContent showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>Close session</DialogTitle>
              <DialogDescription>Close this session? Claude stops in its terminal.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" className="min-h-11" onClick={() => setConfirm(false)}>Cancel</Button>
              <Button className="min-h-11" disabled={busy} onClick={close}>Close</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </li>
    )
  }
  return (
    <li>
      <button disabled={disabled} onClick={() => onResume?.(row)} className={cls}>
        <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-zinc-700" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{row.title}</span>
          <span className="block truncate text-xs text-zinc-500">
            {project && <span className="text-zinc-400">{project} · </span>}{row.machine}
          </span>
        </span>
        <span className="shrink-0 text-xs text-zinc-500">{since(toMs(row.updatedAt))}{row.messages > 0 && ` · ${row.messages} ${row.messages === 1 ? 'message' : 'messages'}`}</span>
      </button>
    </li>
  )
}
