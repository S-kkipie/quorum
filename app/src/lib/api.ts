import type { AccountUsage, Checkout, Conversation, ConnectorConfig, Event, Project, Proposal, SessionInfo, Ticket, Workspace } from '../proto.gen'

export interface Machine {
  name: string
  os: string
  env: string
  version: string
  online: boolean
  lastSeen: number
  caps: { herdr: boolean; terminal: boolean; root: boolean }
}

const K_HUB = 'quorum.hub'
const K_TOKEN = 'quorum.token'

function get(k: string): string {
  try { return localStorage.getItem(k) ?? '' } catch { return '' }
}

/** Normalizes the address: adds http:// if missing and strips the trailing slash. */
export function normalizeHub(url: string): string {
  let u = url.trim()
  if (!u) return ''
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'http://' + u
  return u.replace(/\/+$/, '')
}

/** Hub address; empty = same origin (when the hub itself serves the app). */
export function hubUrl(): string {
  return get(K_HUB)
}
export function getToken(): string {
  return get(K_TOKEN)
}
/** Saves hub and token together: if a write fails, no hub is left without its token. */
export function setHub(url: string, token: string) {
  let prevHub: string | null = null
  try { prevHub = localStorage.getItem(K_HUB) } catch { /* cannot read: nothing to restore */ }
  try {
    localStorage.setItem(K_TOKEN, token)
    localStorage.setItem(K_HUB, normalizeHub(url))
  } catch {
    try {
      localStorage.removeItem(K_TOKEN)
      if (prevHub === null) localStorage.removeItem(K_HUB)
      else localStorage.setItem(K_HUB, prevHub)
    } catch { /* best effort */ }
    throw new Error('could not save the token on this device')
  }
}
export function clearToken() {
  try { localStorage.removeItem(K_TOKEN) } catch { /* ignore */ }
}

export const UNAUTH_EVENT = 'quorum:unauth'

/** API error: hub message, HTTP status and the JSON body (e.g. {session} on a 409). */
export class ApiError extends Error {
  constructor(message: string, public status: number, public data: any) { super(message) }
}

export async function apiFetch<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  const token = getToken()
  if (token) headers.set('Authorization', 'Bearer ' + token)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const res = await fetch(hubUrl() + path, { ...init, headers })
  if (!res.ok) {
    let msg = `error ${res.status}`
    let data: any = null
    try {
      data = await res.json()
      if (data?.error) msg = data.error
    } catch { /* non-JSON body */ }
    if (res.status === 401) {
      clearToken()
      if (typeof window !== 'undefined') window.dispatchEvent(new Event(UNAUTH_EVENT))
    }
    throw new ApiError(msg, res.status, data)
  }
  // 202/204 from the hub (prompt, decide, close…) arrive without a body
  const body = await res.text()
  return (body ? JSON.parse(body) : undefined) as T
}

/** POST /api/pair with the given address (not saved yet). */
export async function pair(hub: string, code: string, deviceName: string): Promise<{ token: string; name: string }> {
  const base = normalizeHub(hub)
  const res = await fetch(base + '/api/pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: code.trim(), deviceName }),
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(j?.error ?? `error ${res.status}`)
  setHub(base, j.token)
  return j
}

export const listSessions = () => apiFetch<SessionInfo[]>('/api/sessions?closed=1')
export const listUsage = () => apiFetch<AccountUsage[]>('/api/usage')
export const listMachines = () => apiFetch<Machine[]>('/api/machines')

/** Short device name, e.g. "Chrome · Android". */
export function defaultDeviceName(ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): string {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Unknown'
  return `${browser} · ${os}`
}

export type PromptMode = 'now' | 'queue' | 'interrupt'
/** Dev-only data override (fixture mode); inert unless set. */
export interface DevApi {
  listConversations: (machine: string, root: string) => Promise<Conversation[]>
  listEvents: (id: string, before: number, limit: number) => Promise<Event[]>
  pluginState?: (id: string, plugin: PluginName) => Promise<unknown>
}
let devApi: DevApi | null = null
export const setDevApi = (d: DevApi | null) => { devApi = d }

export const listEvents = (id: string, before = 0, limit = 50): Promise<Event[]> =>
  devApi ? devApi.listEvents(id, before, limit) : apiFetch<Event[]>(`/api/sessions/${encodeURIComponent(id)}/events?before=${before}&limit=${limit}`)
export const sendPrompt = (id: string, text: string, mode: PromptMode) =>
  apiFetch(`/api/sessions/${encodeURIComponent(id)}/prompt`, { method: 'POST', body: JSON.stringify({ text, mode }) })
/** Marks the session seen up to seq on every device (the hub caps it at the latest event, never backwards). */
export const seen = (id: string, seq: number) =>
  apiFetch<void>(`/api/sessions/${encodeURIComponent(id)}/seen`, { method: 'POST', body: JSON.stringify({ seq }) })
export const decide = (id: string, body: { askId: string; decision: 'allow' | 'deny'; answers?: Record<string, string>; reason?: string }) =>
  apiFetch(`/api/sessions/${encodeURIComponent(id)}/decide`, { method: 'POST', body: JSON.stringify(body) })
export const abortSession = (id: string) => apiFetch(`/api/sessions/${encodeURIComponent(id)}/abort`, { method: 'POST' })
export const closeSession = (id: string) => apiFetch(`/api/sessions/${encodeURIComponent(id)}/close`, { method: 'POST' })
export const launch = (b: { machine: string; dir: string; permissionMode?: string; resume?: string; label?: string; projectId?: string }) =>
  apiFetch<{ reqId: string }>('/api/launch', { method: 'POST', body: JSON.stringify(b) })

// --- Conversations and terminal ---

const term = (machine: string, pane?: string) =>
  `/api/machines/${encodeURIComponent(machine)}/terminals` + (pane === undefined ? '' : '/' + encodeURIComponent(pane))
export const listConversations = (machine: string, root: string): Promise<Conversation[]> =>
  devApi ? devApi.listConversations(machine, root) : apiFetch<Conversation[]>(`/api/machines/${encodeURIComponent(machine)}/conversations?root=${encodeURIComponent(root)}`)
export const openTerminal = (machine: string, root: string, label: string, fresh = false) =>
  apiFetch<{ pane: string; cols: number; rows: number }>(term(machine), { method: 'POST', body: JSON.stringify({ root, label, new: fresh }) })
export const watchTerminal = (machine: string, pane: string) => apiFetch(term(machine, pane) + '/watch', { method: 'POST' })
export const sendTerminal = (machine: string, pane: string, b: { text?: string; keys?: string[] }) =>
  apiFetch(term(machine, pane) + '/input', { method: 'POST', body: JSON.stringify(b) })
export const readTerminal = (machine: string, pane: string, lines: number) =>
  apiFetch<{ ansi: string }>(term(machine, pane) + `/read?lines=${lines}`)
export const closeTerminal = (machine: string, pane: string) => apiFetch(term(machine, pane), { method: 'DELETE' })

// --- Projects, tickets and proposals ---

/** Ticket with its associated sessions (confirmed or suggested) and, in the detail, its proposals. */
export type TicketView = Ticket & { sessions: { sessionId: string; confirmed: boolean }[]; proposals?: Proposal[] }
export interface ProjectSuggestion { repoURL: string; roots: { machine: string; root: string }[]; sessions: number }
export type ConnectorInput = Pick<ConnectorConfig, 'kind' | 'settings' | 'intervalMin'>

const enc = encodeURIComponent
const json = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) })

export const listWorkspaces = () => apiFetch<Workspace[]>('/api/workspaces')
export const createWorkspace = (b: { name: string; color?: string; whoasProfile?: string }) => apiFetch<Workspace>('/api/workspaces', json('POST', b))
export const updateWorkspace = (id: string, b: Partial<Pick<Workspace, 'name' | 'color' | 'whoasProfile'>>) => apiFetch<Workspace>(`/api/workspaces/${enc(id)}`, json('PATCH', b))
export const deleteWorkspace = (id: string) => apiFetch(`/api/workspaces/${enc(id)}`, json('DELETE'))
export const listProjects = () => apiFetch<Project[]>('/api/projects')
export const createProject = (b: { workspaceId: string; name: string; repoURL: string; connector?: ConnectorInput }) => apiFetch<Project>('/api/projects', json('POST', b))
export const updateProject = (id: string, b: { name?: string; workspaceId?: string; repoURL?: string; connector?: ConnectorInput }) => apiFetch<Project>(`/api/projects/${enc(id)}`, json('PATCH', b))
export const deleteProject = (id: string) => apiFetch(`/api/projects/${enc(id)}`, json('DELETE'))
/** The token is write-only: "" deletes it. */
export const setProjectToken = (id: string, token: string) => apiFetch(`/api/projects/${enc(id)}/token`, json('PUT', { token }))
export const listSuggestions = () => apiFetch<ProjectSuggestion[]>('/api/projects/suggestions')
export const syncProject = (id: string) => apiFetch(`/api/projects/${enc(id)}/sync`, json('POST'))
export const listCheckouts = (projectId: string) => apiFetch<Checkout[]>(`/api/projects/${enc(projectId)}/checkouts`)
export const listTickets = (projectId: string) => apiFetch<TicketView[]>(`/api/projects/${enc(projectId)}/tickets`)
export const getTicket = (id: string) => apiFetch<TicketView>(`/api/tickets/${enc(id)}`)
export const launchTicket = (id: string, b: { machine: string; checkoutRoot: string; permissionMode?: string }) =>
  apiFetch<{ reqId: string }>(`/api/tickets/${enc(id)}/launch`, json('POST', b))
export const proposeStatus = (ticketId: string, status: string) => apiFetch<Proposal>(`/api/tickets/${enc(ticketId)}/proposals`, json('POST', { kind: 'status', status }))
export type ProposalQuery = { ticket?: string; status?: string; limit?: number }
/** Proposals, most recent first (the hub returns at most 200 if no limit is given). */
export const listProposals = (q: ProposalQuery = {}) => {
  const p = new URLSearchParams()
  if (q.ticket) p.set('ticket', q.ticket)
  if (q.status) p.set('status', q.status)
  if (q.limit) p.set('limit', String(q.limit))
  const qs = p.toString()
  return apiFetch<Proposal[]>('/api/proposals' + (qs ? '?' + qs : ''))
}
/** What the app loads on startup: all pending ones and the 50 most recent (without repeats). */
export const loadProposals = async () => {
  const [pending, recent] = await Promise.all([listProposals({ status: 'pending', limit: 1000 }), listProposals({ limit: 50 })])
  const seen = new Set<string>()
  return [...(pending ?? []), ...(recent ?? [])].filter((p) => !seen.has(p.id) && (seen.add(p.id), true))
}
export const approveProposal = (id: string, body?: string) => apiFetch<Proposal>(`/api/proposals/${enc(id)}/approve`, json('POST', body === undefined ? undefined : { body }))
export const rejectProposal = (id: string) => apiFetch<Proposal>(`/api/proposals/${enc(id)}/reject`, json('POST'))
export const confirmTicketLink = (sessionId: string, ticketId: string) => apiFetch(`/api/sessions/${enc(sessionId)}/ticket`, json('POST', { ticketId }))
export const unlinkTicket = (sessionId: string, ticketId: string) => apiFetch(`/api/sessions/${enc(sessionId)}/ticket?ticketId=${enc(ticketId)}`, json('DELETE'))

/**
 * Asks the hub for a short-lived link to a file of the session; `url` is relative to the hub.
 * `mode` 'images': an image pasted in the terminal (served from the session's images folder);
 * 'read': an image Claude read with the Read tool (served from its own folder). Both links serve that one file.
 */
export type ViewMode = 'images' | 'read'
export const createView = (machine: string, sessionId: string, path: string, mode?: ViewMode) =>
  apiFetch<{ url: string }>(`/api/machines/${enc(machine)}/views`, json('POST', mode ? { sessionId, path, [mode]: true } : { sessionId, path }))

// --- better-claude plugins (read from the session's store files, commands via the mod) ---

export type PluginName = 'after' | 'time-machine'
export type PluginCommandName = 'after' | 'before' | 'timeline'
/** The plugin's raw state for the session, or null when there is none. */
export const pluginState = (id: string, plugin: PluginName): Promise<unknown> =>
  devApi?.pluginState ? devApi.pluginState(id, plugin) : apiFetch<unknown>(`/api/sessions/${encodeURIComponent(id)}/plugins/${encodeURIComponent(plugin)}`)
export const pluginCommand = (id: string, command: PluginCommandName, args: string) =>
  apiFetch(`/api/sessions/${encodeURIComponent(id)}/plugin`, { method: 'POST', body: JSON.stringify({ command, args }) })
