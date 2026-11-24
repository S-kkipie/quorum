import { expect, test } from 'claude-code/testing'
import cases from './plugin-command-cases'

import { makeControl } from '../src/control'
import type { Link } from '../src/link'
import { runPluginCommand, validatePluginCommand } from '../src/plugincmd'
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

test('runPluginCommand runs the command through $.command.run', async () => {
  const calls: string[] = []
  const r = await runPluginCommand({
    commandRun: async (command, args) => { calls.push(`run:${command}:${args}`) },
  }, 'after', 'fix the build')
  expect(r).toEqual({ ok: true })
  expect(calls).toEqual(['run:after:fix the build'])
})

test('runPluginCommand refuses an invalid command without running anything', async () => {
  const calls: string[] = []
  const r = await runPluginCommand({
    commandRun: async (command, args) => { calls.push(`run:${command}:${args}`) },
  }, 'rm', 'x')
  expect(r.ok).toBe(false)
  expect(typeof r.error).toBe('string')
  expect(calls).toEqual([])
})

test('runPluginCommand reports a rejected run as an English error', async () => {
  const r = await runPluginCommand({
    commandRun: async () => { throw new Error('unknown command') },
  }, 'after', 'x')
  expect(r.ok).toBe(false)
  expect(r.error).toContain('unknown command')
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
    sleep: async () => {},
    runPlugin: async (command, args) => { runs.push([command, args]); return { ok: true } },
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

test('control.handle plugin run failure → info', async () => {
  const evs: Array<{ kind: string; data: any }> = []
  const link = { role: 'work', emit: (e: any) => evs.push(e), update: () => {} } as unknown as Link
  const control = makeControl({
    getLink: () => link,
    submit: async () => {}, abort: async () => {}, stopTask: async () => {}, exit: async () => {}, sleep: async () => {},
    runPlugin: async () => ({ ok: false, error: 'Could not run /after: boom' }),
  })
  await control.handle(cmd({ type: 'plugin', command: 'after', args: 'x' }))
  expect(evs.filter(e => e.kind === 'info').map(e => e.data.text)).toEqual(['Could not run /after: boom'])
})

// The same table is read by the hub's Go validator (internal/hub/plugincmd_test.go).
test('validatePluginCommand matches the shared cases', () => {
  for (const c of cases) {
    expect(validatePluginCommand(c.command, c.args) === null, `${c.note}: ${c.command} ${JSON.stringify(c.args.slice(0, 20))}`).toBe(c.ok)
  }
})
