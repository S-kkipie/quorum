import type { Project, SessionInfo, Ticket } from '../proto.gen'
import type { AppState } from './store'
import { ATTENTION } from './sessions'

/** Normalized statuses in display order (done is folded at the end). */
export const STATUSES = ['todo', 'in_progress', 'in_review', 'blocked', 'done'] as const
export const STATUS_LABEL: Record<string, string> = {
  todo: 'to do', in_progress: 'in progress', in_review: 'in review', blocked: 'blocked', done: 'done',
}

/** Session states with their color (shared by the session list and the board). */
export const SESSION_STATE: Record<string, { label: string; dot: string; text: string }> = {
  working: { label: 'working', dot: 'bg-blue-500', text: 'text-blue-400' },
  needs_you: { label: 'needs you', dot: 'bg-amber-500', text: 'text-amber-400' },
  waiting: { label: 'waiting', dot: 'bg-zinc-500', text: 'text-zinc-400' },
  idle: { label: 'idle', dot: 'bg-zinc-500', text: 'text-zinc-400' },
  closed: { label: 'closed', dot: 'bg-zinc-700', text: 'text-zinc-600' },
}

export const toMs = (ts: number) => (ts > 1e12 ? ts : ts * 1000)

/** "12 min ago", "2h ago", "3d ago". */
export function since(ts: number, now = Date.now()): string {
  const m = Math.max(0, Math.floor((now - toMs(ts)) / 60000))
  if (m < 60) return `${Math.max(1, m)} min ago`
  if (m < 1440) return `${Math.floor(m / 60)}h ago`
  return `${Math.floor(m / 1440)}d ago`
}

/** Live sessions (not closed, work role) of the project, in the stable list order. */
export function projectSessions(s: AppState, projectId: string): SessionInfo[] {
  return s.order.map((id) => s.sessions[id]).filter((x) => x && x.projectId === projectId && x.role !== 'service' && x.state !== 'closed')
}

/** Lowest ATTENTION rank among the project's live sessions (99 when it has none). */
export function projectAttention(s: AppState, projectId: string): number {
  let best = 99
  for (const x of projectSessions(s, projectId)) best = Math.min(best, ATTENTION[x.state] ?? 3)
  return best
}

/** Pending proposals per project (via the ticket they belong to). */
export function pendingByProject(s: AppState): Record<string, number> {
  const owner: Record<string, string> = {}
  for (const [pid, ts] of Object.entries(s.tickets)) for (const t of ts) owner[t.id] = pid
  const out: Record<string, number> = {}
  for (const p of Object.values(s.proposals)) {
    const pid = owner[p.ticketId]
    if (p.status === 'pending' && pid) out[pid] = (out[pid] ?? 0) + 1
  }
  return out
}

/** Sessions associated with a ticket: confirmed and suggested. */
export function ticketSessions(s: AppState, ticketId: string): { session: SessionInfo | undefined; id: string; confirmed: boolean }[] {
  return Object.entries(s.links[ticketId] ?? {}).map(([id, confirmed]) => ({ id, confirmed, session: s.sessions[id] }))
}

export type Tone = 'blue' | 'amber' | 'emerald' | 'red' | 'zinc'

/**
 * Combined state of a ticket (spec §10): the ticket source's plus that of its live
 * confirmed session, e.g. "in progress · vps-2 · working 12 min ago".
 */
export function ticketLine(s: AppState, t: Ticket, now = Date.now()): { text: string; tone: Tone } {
  const live = ticketSessions(s, t.id)
    .filter((l) => l.confirmed && l.session && l.session.state !== 'closed')
    .map((l) => l.session!)
  const needs = live.find((x) => x.state === 'needs_you')
  if (needs) return { text: `needs you · ${needs.machine}`, tone: 'amber' }
  const working = live.find((x) => x.state === 'working')
  if (working) return { text: `in progress · ${working.machine} · working ${since(working.updatedAt, now)}`, tone: 'blue' }
  if (t.status === 'in_review') return { text: 'done, waiting for your review', tone: 'emerald' }
  const done = live.find((x) => s.worked[x.id])
  if (done && t.status !== 'done') return { text: `done, waiting for your review · ${done.machine}`, tone: 'emerald' }
  const label = STATUS_LABEL[t.status] ?? t.status
  if (live.length) return { text: `${label} · session on ${live[0].machine}`, tone: 'zinc' }
  return { text: label, tone: t.status === 'blocked' ? 'red' : 'zinc' }
}

export const TONE_TEXT: Record<Tone, string> = {
  blue: 'text-blue-400', amber: 'text-amber-400', emerald: 'text-emerald-400', red: 'text-red-400', zinc: 'text-zinc-400',
}

/**
 * Checkouts of the project (machine + root): those saved in the hub plus those
 * inferred from its sessions (not loaded yet or just discovered), without repeats.
 */
export function projectCheckouts(s: AppState, projectId: string): { machine: string; root: string; branch: string }[] {
  const seen = new Map<string, { machine: string; root: string; branch: string }>()
  const key = (m: string, r: string) => m + '\u0000' + r
  for (const c of s.checkouts[projectId] ?? []) seen.set(key(c.machine, c.root), { machine: c.machine, root: c.root, branch: c.branch })
  for (const id of s.order) {
    const x = s.sessions[id]
    if (!x || x.projectId !== projectId || !x.root) continue
    const k = key(x.machine, x.root)
    const prev = seen.get(k)
    seen.set(k, { machine: x.machine, root: x.root, branch: x.branch || prev?.branch || '' })
  }
  return [...seen.values()].sort((a, b) => (a.machine + a.root).localeCompare(b.machine + b.root))
}

/** Projects of a workspace, by name. */
export function workspaceProjects(s: AppState, workspaceId: string): Project[] {
  return Object.values(s.projects).filter((p) => p.workspaceId === workspaceId).sort((a, b) => a.name.localeCompare(b.name))
}
