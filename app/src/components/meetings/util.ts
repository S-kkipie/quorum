import type { Meeting, MeetingAction, MeetingSegment } from '../../proto.gen'
import type { MeetingLive } from '../../lib/store'

/** Statuses before the transcript exists (the number of people and the language still matter). */
export const BEFORE_TRANSCRIPT = ['uploaded', 'queued', 'transcribing', 'failed']
export const PROCESSING = ['uploaded', 'queued', 'transcribing', 'summarising']

/** 75 s → "1:15"; 3725 s → "1:02:05". */
export function clock(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = String(t % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** 3725 s → "1 h 2 min"; 50 s → "1 min"; 0 → "". */
export function duration(s: number): string {
  if (!s || s < 0) return ''
  const min = Math.max(1, Math.round(s / 60))
  return min >= 60 ? `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}` : `${min} min`
}

export const date = (ms: number) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '')

export function bytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} kB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(1)} GB`
}

/** The status with the live progress of the last meeting_changed, when it is about the same status. */
export function liveStatus(m: Pick<Meeting, 'status' | 'progress'>, live?: MeetingLive): { status: string; progress: number; stage: string } {
  if (live && live.status === m.status) return { status: m.status, progress: live.progress, stage: live.stage }
  return { status: m.status, progress: m.progress, stage: '' }
}

/** What the owner reads for a status ("Transcribing 40%"). */
export function statusText(status: string, progress = 0): string {
  switch (status) {
    case 'uploaded': return 'Uploaded'
    case 'queued': return 'Waiting for a machine'
    case 'transcribing': return progress > 0 ? `Transcribing ${progress}%` : 'Transcribing'
    case 'summarising': return progress > 0 ? `Summarising ${progress}%` : 'Summarising'
    case 'ready': return 'Ready'
    case 'failed': return 'Failed'
    default: return status
  }
}

const STAGES: Record<string, string> = {
  starting: 'starting', downloading: 'downloading the audio', converting: 'converting the audio', diarizing: 'telling the voices apart',
  finishing: 'finishing', merging: 'merging the sections',
}
/** The worker's stage as a note next to the status ("" when the status already says it). */
export const stageText = (stage: string) => STAGES[stage] ?? ''

export const statusTone = (status: string) => (status === 'failed' ? 'text-danger' : status === 'ready' ? 'text-success' : 'text-warning')

/** The owner's actions first, each group in the summary's order. */
export const sortActions = (a: MeetingAction[]) => [...a.filter((x) => x.mine), ...a.filter((x) => !x.mine)]

export interface Speaker { label: string; name: string; segments: number }
/** The speaker labels of a transcript in order of first appearance, with their display names. */
export function speakers(segs: MeetingSegment[]): Speaker[] {
  const out = new Map<string, Speaker>()
  for (const s of segs) {
    const label = s.label || s.speaker
    if (!label) continue
    const x = out.get(label)
    if (x) x.segments++
    else out.set(label, { label, name: s.speaker || label, segments: 1 })
  }
  return [...out.values()]
}

/** Gives every segment of a label its new display name ("" = back to the label). */
export const renameSegments = (segs: MeetingSegment[], label: string, name: string) =>
  segs.map((s) => ((s.label || s.speaker) === label ? { ...s, label, speaker: name || label } : s))

/** Splits text around the case-insensitive matches of q: odd indexes are matches. */
export function splitMatches(text: string, q: string): string[] {
  if (!q) return [text]
  const lower = text.toLowerCase()
  const needle = q.toLowerCase()
  const parts: string[] = []
  let at = 0
  for (let i = lower.indexOf(needle); i >= 0; i = lower.indexOf(needle, i + needle.length)) {
    parts.push(text.slice(at, i), text.slice(i, i + needle.length))
    at = i + needle.length
  }
  parts.push(text.slice(at))
  return parts
}

export const meetingTitle = (m: Pick<Meeting, 'title'>) => m.title.trim() || 'Untitled recording'

export const PROVIDERS: [string, string][] = [
  ['local', 'Local (Ollama on the laptop)'],
  ['ccapi', 'Claude (ccapi)'],
  ['openai-compatible', 'OpenAI-compatible API'],
]

export const LANGUAGES: [string, string][] = [
  ['es', 'Spanish'],
  ['en', 'English'],
  ['pt', 'Portuguese'],
  ['fr', 'French'],
  ['de', 'German'],
  ['it', 'Italian'],
  ['auto', 'Detect automatically'],
]
