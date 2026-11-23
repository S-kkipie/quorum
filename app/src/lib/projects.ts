import type { Project, SessionInfo, Ticket } from '../proto.gen'
import type { AppState } from './store'

/** Estados normalizados en el orden en que se muestran (hecho va plegado al final). */
export const STATUSES = ['por_hacer', 'en_curso', 'en_review', 'bloqueado', 'hecho'] as const
export const STATUS_LABEL: Record<string, string> = {
  por_hacer: 'por hacer', en_curso: 'en curso', en_review: 'en review', bloqueado: 'bloqueado', hecho: 'hecho',
}

/** Estados de sesión con su color (lo comparten la lista de sesiones y el tablero). */
export const SESSION_STATE: Record<string, { label: string; dot: string; text: string }> = {
  working: { label: 'trabajando', dot: 'bg-blue-500', text: 'text-blue-400' },
  needs_you: { label: 'te necesita', dot: 'bg-amber-500', text: 'text-amber-400' },
  waiting: { label: 'esperando', dot: 'bg-zinc-500', text: 'text-zinc-400' },
  idle: { label: 'inactiva', dot: 'bg-zinc-500', text: 'text-zinc-400' },
  closed: { label: 'cerrada', dot: 'bg-zinc-700', text: 'text-zinc-600' },
}

const toMs = (ts: number) => (ts > 1e12 ? ts : ts * 1000)

/** "hace 12 min", "hace 2 h", "hace 3 d". */
export function since(ts: number, now = Date.now()): string {
  const m = Math.max(0, Math.floor((now - toMs(ts)) / 60000))
  if (m < 60) return `hace ${Math.max(1, m)} min`
  if (m < 1440) return `hace ${Math.floor(m / 60)} h`
  return `hace ${Math.floor(m / 1440)} d`
}

/** Sesiones vivas (no cerradas, de trabajo) del proyecto, en el orden estable de la lista. */
export function projectSessions(s: AppState, projectId: string): SessionInfo[] {
  return s.order.map((id) => s.sessions[id]).filter((x) => x && x.projectId === projectId && x.role !== 'service' && x.state !== 'closed')
}

/** Propuestas pendientes por proyecto (vía el ticket al que pertenecen). */
export function pendingByProject(s: AppState): Record<string, number> {
  const owner: Record<string, string> = {}
  for (const [pid, ts] of Object.entries(s.tickets)) for (const t of ts) owner[t.id] = pid
  const out: Record<string, number> = {}
  for (const p of Object.values(s.proposals)) {
    const pid = owner[p.ticketId]
    if (p.status === 'pendiente' && pid) out[pid] = (out[pid] ?? 0) + 1
  }
  return out
}

/** Sesiones asociadas a un ticket: confirmadas y sugeridas. */
export function ticketSessions(s: AppState, ticketId: string): { session: SessionInfo | undefined; id: string; confirmed: boolean }[] {
  return Object.entries(s.links[ticketId] ?? {}).map(([id, confirmed]) => ({ id, confirmed, session: s.sessions[id] }))
}

export type Tone = 'blue' | 'amber' | 'emerald' | 'red' | 'zinc'

/**
 * Estado combinado de un ticket (spec §10): el de la ticketera más el de su sesión
 * confirmada viva, p. ej. "en curso · vps-2 · trabajando hace 12 min".
 */
export function ticketLine(s: AppState, t: Ticket, now = Date.now()): { text: string; tone: Tone } {
  const live = ticketSessions(s, t.id)
    .filter((l) => l.confirmed && l.session && l.session.state !== 'closed')
    .map((l) => l.session!)
  const needs = live.find((x) => x.state === 'needs_you')
  if (needs) return { text: `te necesita · ${needs.machine}`, tone: 'amber' }
  const working = live.find((x) => x.state === 'working')
  if (working) return { text: `en curso · ${working.machine} · trabajando ${since(working.updatedAt, now)}`, tone: 'blue' }
  if (t.status === 'en_review') return { text: 'listo, esperando tu review', tone: 'emerald' }
  const done = live.find((x) => s.worked[x.id])
  if (done && t.status !== 'hecho') return { text: `listo, esperando tu review · ${done.machine}`, tone: 'emerald' }
  const label = STATUS_LABEL[t.status] ?? t.status
  if (live.length) return { text: `${label} · sesión en ${live[0].machine}`, tone: 'zinc' }
  return { text: label, tone: t.status === 'bloqueado' ? 'red' : 'zinc' }
}

export const TONE_TEXT: Record<Tone, string> = {
  blue: 'text-blue-400', amber: 'text-amber-400', emerald: 'text-emerald-400', red: 'text-red-400', zinc: 'text-zinc-400',
}

/**
 * Checkouts del proyecto (máquina + raíz): los guardados en el hub más los que se
 * deducen de sus sesiones (aún no cargados o recién descubiertos), sin repetir.
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

/** Proyectos de un trabajo, por nombre. */
export function workspaceProjects(s: AppState, workspaceId: string): Project[] {
  return Object.values(s.projects).filter((p) => p.workspaceId === workspaceId).sort((a, b) => a.name.localeCompare(b.name))
}
