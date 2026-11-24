import { expect, test } from 'claude-code/testing'
import cases from './plugin-command-cases'

import { makeControl } from '../src/control'
import type { Link } from '../src/link'
import { TERMINAL_ONLY_ERROR, validatePluginCommand } from '../src/plugincmd'
import type { Command } from '../src/proto.gen'

const cmd = (c: Partial<Command>): Command =>
  ({ type: '', text: '', mode: '', askId: '', decision: '', reason: '', answers: null as never, command: '', args: '', ...c })

test('validatePluginCommand: allow-list, length, control chars, timeline args', () => {
  expect(validatePluginCommand('after', 'fix the build')).toBe(null)
  expect(validatePluginCommand('before', 'first this')).toBe(null)
  expect(typeof validatePluginCommand('rm', 'x')).toBe('string')
  expect(typeof validatePluginCommand('after', 'a\nb')).toBe('string')
  expect(typeof validatePluginCommand('after', 'a\tb')).toBe('string')
  expect(validatePluginCommand('after', 'x'.repeat(2000))).toBe(null)
  expect(typeof validatePluginCommand('after', 'x'.repeat(2001))).toBe('string')
  expect(validatePluginCommand('timeline', 'undo')).toBe(null)
  expect(validatePluginCommand('timeline', 'redo')).toBe(null)
  expect(validatePluginCommand('timeline', '42')).toBe(null)
  expect(typeof validatePluginCommand('timeline', '12345')).toBe('string')
  expect(typeof validatePluginCommand('timeline', '3; rm')).toBe('string')
  expect(typeof validatePluginCommand('timeline', '')).toBe('string')
})

function fake() {
  const runs: Array<[string, string]> = []
  const evs: Array<{ kind: string; data: any }> = []
  const link = { role: 'work', emit: (e: any) => evs.push(e), update: () => {} } as unknown as Link
  const control = makeControl({
    getLink: () => link,
    submit: async () => {},
    abort: async () => {},
    stopTask: async () => {},
    exit: async () => {},
    sleep: () => new Promise(() => {}),
    commandRun: async (command, args) => { runs.push([command, args]) },
  })
  return { control, runs, evs }
}

test('control.handle plugin → runs the command once', async () => {
  const f = fake()
  await f.control.handle(cmd({ type: 'plugin', command: 'after', args: 'x' }))
  expect(f.runs).toEqual([['after', 'x']])
})

test('control.handle invalid plugin command → info with the error, nothing runs', async () => {
  const f = fake()
  await f.control.handle(cmd({ type: 'plugin', command: 'rm', args: 'x' }))
  expect(f.runs).toEqual([])
  const infos = f.evs.filter(e => e.kind === 'info')
  expect(infos.length).toBe(1)
  expect(infos[0].data.text).toBe(validatePluginCommand('rm', 'x'))
})

// `plugin` is a thin alias of `command` (Plan 8): the Plan 6 allow-list, then the same run and events.
test('control.handle plugin run failure → failed command event', async () => {
  const evs: Array<{ kind: string; data: any }> = []
  const link = { role: 'work', emit: (e: any) => evs.push(e), update: () => {} } as unknown as Link
  const control = makeControl({
    getLink: () => link,
    submit: async () => {}, abort: async () => {}, stopTask: async () => {}, exit: async () => {}, sleep: () => new Promise(() => {}),
    commandRun: async () => { throw new Error('boom') },
  })
  await control.handle(cmd({ type: 'plugin', command: 'after', args: 'x' }))
  const c = evs.filter(e => e.kind === 'command').map(e => e.data)
  expect(c.length).toBe(1)
  expect(c[0].status).toBe('failed')
  expect(c[0].error).toBe('Could not run /after: boom')
})

test('control.handle plugin: bare /after is terminal-only (it opens a pane), nothing runs', async () => {
  const f = fake()
  await f.control.handle(cmd({ type: 'plugin', command: 'after', args: '  ' }))
  expect(f.runs).toEqual([])
  const infos = f.evs.filter(e => e.kind === 'info')
  expect(infos.map(e => e.data.text)).toEqual([TERMINAL_ONLY_ERROR])
})

// The same table is read by the hub's Go validator (internal/hub/plugincmd_test.go).
test('validatePluginCommand matches the shared cases', () => {
  for (const c of cases) {
    expect(validatePluginCommand(c.command, c.args) === null, `${c.note}: ${c.command} ${JSON.stringify(c.args.slice(0, 20))}`).toBe(c.ok)
  }
})
