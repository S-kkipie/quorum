import { expect, test } from 'claude-code/testing'

import { trimInput } from '../src/trim'

const runes = (s: string) => Array.from(s).length

test('trimInput truncates strings to 2000 runes', () => {
  const out = trimInput('Bash', { command: 'x'.repeat(5000) })
  expect(runes(out.command as string)).toBe(2000)
  const emoji = '😀'.repeat(3000)
  const o2 = trimInput('Bash', { command: emoji })
  expect(runes(o2.command as string)).toBe(2000)
  expect(o2.command).toBe('😀'.repeat(2000))
})

test('trimInput keeps 50 elements of an array', () => {
  const out = trimInput('TodoWrite', { todos: Array.from({ length: 80 }, (_, i) => ({ content: `t${i}` })) })
  expect((out.todos as unknown[]).length).toBe(50)
})

test('trimInput of a 2 MB Write stays at <= 16384 bytes serialized and keeps file_path', () => {
  const out = trimInput('Write', { file_path: '/a/b.txt', content: 'y'.repeat(2_000_000), extra: 'z' })
  expect(new TextEncoder().encode(JSON.stringify(out)).length).toBeLessThanOrEqual(16384)
  expect(out.file_path).toBe('/a/b.txt')
})

test('trimInput over 16 KiB keeps only the table keys of the tool', () => {
  const big = Array.from({ length: 50 }, (_, i) => `k${i}`)
  const input: Record<string, unknown> = {}
  for (const k of big) input[k] = 'v'.repeat(1000)
  input.query = 'q'
  const out = trimInput('WebSearch', input)
  expect(Object.keys(out)).toEqual(['query'])
  const other = trimInput('Mystery', input)
  expect(Object.keys(other)).toEqual(big.slice(0, 8))
})

test('trimInput removes tool, tool_use_id and agentId', () => {
  const out = trimInput('Bash', { tool: 'Bash', tool_use_id: 't1', agentId: 'a', command: 'ls' })
  expect(out).toEqual({ command: 'ls' })
})

test('trimInput tolerates non-object input', () => {
  expect(trimInput('Bash', undefined)).toEqual({})
  expect(trimInput('Bash', 'x')).toEqual({})
})

test('trimInput trims strings nested in arrays and objects', () => {
  const out = trimInput('MultiEdit', {
    file_path: '/f',
    edits: [{ old_string: 'a'.repeat(3000), new_string: 'b' }],
    nested: { deep: 'c'.repeat(3000) },
  }) as any
  expect(runes(out.edits[0].old_string)).toBe(2000)
  expect(runes(out.nested.deep)).toBe(2000)
})

test('trimInput halving fallback: over 16 KiB after the table keys shrinks strings to fit', () => {
  const todos = Array.from({ length: 50 }, (_, i) => ({ content: 'x'.repeat(2000), id: i }))
  const out = trimInput('TodoWrite', { todos, noise: 'n' })
  expect(Object.keys(out)).toEqual(['todos'])
  expect((out.todos as any[]).length).toBe(50)
  expect(new TextEncoder().encode(JSON.stringify(out)).length).toBeLessThanOrEqual(16384)
  expect(runes((out.todos as any[])[0].content)).toBeLessThan(2000)
})

test('trimInput pathological input (50 objects with many long keys) stays <= 16384 bytes', () => {
  const obj: Record<string, unknown> = {}
  for (let i = 0; i < 200; i++) obj['k'.repeat(500) + i] = 'v'.repeat(500)
  const edits = Array.from({ length: 50 }, () => ({ ...obj }))
  for (const tool of ['MultiEdit', 'TodoWrite', 'Mystery']) {
    const out = trimInput(tool, { file_path: '/f', edits, todos: edits, other: edits })
    expect(new TextEncoder().encode(JSON.stringify(out)).length).toBeLessThanOrEqual(16384)
  }
  const out = trimInput('Write', { file_path: '/f', content: 'z' })
  expect(out).toEqual({ file_path: '/f', content: 'z' })
})
