import { useEffect, useState } from 'react'
import ProjectSessions from '../components/ProjectSessions'
import NewSessionCard from '../components/NewSessionCard'
import { MoreHorizontal } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { listCheckouts, listTickets, syncProject, type TicketView } from '../lib/api'
import { launchIn, loadPrefs } from '../lib/launch'
import { projectCheckouts, since } from '../lib/projects'
import type { AppState } from '../lib/store'
import type { SessionRow } from '../lib/sessions'
import type { Checkout, Conversation } from '../proto.gen'

export default function Project({ state, id, onBack, onOpenTickets, onOpenSession, onEdit, onTickets, onCheckouts, onConversations, checkoutsOpen, onCheckoutsOpenChange, pending = false, onLaunched, onGuard, onTerminal }: {
  state: AppState
  id: string
  onBack?: () => void
  onOpenTickets?: (projectId: string) => void
  onOpenSession?: (id: string) => void
  onEdit?: (id: string) => void
  onTickets?: (projectId: string, views: TicketView[]) => void
  onCheckouts?: (projectId: string, cos: Checkout[]) => void
  onConversations?: (machine: string, root: string, list: Conversation[]) => void
  /** Checkouts sheet (its state lives in the app's navigation so Back closes it). */
  checkoutsOpen?: boolean
  onCheckoutsOpenChange?: (open: boolean) => void
  /** A launch is in progress (waiting for the session to register). */
  pending?: boolean
  onLaunched?: (p: { reqId: string; machine: string; label: string }) => void
  onGuard?: (fn: () => Promise<{ reqId: string; machine: string; label: string }>) => Promise<void>
  onTerminal?: (machine: string, root: string) => Promise<unknown> | void
}) {
  const p = state.projects[id]
  const [error, setError] = useState('')
  const [syncing, setSyncing] = useState(false)

  useEffect(() => {
    let off = false
    listTickets(id).then((v) => { if (!off) onTickets?.(id, v) }).catch((e) => { if (!off) setError(e instanceof Error ? e.message : 'error') })
    listCheckouts(id).then((c) => { if (!off) onCheckouts?.(id, c ?? []) }).catch(() => { /* the ones inferred from sessions remain */ })
    return () => { off = true }
  }, [id, onTickets, onCheckouts])
  // "Syncing…" until the sync's project_upsert arrives
  useEffect(() => { setSyncing(false) }, [p?.syncedAt, p?.syncError])

  if (!p) return <p className="p-4 text-sm text-zinc-500">{onBack && <button onClick={onBack} aria-label="Back" className="mr-2 inline-flex min-h-11 min-w-11 items-center justify-center text-zinc-400">←</button>}Project not found.</p>

  const ws = state.workspaces[p.workspaceId]
  const tickets = state.tickets[id] ?? []
  const checkouts = projectCheckouts(state, id)

  async function resume(row: Extract<SessionRow, { kind: 'closed' }>) {
    if (pending) return
    setError('')
    const prefs = loadPrefs(id)
    await onGuard?.(() => launchIn({ machine: row.machine, dir: row.root, bypass: prefs.bypass, root: !!state.machines[row.machine]?.caps?.root, resume: row.id, projectId: id }))
  }

  async function sync() {
    setSyncing(true)
    setError('')
    setTimeout(() => setSyncing(false), 30000)
    try { await syncProject(id) } catch (e) { setError(e instanceof Error ? e.message : 'error'); setSyncing(false) }
  }

  return (
    <div className="pb-10">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-zinc-800 bg-zinc-950/90 px-3 py-2 backdrop-blur">
        {onBack && <button onClick={onBack} aria-label="Back" className="flex min-h-11 min-w-11 items-center justify-center text-zinc-400">←</button>}
        {ws && <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: ws.color || '#71717a' }} title={ws.name} />}
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold">{p.name}</h2>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button aria-label="Project menu" className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-zinc-900"><MoreHorizontal className="h-5 w-5" /></button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem className="min-h-11" onSelect={() => onOpenTickets?.(id)}>Tickets ({tickets.length})</DropdownMenuItem>
            {p.connector && p.connector.kind !== 'none' && <DropdownMenuItem className="min-h-11" disabled={syncing} onSelect={sync}>{syncing ? 'Syncing…' : 'Sync'}</DropdownMenuItem>}
            {onEdit && <DropdownMenuItem className="min-h-11" onSelect={() => onEdit(id)}>Edit</DropdownMenuItem>}
            <DropdownMenuItem className="min-h-11" onSelect={() => onCheckoutsOpenChange?.(true)}>Checkouts</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      <div className="px-3 pt-3">
        {p.summary && <p className="mt-2 text-sm text-zinc-300">{p.summary}</p>}
        <p className="mt-1 text-xs text-zinc-600">
          {ws?.name}{p.repoUrl && ` · ${p.repoUrl}`}{p.syncedAt ? ` · ${p.syncError ? 'last attempt' : 'synced'} ${since(p.syncedAt)}` : ''}
        </p>
        {p.syncError && <p role="alert" className="mt-2 rounded bg-red-500/10 px-2 py-1 text-xs [overflow-wrap:anywhere] text-red-300">Sync error: {p.syncError}</p>}
        {error && <p role="alert" className="mt-2 text-xs text-red-400">{error}</p>}
      </div>

      <NewSessionCard state={state} projectId={id} pending={pending} onLaunched={(p) => onLaunched?.(p)} onGuard={(f) => onGuard?.(f) ?? Promise.resolve()} onTerminal={(m, r) => onTerminal?.(m, r)} />

      <ProjectSessions state={state} projectId={id} busy={pending} onOpen={(sid) => onOpenSession?.(sid)} onResume={resume} onConversations={(m, r, l) => onConversations?.(m, r, l)} />

      <Sheet open={!!checkoutsOpen} onOpenChange={(o) => onCheckoutsOpenChange?.(o)}>
        <SheetContent side="bottom" className="max-h-[80dvh] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Checkouts</SheetTitle>
            <SheetDescription className="sr-only">Machines and folders where this project is checked out.</SheetDescription>
          </SheetHeader>
          {checkouts.length ? (
            <ul className="px-4 pb-4 text-xs text-zinc-400">
              {checkouts.map((c) => (
                <li key={c.machine + c.root} className="truncate py-1">
                  <span className={state.machines[c.machine]?.online ? 'text-emerald-400' : 'text-zinc-600'}>●</span> {c.machine} · <span className="font-mono">{c.root}</span>{c.branch && ` · ${c.branch}`}
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 pb-4 text-xs text-zinc-600">None yet: they appear on their own when there are sessions in the project's repo.</p>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}
