import type { SessionInfo } from '../proto.gen'
import { toMs, workspaceProjects } from './projects'
import { attentionRank, displayState } from './sessions'
import type { AppState } from './store'
import { sessionTitle } from './title'

export interface TreeProject { id: string; name: string; sessions: SessionInfo[] }
export interface TreeJob { id: string; name: string; color: string; projects: TreeProject[] }
/** What the desktop sidebar shows: pinned needs-you, then job → project → session, then the rest. */
export interface Tree {
  /** needs_you sessions across every project (pinned at the top). */
  needsYou: SessionInfo[]
  jobs: TreeJob[]
  /** Work sessions with no known project. */
  loose: SessionInfo[]
  services: SessionInfo[]
}

/** Attention first (ATTENTION order), then the most recent activity, then the stable list order. */
export function sortSessions(list: SessionInfo[], order: Map<string, number>): SessionInfo[] {
  return [...list].sort((a, b) => attentionRank(a) - attentionRank(b) || toMs(b.updatedAt) - toMs(a.updatedAt) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
}

/**
 * The sidebar tree. Closed sessions are hidden. `query` filters (case-insensitive substring) on the
 * session's name (the title shown, and its raw name), its project's name and its machine; while it
 * filters, projects and jobs with no match are dropped.
 */
export function sessionTree(s: AppState, query = ''): Tree {
  const needle = query.trim().toLowerCase()
  const order = new Map(s.order.map((id, i) => [id, i]))
  const live = s.order.map((id) => s.sessions[id]).filter((x): x is SessionInfo => !!x && x.state !== 'closed')
  const projectName = (x: SessionInfo) => s.projects[x.projectId]?.name ?? ''
  const match = (x: SessionInfo) => !needle || [sessionTitle(x).title, x.name, projectName(x), x.machine].some((v) => !!v && v.toLowerCase().includes(needle))
  const work = live.filter((x) => x.role !== 'service')
  const byProject = new Map<string, SessionInfo[]>()
  const loose: SessionInfo[] = []
  for (const x of work) {
    if (!match(x)) continue
    if (s.projects[x.projectId]) byProject.set(x.projectId, [...(byProject.get(x.projectId) ?? []), x])
    else loose.push(x)
  }
  const job = (id: string, name: string, color: string, projects: { id: string; name: string }[]): TreeJob => ({
    id, name, color,
    projects: projects
      .map((p) => ({ id: p.id, name: p.name, sessions: sortSessions(byProject.get(p.id) ?? [], order) }))
      .filter((p) => !needle || p.sessions.length > 0),
  })
  const jobs = Object.values(s.workspaces)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((w) => job(w.id, w.name, w.color, workspaceProjects(s, w.id)))
  const orphans = Object.values(s.projects).filter((p) => !s.workspaces[p.workspaceId]).sort((a, b) => a.name.localeCompare(b.name))
  if (orphans.length) jobs.push(job('', 'No workspace', '', orphans))
  const needsYou = work.filter((x) => displayState(x) === 'needs_you' && match(x)).sort((a, b) => toMs(b.updatedAt) - toMs(a.updatedAt))
  return {
    needsYou,
    jobs: needle ? jobs.filter((j) => j.projects.length > 0) : jobs,
    loose: sortSessions(loose, order),
    services: sortSessions(live.filter((x) => x.role === 'service' && match(x)), order),
  }
}

/** The short right-hand meta of a sidebar row: "bg" for a background session, else "now", "7m", "3h", "2d". */
export function sessionMeta(x: Pick<SessionInfo, 'state' | 'updatedAt'>, now = Date.now()): string {
  if (x.state === 'background') return 'bg'
  if (!x.updatedAt) return ''
  const m = Math.floor(Math.max(0, now - toMs(x.updatedAt)) / 60000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  if (m < 1440) return `${Math.floor(m / 60)}h`
  return `${Math.floor(m / 1440)}d`
}
