import type { Event, SessionInfo } from '../proto.gen'
import { stateStyle, toMs } from './projects'
import { ago } from './background'
import { displayState, stateDetail } from './sessions'
import type { AppState } from './store'
import { sortSessions } from './tree'

/** localStorage key of the phone inbox's job filter. */
export const INBOX_JOB_KEY = 'quorum.inbox.job'

/** The sections of the phone inbox, in ATTENTION order. */
const ORDER = ['needs_you', 'done', 'working', 'background', 'idle'] as const

export interface InboxRow { session: SessionInfo; project: string; reason: string }
export interface InboxSection { key: string; label: string; rows: InboxRow[] }

/** The last tool a session started, as "Bash npm test" ('' when none is loaded). */
export function lastToolLabel(events: Event[] | undefined): string {
  for (let i = (events?.length ?? 0) - 1; i >= 0; i--) {
    const e = events![i]
    if (e.kind !== 'tool_start') continue
    const name = typeof e.data?.name === 'string' ? e.data.name : ''
    const summary = typeof e.data?.summary === 'string' ? e.data.summary : ''
    return [name, summary].filter(Boolean).join(' ')
  }
  return ''
}

/** Why the session is in its section: the ask, the last tool, the background count, "Finished" or its age. */
export function reasonOf(s: AppState, x: SessionInfo, now: number): string {
  switch (displayState(x)) {
    case 'needs_you': {
      const ask = Object.values(s.asks).filter((a) => a.session === x.id).pop()
      if (!ask) return 'Needs you'
      return ask.kind === 'question' ? 'Question' : ask.tool ? `Permission: ${ask.tool}` : 'Permission'
    }
    case 'working': return lastToolLabel(s.events[x.id]) || 'Working'
    case 'background': {
      const n = x.background?.tasks ?? 0
      return n > 0 ? `${n} background ${n === 1 ? 'task' : 'tasks'}` : stateDetail(x, now) || 'Background'
    }
    case 'done': return 'Finished'
    default: return x.updatedAt ? ago(toMs(x.updatedAt), now) : 'Idle'
  }
}

/** The jobs (workspaces) that can filter the inbox, by name. */
export const inboxJobs = (s: AppState) => Object.values(s.workspaces).sort((a, b) => a.name.localeCompare(b.name))

/**
 * The inbox sections for a job ('' = all). Live work sessions fall in their attention section; services
 * (shown only unfiltered) come last. Empty sections are left out.
 */
export function inboxSections(s: AppState, job: string, now = Date.now()): InboxSection[] {
  const order = new Map(s.order.map((id, i) => [id, i]))
  const live = s.order.map((id) => s.sessions[id]).filter((x): x is SessionInfo => !!x && x.state !== 'closed')
  const row = (x: SessionInfo): InboxRow => ({ session: x, project: s.projects[x.projectId]?.name ?? '', reason: reasonOf(s, x, now) })
  const work = live.filter((x) => x.role !== 'service' && (!job || s.projects[x.projectId]?.workspaceId === job))
  const out: InboxSection[] = ORDER.map((k) => ({
    key: k,
    label: stateStyle(k).label,
    rows: sortSessions(work.filter((x) => (ORDER as readonly string[]).includes(displayState(x)) ? displayState(x) === k : k === 'idle'), order).map(row),
  }))
  if (!job) out.push({ key: 'services', label: 'Services', rows: sortSessions(live.filter((x) => x.role === 'service'), order).map(row) })
  return out.filter((x) => x.rows.length > 0)
}

export function loadInboxJob(): string {
  try { return localStorage.getItem(INBOX_JOB_KEY) ?? '' } catch { return '' }
}
export function saveInboxJob(id: string) {
  try { localStorage.setItem(INBOX_JOB_KEY, id) } catch { /* kept in memory for this run */ }
}
