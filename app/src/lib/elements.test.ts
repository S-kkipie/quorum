import { describe, expect, it } from 'vitest'
import { messageRole, toolView } from './elements'
import type { ReadsItem, ToolItem, ToolState } from './timeline'

const tool = (o: Partial<ToolItem> = {}): ToolItem => ({ t: 'tool', seq: 1, id: 't', name: 'Bash', kind: 'bash', title: 'List files', state: 'ok', ...o })

describe('toolView', () => {
  it('maps each tool state', () => {
    const cases: [ToolState, string][] = [['running', 'running'], ['ok', 'done'], ['error', 'error'], ['denied', 'denied']]
    for (const [s, want] of cases) expect(toolView(tool({ state: s })).state).toBe(want)
  })
  it('keeps the title and kind', () => {
    expect(toolView(tool())).toEqual({ title: 'List files', icon: 'bash', state: 'done' })
  })
  it('edit with a diff carries +add −del as meta', () => {
    expect(toolView(tool({ name: 'Edit', kind: 'edit', title: 'Edited a.go', diff: { add: 12, del: 3 } })).meta).toBe('+12 −3')
  })
  it('merged reads show as a read', () => {
    const r: ReadsItem = { t: 'reads', seq: 1, files: ['a', 'b'], title: 'Read a and 1 more', state: 'running', tools: [] }
    expect(toolView(r)).toEqual({ title: 'Read a and 1 more', icon: 'read', state: 'running' })
  })
})

describe('messageRole', () => {
  it('maps user, assistant and info', () => {
    expect(messageRole({ t: 'user', seq: 1, text: '' })).toBe('user')
    expect(messageRole({ t: 'assistant', seq: 1, text: '' })).toBe('assistant')
    expect(messageRole({ t: 'info', seq: 1, text: '' })).toBe('system')
  })
  it('timeline actions belong to the assistant', () => {
    expect(messageRole(tool())).toBe('assistant')
    expect(messageRole({ t: 'artifact', seq: 1, path: '/p/a.html', name: 'a.html', inBase: true })).toBe('assistant')
  })
})
