import { describe, expect, it } from 'vitest'
import { changedFiles, changedFilesOf } from './changedFiles'
import { buildTimeline } from './timeline'
import { partitionTimeline } from './subagents'
import type { Event } from '../proto.gen'

let n = 0
const start = (name: string, input: unknown, id = `t${++n}`, seq = ++n): Event => ({ seq, session: 's', ts: 1, kind: 'tool_start', data: { id, name, input } })
const end = (id: string, ok = true, seq = ++n): Event => ({ seq, session: 's', ts: 1, kind: 'tool_end', data: { id, ok, output: '' } })

describe('changedFiles', () => {
  it('sums repeated edits of one path and keeps first-seen order', () => {
    const evs = [
      start('Edit', { file_path: '/r/a.ts', old_string: 'x\ny', new_string: 'x\nz\nw' }, 'e1', 10),
      start('Write', { file_path: '/r/b.ts', content: 'one\ntwo\n' }, 'w1', 12),
      start('Edit', { file_path: '/r/a.ts', old_string: 'q', new_string: 'r' }, 'e2', 14),
    ]
    const out = changedFiles(evs)
    expect(out.map((f) => f.path)).toEqual(['/r/a.ts', '/r/b.ts'])
    expect(out[0]).toMatchObject({ add: 3, del: 2, eventKey: 'tool:10' })
    expect(out[1]).toMatchObject({ add: 2, del: 0, eventKey: 'tool:12' })
  })
  it('sums a MultiEdit and ignores other tools and failed edits', () => {
    const evs = [
      start('MultiEdit', { file_path: '/r/m.ts', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd\ne' }] }, 'm1', 20),
      start('Read', { file_path: '/r/m.ts' }, 'r1', 21),
      start('Edit', { file_path: '/r/bad.ts', old_string: 'a', new_string: 'b' }, 'x1', 22),
      end('x1', false, 23),
    ]
    const out = changedFiles(evs)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ path: '/r/m.ts', add: 3, del: 2 })
  })
  it('is empty without edits', () => { expect(changedFiles([])).toEqual([]) })
  it('a subagent\'s edits count, and its row is reached through its card', () => {
    const evs: Event[] = [
      { seq: 1, session: 's', ts: 1, kind: 'tool_start', data: { id: 'tu', name: 'Agent', summary: '', input: { description: 'fix' } } },
      { seq: 2, session: 's', ts: 1, kind: 'agent_start', data: { id: 'ag', type: 'x', description: 'fix', tool: 'tu' } },
      { seq: 3, session: 's', ts: 1, kind: 'tool_start', data: { id: 'e', name: 'Edit', agent: 'ag', input: { file_path: '/r/sub.ts', old_string: 'a', new_string: 'b' } } },
      { seq: 4, session: 's', ts: 1, kind: 'tool_end', data: { id: 'e', ok: true, output: '', agent: 'ag' } },
    ]
    const items = buildTimeline(evs, '')
    const files = changedFilesOf(items)
    expect(files).toEqual([{ path: '/r/sub.ts', add: 1, del: 1, eventKey: 'tool:3' }])
    expect(partitionTimeline(items).owner.get(files[0].eventKey)).toBe('agent:1')
  })
})
