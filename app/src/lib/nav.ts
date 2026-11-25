/** Open terminal; root/label (if they come from "Terminal") let the screen offer "Open another". */
export interface TermNav { machine: string; pane: string; root?: string; label?: string }
/** Open local artifact of a session. */
export interface ViewNav { machine: string; sessionId: string; path: string; images?: boolean; read?: boolean; upload?: boolean }

export type Tab = 'projects' | 'sessions'
/** Navigation saved in history.state, so the browser's Back goes back. `tab` is only used by the phone. */
export interface Nav {
  tab?: Tab
  project?: string | null
  projectTickets?: string | null
  checkouts?: boolean
  ticket?: string | null
  config?: string | null
  session?: string | null
  starting?: boolean
  terminal?: TermNav | null
  viewer?: ViewNav | null
  /** The open meeting page (also from the ?meeting=<id> deep link). */
  meeting?: string | null
  depth?: number
}

/** What the desktop centre pane shows. The Viewer is not a centre: it covers the whole window. */
export type Centre =
  | { kind: 'projects' }
  | { kind: 'session'; id: string }
  | { kind: 'project'; id: string }
  | { kind: 'tickets'; projectId: string; ticket?: string }
  | { kind: 'settings'; project?: string }
  | { kind: 'terminal'; terminal: TermNav }
  | { kind: 'starting' }
  | { kind: 'meeting'; id: string }

/** Every centre field empty: the base of a sidebar jump, so nothing from the previous page lingers. */
export const CLEAR: Nav = { project: null, projectTickets: null, checkouts: false, ticket: null, config: null, session: null, starting: false, terminal: null, viewer: null, meeting: null }

/** The centre of a history entry. A page opened over another (terminal from a project, tickets over it, a meeting over Settings) wins. */
export function centreOf(n: Nav): Centre {
  if (n.terminal) return { kind: 'terminal', terminal: n.terminal }
  if (n.starting) return { kind: 'starting' }
  if (n.meeting) return { kind: 'meeting', id: n.meeting }
  if (n.config != null) return n.config ? { kind: 'settings', project: n.config } : { kind: 'settings' }
  if (n.projectTickets) return n.ticket ? { kind: 'tickets', projectId: n.projectTickets, ticket: n.ticket } : { kind: 'tickets', projectId: n.projectTickets }
  if (n.project) return { kind: 'project', id: n.project }
  if (n.session) return { kind: 'session', id: n.session }
  return { kind: 'projects' }
}

/** The history entry fields of a centre (all the others cleared). */
export function centreNav(c: Centre): Nav {
  switch (c.kind) {
    case 'projects': return { ...CLEAR }
    case 'session': return { ...CLEAR, session: c.id }
    case 'project': return { ...CLEAR, project: c.id }
    case 'tickets': return { ...CLEAR, project: c.projectId, projectTickets: c.projectId, ticket: c.ticket ?? null }
    case 'settings': return { ...CLEAR, config: c.project ?? '' }
    case 'terminal': return { ...CLEAR, terminal: c.terminal }
    case 'starting': return { ...CLEAR, starting: true }
    case 'meeting': return { ...CLEAR, meeting: c.id }
  }
}

/** The meeting id of a ?meeting=<id> deep link (GitHub issues made from meeting actions link to it), or null. */
export function meetingLink(search: string): string | null {
  const id = new URLSearchParams(search).get('meeting')?.trim()
  return id && /^[\w-]{1,128}$/.test(id) ? id : null
}
