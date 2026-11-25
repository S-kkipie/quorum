import { buildTimeline, itemKey, type Item } from './timeline'
import type { Event } from '../proto.gen'

export type ChangedFile = { path: string; add: number; del: number; eventKey: string }

const EDITS = new Set(['Edit', 'MultiEdit', 'Write'])
const lines = (s: string) => (s ? s.replace(/\n$/, '').split('\n').length : 0)

/**
 * Files the session edited or wrote, one entry per path in first-seen order. The +/- come from the tool
 * rows' own parsing (`diff` of an edit); a write counts its lines as additions. Failed or denied calls
 * are skipped. `eventKey` is the transcript row of the first change.
 */
export const changedFiles = (events: Event[]): ChangedFile[] => changedFilesOf(buildTimeline(events, ''))

/** `changedFiles` over an already built timeline. */
export function changedFilesOf(items: Item[]): ChangedFile[] {
  const out = new Map<string, ChangedFile>()
  for (const it of items) {
    if (it.t !== 'tool' || !EDITS.has(it.name) || !it.file || it.state === 'error' || it.state === 'denied') continue
    const d = it.diff ?? (it.name === 'Write' ? { add: lines(typeof it.input?.content === 'string' ? it.input.content : ''), del: 0 } : { add: 0, del: 0 })
    const cur = out.get(it.file)
    if (cur) { cur.add += d.add; cur.del += d.del } else out.set(it.file, { path: it.file, add: d.add, del: d.del, eventKey: itemKey(it) })
  }
  return [...out.values()]
}
