import type { Project, SessionInfo, Ticket } from '../proto.gen'

// Datos de prueba compartidos por los tests de proyectos.
export const sess = (id: string, o: Partial<SessionInfo> = {}): SessionInfo => ({
  id, recap: '', previousId: '', machine: 'vps-2', name: id, cwd: '/r', root: '/r', model: '', role: 'work',
  state: 'idle', contextPct: 0, startedAt: 1, updatedAt: 1, transcriptPath: '', repoUrl: '', branch: '', projectId: 'p1', ...o,
})
export const proj = (id: string, o: Partial<Project> = {}): Project => ({
  id, workspaceId: 'w1', name: 'Proyecto ' + id, repoUrl: '', connector: { kind: 'exec', settings: {}, hasToken: false, intervalMin: 5 },
  summary: '', summaryAt: 0, progress: { done: 1, total: 4 }, syncError: '', syncedAt: 0, ...o,
})
export const tk = (id: string, o: Partial<Ticket> = {}): Ticket => ({
  id, projectId: 'p1', externalId: 'E-' + id, title: 'Ticket ' + id, status: 'por_hacer', rawStatus: 'open', assignee: '', url: '', body: '', comments: [], updatedAt: 0, ...o,
})
