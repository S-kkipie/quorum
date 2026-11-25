import { ApiError, apiFetch, getDevApi } from './api'
import type { Pending } from '../proto.gen'

// The pending-items API lives apart from api.ts so that it loads with the project page, not in the initial bundle.

const enc = encodeURIComponent
const json = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) })

/** A pending item's text is at most this many characters (the hub answers 400 otherwise). */
export const PENDING_TEXT_MAX = 300
/** The optional detail is at most this many characters. */
export const PENDING_DETAIL_MAX = 4000

export interface PendingPatch { text?: string; detail?: string; note?: string; status?: 'open' | 'done' | 'dropped' }

/** The dev fixture store (inert unless the dev data toggle is on). */
export interface DevPendings {
  list: (projectId: string, all: boolean) => Promise<Pending[]>
  add: (projectId: string, b: { text: string; detail?: string }) => Promise<Pending>
  patch: (id: string, b: PendingPatch) => Promise<Pending>
  remove: (id: string) => Promise<void>
}

/** The project's pending items, oldest first: the open ones, or all of them (done and dropped too). */
export const listPendings = (projectId: string, all: boolean) =>
  getDevApi()?.pendings?.list(projectId, all) ?? apiFetch<Pending[]>(`/api/projects/${enc(projectId)}/pendings?status=${all ? 'all' : 'open'}`)
/** Adds an item (the hub answers with the existing open item when the same text is already there). */
export const addPending = (projectId: string, b: { text: string; detail?: string }) =>
  getDevApi()?.pendings?.add(projectId, b) ?? apiFetch<Pending>(`/api/projects/${enc(projectId)}/pendings`, json('POST', b))
export const patchPending = (id: string, b: PendingPatch) =>
  getDevApi()?.pendings?.patch(id, b) ?? apiFetch<Pending>(`/api/pendings/${enc(id)}`, json('PATCH', b))
export const deletePending = (id: string): Promise<void> =>
  getDevApi()?.pendings?.remove(id) ?? apiFetch<void>(`/api/pendings/${enc(id)}`, json('DELETE'))
/** Adds a meeting's item as a pending of its project; added is false when it was already there (409). */
export async function addMeetingPending(meetingId: string, text: string): Promise<{ id: string; added: boolean }> {
  try {
    const p = await apiFetch<Pending>(`/api/meetings/${enc(meetingId)}/pendings`, json('POST', { text }))
    return { id: p.id, added: true }
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) return { id: typeof e.data?.id === 'string' ? e.data.id : '', added: false }
    throw e
  }
}
