import { describe, expect, it } from 'vitest'
import { addArgs, parseQueue, taskTextError } from './afterQueue'

describe('afterQueue helpers', () => {
  it('queues text literally with the -- marker so it is never parsed as a subcommand', () => {
    // The plugin treats "edit the README" as a smart (model-resolved) command and "undo" alone as undo
    expect(addArgs('edit the README')).toBe('-- edit the README')
    expect(addArgs('  undo  ')).toBe('-- undo')
    expect(addArgs('rm 2')).toBe('-- rm 2')
  })
  it('rejects newlines, a leading slash and empty text', () => {
    expect(taskTextError('a\nb')).toBe('Use one line that does not start with /')
    expect(taskTextError('/clear')).toBe('Use one line that does not start with /')
    expect(taskTextError('  ')).toBe('Use one line that does not start with /')
    expect(taskTextError('fine')).toBe('')
  })
  it('tolerates missing and malformed fields', () => {
    expect(parseQueue(null)).toBeNull()
    expect(parseQueue('x')).toBeNull()
    expect(parseQueue({})).toEqual({ items: [], running: null, paused: false })
    expect(parseQueue({ items: [{ id: 3, text: 'a' }, { nope: 1 }], running: { id: 1, text: 'r' }, paused: true }))
      .toEqual({ items: [{ id: 3, text: 'a' }], running: { id: 1, text: 'r' }, paused: true })
  })
})
