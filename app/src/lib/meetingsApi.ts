import { ApiError, apiFetch, getDevApi, hubUrl } from './api'
import type { Meeting, MeetingAction } from '../proto.gen'

// The meetings API lives apart from api.ts so that it loads with the meeting screens, not in the initial bundle.

const enc = encodeURIComponent
const json = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) })

// --- Meetings ---

/** The largest recording the hub accepts. */
export const MEETING_MAX_BYTES = 400 * 1024 * 1024

export interface MeetingUploadOpts {
  projectId?: string
  title?: string
  /** Unix ms; the hub uses the upload time when missing. */
  startedAt?: number
  /** "es", "en", "auto"…; "" or missing = the hub default. */
  language?: string
  /** "me|others" for a two-channel Quorum recording. */
  channels?: 'me|others'
  signal?: AbortSignal
  /** Resumes an upload begun earlier (from onUploadId) instead of starting a new one. */
  uploadId?: string
  /** Called once the hub assigned the upload id, so a caller can resume after a restart. */
  onUploadId?: (id: string) => void
  /** Failed attempts in a row before giving up (default 6). */
  retries?: number
  /** First wait before a retry, doubled each time up to 15 s (default 1000 ms). */
  retryDelayMs?: number
  /** Busy answers in a row (another request still writes the upload) before giving up (default 10). */
  busyRetries?: number
  /** First wait after a busy answer, doubled each time up to 30 s (default 5000 ms, the hub's Retry-After). */
  busyDelayMs?: number
}

/** The hub answers 503 (409 on older hubs) while an earlier request still writes the upload. */
const isBusy = (e: unknown) => e instanceof ApiError && (e.status === 503 || (e.status === 409 && /^another request/.test(e.message)))

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason ?? new DOMException('aborted', 'AbortError'))
  const t = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason ?? new DOMException('aborted', 'AbortError')) }, { once: true })
})

/** The offset the hub reported in an error body (409 mismatch, 400 interrupted, 413 cut), if any. */
const hubOffset = (e: unknown): number | undefined => {
  const o = e instanceof ApiError ? e.data?.offset : undefined
  return typeof o === 'number' && o >= 0 ? o : undefined
}

/**
 * Uploads a recording in chunks (POST /api/meetings/uploads, PUT …?offset=, POST …/complete) and resolves
 * with the queued meeting. A failed chunk is retried from the offset the hub has, with backoff; onProgress
 * gets the bytes the hub stored after each chunk. Files over 400 MB are refused before anything is sent.
 */
export async function uploadMeeting(file: Blob & { name?: string }, opts: MeetingUploadOpts = {}, onProgress?: (sent: number, total: number) => void): Promise<Meeting> {
  const size = file.size
  if (size > MEETING_MAX_BYTES) throw new ApiError('the recording is larger than 400 MB', 413, null)
  if (size <= 0) throw new ApiError('the file is empty', 400, null)
  const { signal } = opts
  const retries = opts.retries ?? 6
  const delay0 = opts.retryDelayMs ?? 1000
  let failures = 0
  let busy = 0
  const busyRetries = opts.busyRetries ?? 10
  const busyDelay0 = opts.busyDelayMs ?? 5000
  // a busy upload is not a failure: wait (exponential, capped 30 s) on a budget of its own, so a hub still
  // reading an abandoned request never burns the retries
  const waitBusy = async (e: unknown) => {
    if (signal?.aborted) throw e
    if (++busy > busyRetries) throw e
    await sleep(Math.min(busyDelay0 * 2 ** (busy - 1), 30000), signal)
  }
  // permanent errors stop at once; network errors, 5xx (except 507) and interruptions are retried
  const retry = async (e: unknown) => {
    if (signal?.aborted) throw e
    const st = e instanceof ApiError ? e.status : 0
    if (st && st !== 400 && st !== 408 && st !== 429 && !(st >= 500 && st !== 507)) throw e
    if (st === 400 && hubOffset(e) === undefined) throw e
    if (++failures > retries) throw e
    await sleep(Math.min(delay0 * 2 ** (failures - 1), 15000), signal)
  }
  let id = opts.uploadId ?? ''
  let chunk = 8 * 1024 * 1024
  let offset = 0
  if (!id) {
    for (;;) {
      try {
        const r = await apiFetch<{ uploadId: string; chunkSize: number }>('/api/meetings/uploads', {
          ...json('POST', { name: file.name || 'recording', size, mime: file.type || '', projectId: opts.projectId || '', title: opts.title || '', startedAt: opts.startedAt || 0, language: opts.language || '', channels: opts.channels || '' }),
          signal,
        })
        id = r.uploadId
        if (r.chunkSize > 0) chunk = r.chunkSize
        break
      } catch (e) { await retry(e) }
    }
    opts.onUploadId?.(id)
  } else {
    // resuming: an empty chunk at 0 answers with the offset the hub has (409) or 0
    try {
      offset = (await apiFetch<{ offset: number }>(`/api/meetings/uploads/${enc(id)}?offset=0`, { method: 'PUT', body: new Blob([]), signal, headers: { 'Content-Type': 'application/octet-stream' } })).offset
    } catch (e) {
      const o = hubOffset(e)
      if (o === undefined) throw e
      offset = o
    }
  }
  onProgress?.(offset, size)
  while (offset < size) {
    try {
      const r = await apiFetch<{ offset: number }>(`/api/meetings/uploads/${enc(id)}?offset=${offset}`, {
        method: 'PUT', body: file.slice(offset, Math.min(offset + chunk, size)), signal, headers: { 'Content-Type': 'application/octet-stream' },
      })
      offset = r.offset
      failures = 0
      busy = 0
    } catch (e) {
      const o = hubOffset(e)
      if (isBusy(e)) {
        if (o !== undefined) offset = o
        await waitBusy(e)
      } else if (e instanceof ApiError && e.status === 409 && o !== undefined) {
        offset = o // the hub has another offset (a lost answer, or the upload is already complete): go on from there
        if (++failures > retries) throw e
        if (e.message === 'the upload is already complete') break
      } else {
        if (o !== undefined) offset = o
        await retry(e)
      }
    }
    onProgress?.(offset, size)
  }
  for (;;) {
    try {
      return await apiFetch<Meeting>(`/api/meetings/uploads/${enc(id)}/complete`, { method: 'POST', signal })
    } catch (e) { await (isBusy(e) ? waitBusy(e) : retry(e)) }
  }
}

export type MeetingQuery = { projectId?: string; unassigned?: boolean }
/** Meetings, most recent first: of one project, the unassigned ones, or all. */
export const listMeetings = (q: MeetingQuery = {}) => {
  const dev = getDevApi()?.meetings
  if (dev) return dev.list(q)
  const p = new URLSearchParams()
  if (q.projectId) p.set('projectId', q.projectId)
  if (q.unassigned) p.set('unassigned', '1')
  const qs = p.toString()
  return apiFetch<Meeting[]>('/api/meetings' + (qs ? '?' + qs : ''))
}
/** The meeting with its summary, segments, actions and speaker names. */
export const getMeeting = (id: string) => getDevApi()?.meetings?.get(id) ?? apiFetch<Meeting>(`/api/meetings/${enc(id)}`)
/** Edits title, project ("" unassigns), language or the number of people (speakers, 0 = unknown, up to 20). */
export const patchMeeting = (id: string, b: { title?: string; projectId?: string; language?: string; speakers?: number }) =>
  apiFetch<Meeting>(`/api/meetings/${enc(id)}`, json('PATCH', b))
export const deleteMeeting = (id: string) => apiFetch<void>(`/api/meetings/${enc(id)}`, json('DELETE'))
/** A playback URL of the meeting's audio, valid for an hour, that an <audio> element can load without auth. */
export const meetingAudioURL = async (id: string) => {
  const r = await apiFetch<{ url: string; expiresAt: number }>(`/api/meetings/${enc(id)}/audio-url`)
  return hubUrl() + r.url
}
/** The hub disk used by meeting audio and the bytes still free. */
export const meetingDisk = () => apiFetch<{ audioBytes: number; freeBytes: number }>('/api/meetings/disk')
/** Processes a failed meeting again (re-summarises when it has its transcript, else transcribes again). */
export const retryMeeting = (id: string) => apiFetch<Meeting>(`/api/meetings/${enc(id)}/retry`, json('POST'))
/** Re-summarises a transcribed meeting, with another provider when given. */
export const reprocessMeeting = (id: string, provider?: string) => apiFetch<Meeting>(`/api/meetings/${enc(id)}/reprocess`, json('POST', provider ? { provider } : {}))
/** Names speaker labels ({"Speaker 2": "Name"}; "" removes the name); resolves with the meeting. */
export const nameSpeakers = (id: string, names: Record<string, string>) => apiFetch<Meeting>(`/api/meetings/${enc(id)}/speakers`, json('POST', names))
/** Creates a GitHub issue from an action (once: an action that has one answers with its URL). */
export const createMeetingIssue = (id: string, actionId: string) =>
  apiFetch<{ url: string; created: boolean; action?: MeetingAction }>(`/api/meetings/${enc(id)}/actions/${enc(actionId)}/issue`, json('POST'))
export type MeetingProvider = 'local' | 'ccapi' | 'openai-compatible'
/** Settings → Meetings. The API key is write-only: only hasKey comes back. */
export interface MeetingSettings { provider: MeetingProvider | ''; model: string; baseUrl: string; language: string; aliases: string[]; hasKey: boolean }
export const getMeetingSettings = () => getDevApi()?.meetings?.settings() ?? apiFetch<MeetingSettings>('/api/settings/meetings')
/** Saves the given fields; key "" removes the stored key, a missing key keeps it. */
export const putMeetingSettings = (b: Partial<Omit<MeetingSettings, 'hasKey'>> & { key?: string }) => apiFetch<MeetingSettings>('/api/settings/meetings', json('PUT', b))
