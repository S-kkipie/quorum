import { useEffect, useState } from 'react'
import ProjectSessions from '../components/ProjectSessions'
import NewSessionCard from '../components/NewSessionCard'
import LaunchDialog from '../components/LaunchDialog'
import Briefing, { useBriefing, useVisit } from '../components/briefing/Briefing'
import { briefingPrompt, hasContent, latestSession } from '../lib/briefing'
import { Button } from '@/components/ui/button'
import { MoreHorizontal } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { listCheckouts, listTickets, syncProject, type TicketView } from '../lib/api'
import { launchIn, loadPrefs } from '../lib/launch'
import { projectCheckouts, since } from '../lib/projects'
import type { AppState } from '../lib/store'
import type { SessionRow } from '../lib/sessions'
import type { Checkout, Conversation } from '../proto.gen'
import { ScrollArea } from '@/components/ui/scroll-area'

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
  const { b, error: briefingError, setB } = useBriefing(id, state.briefingRev?.[id] ?? 0)
  useVisit(id)
  const [pinOpen, setPinOpen] = useState(false)
  /** "Continue where I left off": the launch dialog with the briefing as its first prompt. */
  const [resumeAt, setResumeAt] = useState<{ prompt: string; machine: string; dir: string } | null>(null)

  useEffect(() => {
    let off = false
    listTickets(id).then((v) => { if (!off) onTickets?.(id, v) }).catch((e) => { if (!off) setError(e instanceof Error ? e.message : 'error') })
    listCheckouts(id).then((c) => { if (!off) onCheckouts?.(id, c ?? []) }).catch(() => { /* the ones inferred from sessions remain */ })
    return () => { off = true }
  }, [id, onTickets, onCheckouts])
  // "Syncing…" until the sync's project_upsert arrives
  useEffect(() => { setSyncing(false) }, [p?.syncedAt, p?.syncError])

  if (!p) return <p className="p-4 text-sm text-muted-foreground">{onBack && <button onClick={onBack} aria-label="Back" className="mr-2 inline-flex min-h-11 min-w-11 items-center justify-center text-muted-foreground">←</button>}Project not found.</p>

  const ws = state.workspaces[p.workspaceId]
  const tickets = state.tickets[id] ?? []
  const checkouts = projectCheckouts(state, id)

  async function resume(row: Extract<SessionRow, { kind: 'closed' }>) {
    if (pending) return
    setError('')
    const prefs = loadPrefs(id)
    await onGuard?.(() => launchIn({ machine: row.machine, dir: row.root, bypass: prefs.bypass, root: !!state.machines[row.machine]?.caps?.root, resume: row.id, projectId: id }))
  }

  function continueLeftOff() {
    if (!b || pending) return
    const last = latestSession(b) ?? Object.values(state.sessions).filter((x) => x.projectId === id && x.role !== 'service').sort((x, y) => y.updatedAt - x.updatedAt)[0]
    setResumeAt({ prompt: briefingPrompt(b), machine: last?.machine ?? '', dir: last?.root || last?.cwd || '' })
  }
  const hasSource = !!p.connector && p.connector.kind !== 'none'

  async function sync() {
    setSyncing(true)
    setError('')
    setTimeout(() => setSyncing(false), 30000)
    try { await syncProject(id) } catch (e) { setError(e instanceof Error ? e.message : 'error'); setSyncing(false) }
  }

  return (
    <div className="pb-10">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-background/90 px-3 py-2 backdrop-blur">
        {onBack && <button onClick={onBack} aria-label="Back" className="flex min-h-11 min-w-11 items-center justify-center text-muted-foreground">←</button>}
        {ws && <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: ws.color || '#71717a' }} title={ws.name} />}
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold">{p.name}</h2>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button aria-label="Project menu" className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-chip"><MoreHorizontal className="h-5 w-5" /></button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem className="min-h-11" onSelect={() => onOpenTickets?.(id)}>Tickets ({tickets.length})</DropdownMenuItem>
            {p.connector && p.connector.kind !== 'none' && <DropdownMenuItem className="min-h-11" disabled={syncing} onSelect={sync}>{syncing ? 'Syncing…' : 'Sync'}</DropdownMenuItem>}
            {onEdit && <DropdownMenuItem className="min-h-11" onSelect={() => onEdit(id)}>Edit</DropdownMenuItem>}
            <DropdownMenuItem className="min-h-11" onSelect={() => setPinOpen(true)}>Pin a note</DropdownMenuItem>
            <DropdownMenuItem className="min-h-11" onSelect={() => onCheckoutsOpenChange?.(true)}>Checkouts</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      <div className="px-3 pt-2">
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {ws?.name}{p.repoUrl && ` · ${p.repoUrl}`}{p.syncedAt ? ` · ${p.syncError ? 'last attempt' : 'synced'} ${since(p.syncedAt)}` : ''}
        </p>
        {p.syncError && <p role="alert" className="mt-2 rounded-lg bg-del-soft px-2 py-1 text-xs [overflow-wrap:anywhere] text-danger">Sync error: {p.syncError}</p>}
        {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
      </div>

      {b ? (
        <Briefing b={b} projectId={id} hasSource={hasSource} pinOpen={pinOpen} onBriefing={(f) => setB((x) => (x ? f(x) : x))}
          onOpenSession={onOpenSession} onEditSource={onEdit ? () => onEdit(id) : undefined} />
      ) : (
        briefingError && <p className="px-3 pt-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">Briefing unavailable: {briefingError}</p>
      )}

      <section role="region" aria-label="Sessions">
        <NewSessionCard state={state} projectId={id} pending={pending} onLaunched={(p) => onLaunched?.(p)} onGuard={(f) => onGuard?.(f) ?? Promise.resolve()} onTerminal={(m, r) => onTerminal?.(m, r)} />
        {b && hasContent(b) && (
          <div className="px-3 pt-2">
            <Button variant="secondary" disabled={pending} onClick={continueLeftOff} className="min-h-11 w-full">Continue where I left off</Button>
          </div>
        )}
        <ProjectSessions state={state} projectId={id} busy={pending} onOpen={(sid) => onOpenSession?.(sid)} onResume={resume} onConversations={(m, r, l) => onConversations?.(m, r, l)} />
      </section>
      {resumeAt && (
        <LaunchDialog state={state} projectId={id} initialPrompt={resumeAt.prompt} initialMachine={resumeAt.machine} initialDir={resumeAt.dir}
          onClose={() => setResumeAt(null)} onLaunched={(x) => { setResumeAt(null); onLaunched?.(x) }} />
      )}

      <Sheet open={!!checkoutsOpen} onOpenChange={(o) => onCheckoutsOpenChange?.(o)}>
        <SheetContent side="bottom" className="max-h-[80dvh] overflow-hidden">
<ScrollArea viewportClassName="max-h-[80dvh]"><div className="flex flex-col gap-4">
          <SheetHeader>
            <SheetTitle>Checkouts</SheetTitle>
            <SheetDescription className="sr-only">Machines and folders where this project is checked out.</SheetDescription>
          </SheetHeader>
          {checkouts.length ? (
            <ul className="px-4 pb-4 text-xs text-muted-foreground">
              {checkouts.map((c) => (
                <li key={c.machine + c.root} className="truncate py-1">
                  <span className={state.machines[c.machine]?.online ? 'text-success' : 'text-muted-foreground'}>●</span> {c.machine} · <span className="font-mono">{c.root}</span>{c.branch && ` · ${c.branch}`}
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 pb-4 text-xs text-muted-foreground">None yet: they appear on their own when there are sessions in the project's repo.</p>
          )}
        </div></ScrollArea>
</SheetContent>
      </Sheet>
    </div>
  )
}
