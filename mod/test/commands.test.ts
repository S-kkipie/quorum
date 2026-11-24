import { expect, test } from 'claude-code/testing'

import {
  BUILTIN_RUNNABLE, COMMAND_TEXT_MAX, COMMAND_WAIT_MS, COMPACT_WAIT_MS, DEFAULT_EFFORTS, TERMINAL_ONLY_ERROR, effortFromStop, effortOptions,
  hashCommands, makeCommandsReporter, modelOptions, toSessionCommands, validateCommand,
} from '../src/commands'
import { makeControl } from '../src/control'
import type { Link } from '../src/link'
import { validatePluginCommand } from '../src/plugincmd'
import type { Command, SessionCommand } from '../src/proto.gen'
import cases from './plugin-command-cases'

const cmd = (c: Partial<Command>): Command =>
  ({ type: '', text: '', mode: '', askId: '', decision: '', reason: '', answers: null as never, command: '', args: '', ...c })

// A list shaped like the real $.command.list() (Claude Code 2.1.331)
const LIST = [
  { name: 'humanizer', description: 'Rewrite AI-sounding text', source: 'user' },
  { name: 'deep-research', description: 'Deep research harness', source: 'builtin' },
  { name: 'superpowers:brainstorming', description: 'Brainstorm first', source: 'plugin', plugin: 'superpowers' },
  { name: 'dataviz', description: 'Charts', source: 'builtin' },
  { name: 'compact', description: 'Free up context', source: 'builtin' },
  { name: 'config', description: 'Set a setting by key', source: 'builtin' },
  { name: 'resume', description: 'Resume a conversation', source: 'builtin' },
  { name: 'model', description: 'Set the AI model', source: 'builtin' },
  { name: 'after', description: 'Queue a task', source: 'plugin', plugin: 'after' },
  { name: 'timeline', description: 'Time Machine', source: 'plugin', plugin: 'time-machine' },
  { name: 'mcp__github__review', description: 'Review a PR', source: 'mcp' },
  { name: 'my-command', description: 'A project command', source: 'user' },
] as const
// what the context's skill listing reports ($.session.usage({ breakdown }).context.breakdown.skills)
const SKILLS = [
  { name: 'humanizer', source: 'userSettings' },
  { name: 'superpowers:brainstorming', source: 'plugin', pluginName: 'superpowers' },
  { name: 'dataviz', source: 'built-in' },
]

const byName = (l: SessionCommand[]) => Object.fromEntries(l.map(c => [c.name, c]))

test('toSessionCommands keeps the order and maps source, plugin, group and terminal-only', () => {
  const out = toSessionCommands(LIST as never, SKILLS as never)
  expect(out.map(c => c.name)).toEqual(LIST.map(c => c.name))
  const m = byName(out)
  expect(m['humanizer']).toEqual({ name: 'humanizer', description: 'Rewrite AI-sounding text', source: 'user', plugin: '', group: 'skill', terminalOnly: false })
  expect(m['superpowers:brainstorming']!.group).toBe('skill')
  expect(m['superpowers:brainstorming']!.plugin).toBe('superpowers')
  expect(m['dataviz']!.group).toBe('skill')
  expect(m['deep-research']!.group).toBe('session')
  expect(m['compact']!.group).toBe('session')
  expect(m['after']!.group).toBe('plugin')
  expect(m['mcp__github__review']!.group).toBe('mcp')
  // listing known: a user command that is not a skill stays a session command
  expect(m['my-command']!.group).toBe('session')
  expect(m['config']!.terminalOnly).toBe(true)
  expect(m['resume']!.terminalOnly).toBe(true)
  expect(m['compact']!.terminalOnly).toBe(false)
  // deep-research is not in this version's binary nor in the skill listing: terminal-only by default
  expect(m['deep-research']!.terminalOnly).toBe(true)
  // /model and /effort confirm a switch in a dialog when the cache may be warm: terminal-only
  expect(m['model']!.terminalOnly).toBe(true)
  // a bare-only pane is decided at run time
  expect(m['after']!.terminalOnly).toBe(false)
})

test('toSessionCommands without the skill listing: user → skill, `<plugin>:<name>` → skill', () => {
  const m = byName(toSessionCommands(LIST as never, undefined))
  expect(m['humanizer']!.group).toBe('skill')
  expect(m['my-command']!.group).toBe('skill')
  expect(m['superpowers:brainstorming']!.group).toBe('skill')
  expect(m['after']!.group).toBe('plugin')
  expect(m['dataviz']!.group).toBe('session')
})

test('toSessionCommands drops malformed rows and bounds the strings', () => {
  const out = toSessionCommands([
    { name: '', description: 'x', source: 'builtin' },
    null,
    { name: 'ok', description: 'd'.repeat(5000), source: 'weird' },
  ] as never, undefined)
  expect(out.length).toBe(1)
  expect(out[0]!.source).toBe('builtin')
  expect(out[0]!.description.length <= 300).toBe(true)
})

test('built-ins are an allowlist: interactive ones and unknown ones are terminal-only', () => {
  for (const n of ['config', 'resume', 'login', 'logout', 'permissions', 'mcp', 'plugin', 'hooks', 'ide',
    'memory', 'theme', 'vim', 'terminal-setup', 'statusline', 'export', 'bug', 'feedback', 'rewind',
    'diff', 'usage', 'artifacts', 'workflows', 'session', 'install', 'import', 'rename', 'color', 'branch',
    'fork', 'btw', 'plan', 'goal', 'background', 'advisor', 'ultraplan', 'ultrareview', 'subtask', 'cd',
    'exit', 'context', 'restart', 'voice', 'stickers', 'radio', 'keybindings', 'model', 'effort', 'output-style']) {
    expect(BUILTIN_RUNNABLE.has(n), n).toBe(false)
    const m = byName(toSessionCommands([{ name: n, description: '', source: 'builtin' }] as never, []))
    expect(m[n]!.terminalOnly, n).toBe(true)
  }
  // a built-in this Claude Code version did not ship (a future one) is terminal-only by default
  const future = byName(toSessionCommands([{ name: 'brand-new-thing', description: '', source: 'builtin' }] as never, []))
  expect(future['brand-new-thing']!.terminalOnly).toBe(true)
  // the non-interactive ones run
  for (const n of ['clear', 'compact', 'recap', 'reload-plugins', 'init', 'batch', 'debug']) {
    expect(byName(toSessionCommands([{ name: n, description: '', source: 'builtin' }] as never, []))[n]!.terminalOnly, n).toBe(false)
  }
  // a bundled skill (in the skill listing) runs even if not in the allowlist
  expect(byName(toSessionCommands([{ name: 'dataviz', description: '', source: 'builtin' }] as never, [{ name: 'dataviz' }]))['dataviz']!.terminalOnly).toBe(false)
  // plugin, user and MCP commands stay runnable, whatever their name
  for (const source of ['plugin', 'user', 'mcp']) {
    expect(byName(toSessionCommands([{ name: 'config', description: '', source }] as never, []))['config']!.terminalOnly, source).toBe(false)
  }
})

test('hashCommands: same list same hash, any change another', () => {
  const a = toSessionCommands(LIST as never, SKILLS as never)
  const b = toSessionCommands(LIST as never, SKILLS as never)
  expect(hashCommands(a)).toBe(hashCommands(b))
  expect(hashCommands(a).length >= 8).toBe(true)
  const c = toSessionCommands([...LIST, { name: 'new', description: '', source: 'user' }] as never, SKILLS as never)
  expect(hashCommands(c) === hashCommands(a)).toBe(false)
})

test('validateCommand: unknown, terminal-only, bare panes and the args rules', () => {
  const list = toSessionCommands(LIST as never, SKILLS as never)
  expect(validateCommand(list, 'nope', '')).toBe('Unknown command: /nope')
  expect(validateCommand(undefined, 'compact', '')).toBe('The command list of this session is not available yet')
  expect(validateCommand(list, 'config', '')).toBe(TERMINAL_ONLY_ERROR)
  expect(TERMINAL_ONLY_ERROR).toBe('This command only works in the terminal.')
  expect(validateCommand(list, 'model', '')).toBe(TERMINAL_ONLY_ERROR)
  expect(validateCommand(list, 'model', 'opus')).toBe(TERMINAL_ONLY_ERROR)
  expect(validateCommand(list, 'after', '')).toBe(TERMINAL_ONLY_ERROR)
  expect(validateCommand(list, 'after', 'fix the build')).toBe(null)
  expect(validateCommand(list, 'timeline', '')).toBe(TERMINAL_ONLY_ERROR)
  expect(validateCommand(list, 'timeline', 'undo')).toBe(null)
  expect(typeof validateCommand(list, 'timeline', '3; rm')).toBe('string')
  expect(validateCommand(list, 'compact', '')).toBe(null)
  expect(validateCommand(list, 'humanizer', 'this text')).toBe(null)
  expect(typeof validateCommand(list, 'humanizer', 'a\nb')).toBe('string')
  expect(typeof validateCommand(list, 'humanizer', 'x'.repeat(2001))).toBe('string')
})

// The Plan 6 rules are now the generic args rules: the shared table still holds for both.
test('validateCommand (listed better-claude commands) and validatePluginCommand agree with the shared cases', () => {
  const listed = ['after', 'before', 'timeline'].map(name => ({ name, description: '', source: 'plugin', plugin: 'better-claude', group: 'plugin', terminalOnly: false }))
  for (const c of cases) {
    expect(validatePluginCommand(c.command, c.args) === null, c.note).toBe(c.ok)
    if (listed.some(x => x.name === c.command)) expect(validateCommand(listed, c.command, c.args) === null, c.note).toBe(c.ok)
  }
})

const ROWS = [
  { key: 'theme', label: 'Theme', kind: 'choice', value: 'auto', options: ['auto', 'dark'] },
  { key: 'model', label: 'Model', kind: 'choice', value: 'opus', options: ['default', 'sonnet', 'opus', 'haiku', 'opus[1m]', 'mystery'] },
]

test('modelOptions: from the /config Model row, labelled; defaults without it', () => {
  const o = modelOptions(ROWS as never)
  expect(o.map(x => x.value)).toEqual(['default', 'sonnet', 'opus', 'haiku', 'opus[1m]', 'mystery'])
  expect(o.find(x => x.value === 'opus')!.label).toBe('Opus')
  expect(o.find(x => x.value === 'opus[1m]')!.label).toBe('Opus (1M context)')
  expect(o.find(x => x.value === 'mystery')!.label).toBe('Mystery')
  expect(o.find(x => x.value === 'sonnet')!.description.length > 0).toBe(true)
  const d = modelOptions(undefined)
  expect(d.map(x => x.value)).toEqual(['default', 'opus', 'sonnet', 'haiku'])
})

test('effortOptions: from an effort row when present, else the five levels', () => {
  expect(effortOptions(ROWS as never)).toEqual(DEFAULT_EFFORTS)
  expect(DEFAULT_EFFORTS).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  expect(effortOptions([{ key: 'effortLevel', label: 'Effort', kind: 'choice', value: 'high', options: ['low', 'high'] }] as never)).toEqual(['low', 'high'])
})

test('effortFromStop reads effort.level', () => {
  expect(effortFromStop({ effort: { level: 'xhigh' } })).toBe('xhigh')
  expect(effortFromStop({})).toBe(undefined)
  expect(effortFromStop({ effort: { level: 42 } })).toBe(undefined)
})

function reporter(list: () => unknown[], rows: unknown[] = ROWS, accepted: () => boolean = () => true) {
  const sent: Array<{ commands: SessionCommand[]; hash: string }> = []
  const updates: Array<Record<string, unknown>> = []
  let skillCalls = 0
  const r = makeCommandsReporter({
    list: async () => list() as never,
    skills: async () => { skillCalls++; return SKILLS as never },
    config: async () => rows as never,
    model: async () => 'claude-opus-5-5',
    send: async p => { sent.push(p); return accepted() },
    update: p => updates.push(p as never),
  })
  return { r, sent, updates, skillCalls: () => skillCalls }
}

test('reporter: first check sends session_commands once; unchanged sends nothing; a change sends again', async () => {
  let l: unknown[] = [...LIST]
  const f = reporter(() => l)
  await f.r.check()
  expect(f.sent.length).toBe(1)
  expect(f.sent[0]!.hash).toBe(hashCommands(f.sent[0]!.commands))
  expect(f.r.current()!.length).toBe(LIST.length)
  await f.r.check()
  expect(f.sent.length).toBe(1)
  // the skill listing is read only when the raw list changed
  expect(f.skillCalls()).toBe(1)
  l = [...LIST, { name: 'reloaded', description: 'new skill', source: 'plugin', plugin: 'p' }]
  await f.r.check()
  expect(f.sent.length).toBe(2)
  expect(f.sent[1]!.commands.some(c => c.name === 'reloaded')).toBe(true)
})

test('reporter: a failed send is retried at the next check; a taken one is not', async () => {
  let ok = false
  const f = reporter(() => [...LIST], ROWS, () => ok)
  await f.r.check()
  expect(f.sent.length).toBe(1)
  await f.r.check()
  expect(f.sent.length).toBe(2) // the daemon did not take it: same list again
  ok = true
  await f.r.check()
  expect(f.sent.length).toBe(3)
  await f.r.check()
  expect(f.sent.length).toBe(3)
})

test('reporter: concurrent checks run once', async () => {
  const f = reporter(() => [...LIST])
  await Promise.all([f.r.check(), f.r.check(), f.r.check()])
  expect(f.sent.length).toBe(1)
})

test('reporter: a failing list sends nothing and never throws', async () => {
  const f = reporter(() => { throw new Error('no api') })
  await f.r.check()
  expect(f.sent.length).toBe(0)
  expect(f.r.current()).toBe(undefined)
})

test('reporter: model and effort options updated once, again only on change; effort from Stop', async () => {
  const f = reporter(() => [...LIST])
  await f.r.check()
  const opts = f.updates.filter(u => 'modelOptions' in u)
  expect(opts.length).toBe(1)
  expect((opts[0]!.effortOptions as string[])).toEqual(DEFAULT_EFFORTS)
  await f.r.check()
  expect(f.updates.filter(u => 'modelOptions' in u).length).toBe(1)
  f.r.effort('high')
  f.r.effort('high')
  f.r.effort(undefined)
  expect(f.updates.filter(u => 'effort' in u)).toEqual([{ effort: 'high' }])
})

test('reporter: the model is re-read and updated only when it changed', async () => {
  let model = 'claude-opus-5-5'
  const updates: Array<Record<string, unknown>> = []
  const r = makeCommandsReporter({
    list: async () => [...LIST] as never, skills: async () => SKILLS as never, config: async () => ROWS as never,
    model: async () => model, send: () => {}, update: p => updates.push(p as never), initialModel: 'claude-opus-5-5',
  })
  await r.check()
  expect(updates.filter(u => 'model' in u).length).toBe(0)
  model = 'claude-sonnet-5'
  await r.check()
  expect(updates.filter(u => 'model' in u)).toEqual([{ model: 'claude-sonnet-5' }])
})

// --- the `command` device command

function fake(opts: {
  list?: SessionCommand[] | undefined; refreshed?: SessionCommand[]; run?: (c: string, a: string) => Promise<unknown>
  setModel?: (v: string) => Promise<{ value?: unknown; deny?: string }>
  settled?: (ok: boolean) => void
  options?: () => ReturnType<typeof modelOptions> | undefined
  onRefresh?: () => void
} = {}) {
  // sleeps resolve only when the test fires them (the 30 s command wait)
  const sleeps: Array<{ ms: number; fire: () => void }> = []
  const runs: Array<[string, string]> = []
  const evs: Array<{ kind: string; data: any }> = []
  const link = { role: 'work', emit: (e: any) => evs.push(e), update: () => {} } as unknown as Link
  let list = 'list' in opts ? opts.list : toSessionCommands(LIST as never, SKILLS as never)
  let n = 0
  let refreshes = 0
  const control = makeControl({
    getLink: () => link,
    submit: async () => {}, abort: async () => {}, stopTask: async () => {}, exit: async () => {},
    sleep: ms => new Promise<void>(r => { sleeps.push({ ms, fire: r }) }),
    commandRun: async (c, a) => { runs.push([c, a]); return opts.run ? opts.run(c, a) : { text: 'ok' } },
    setModel: async v => { runs.push(['set_model', v]); return opts.setModel ? opts.setModel(v) : { value: v } },
    commands: () => list,
    modelOptions: opts.options ?? (() => modelOptions(ROWS as never)),
    refreshCommands: async () => { refreshes++; opts.onRefresh?.(); if (opts.refreshed) list = opts.refreshed },
    commandSettled: (_n, _a, ok) => opts.settled?.(ok),
    newId: () => `id${++n}`,
  })
  const cmds = () => evs.filter(e => e.kind === 'command').map(e => e.data)
  const waits = () => sleeps.filter(x => x.ms === COMMAND_WAIT_MS || x.ms === COMPACT_WAIT_MS)
  return { control, runs, evs, cmds, refreshes: () => refreshes, waits }
}

test('command: unknown name → one re-check, then one failed event, nothing runs', async () => {
  const f = fake()
  await f.control.handle(cmd({ type: 'command', command: 'nope', args: '' }))
  expect(f.refreshes()).toBe(1)
  expect(f.runs).toEqual([])
  expect(f.cmds()).toEqual([{ id: 'id1', name: 'nope', args: '', origin: 'device', status: 'failed', error: 'Unknown command: /nope' }])
})

test('command: a name added since the last list (plugin reload) runs after the re-check', async () => {
  const f = fake({ refreshed: toSessionCommands([...LIST, { name: 'fresh', description: '', source: 'plugin', plugin: 'p' }] as never, SKILLS as never) })
  await f.control.handle(cmd({ type: 'command', command: 'fresh', args: 'x' }))
  expect(f.refreshes()).toBe(1)
  expect(f.runs).toEqual([['fresh', 'x']])
  expect(f.cmds().map(c => c.status)).toEqual(['done'])
})

test('command: a known name never triggers a re-check', async () => {
  const f = fake()
  await f.control.handle(cmd({ type: 'command', command: 'resume', args: '' }))
  await f.control.handle(cmd({ type: 'command', command: 'compact', args: '' }))
  expect(f.refreshes()).toBe(0)
})

test('command: terminal-only → failed with the terminal message', async () => {
  const f = fake()
  await f.control.handle(cmd({ type: 'command', command: 'resume', args: '' }))
  expect(f.runs).toEqual([])
  expect(f.cmds().map(c => [c.status, c.error])).toEqual([['failed', 'This command only works in the terminal.']])
})

test('command: bad args → failed, nothing runs', async () => {
  const f = fake()
  await f.control.handle(cmd({ type: 'command', command: 'humanizer', args: 'a\nb' }))
  expect(f.runs).toEqual([])
  expect(f.cmds()[0].status).toBe('failed')
})

test('command: no list reported yet → failed', async () => {
  const f = fake({ list: undefined })
  await f.control.handle(cmd({ type: 'command', command: 'compact', args: '' }))
  expect(f.runs).toEqual([])
  expect(f.cmds()[0].status).toBe('failed')
})

test('command: idle → runs once, done with the text', async () => {
  const f = fake()
  await f.control.handle(cmd({ type: 'command', command: 'compact', args: '' }))
  expect(f.runs).toEqual([['compact', '']])
  expect(f.cmds()).toEqual([{ id: 'id1', name: 'compact', args: '', origin: 'device', status: 'done', text: 'ok' }])
})

test('command: during a turn → queued, then done when run settles (same id)', async () => {
  let release!: (v: unknown) => void
  const f = fake({ run: () => new Promise(r => { release = r }) })
  f.control.turnStart({ turnId: 't1' })
  const p = f.control.handle(cmd({ type: 'command', command: 'compact', args: 'keep it' }))
  await new Promise(r => setTimeout(r, 0))
  expect(f.cmds().map(c => c.status)).toEqual(['queued'])
  release({ text: 'Compacted' })
  await p
  expect(f.runs).toEqual([['compact', 'keep it']])
  expect(f.cmds().map(c => [c.id, c.status, c.text])).toEqual([['id1', 'queued', undefined], ['id1', 'done', 'Compacted']])
})

const flush = () => new Promise(r => setTimeout(r, 0))

test('command: no answer 30 s after it started → failed "Waiting for an answer in the terminal.", then the late answer corrects it (same id)', async () => {
  let release!: (v: unknown) => void
  const settled: boolean[] = []
  const f = fake({ run: () => new Promise(r => { release = r }), settled: ok => settled.push(ok) })
  const p = f.control.handle(cmd({ type: 'command', command: 'humanizer', args: '' }))
  await flush()
  expect(f.waits().map(w => w.ms)).toEqual([COMMAND_WAIT_MS])
  f.waits()[0]!.fire()
  await p
  expect(f.cmds()).toEqual([{ id: 'id1', name: 'humanizer', args: '', origin: 'device', status: 'failed', error: 'Waiting for an answer in the terminal.' }])
  expect(settled).toEqual([])
  // the command is not cancelled: its late answer is the final status, with the same id
  release({ text: 'late' })
  await flush()
  expect(f.cmds().map(c => [c.id, c.status, c.text ?? c.error])).toEqual([
    ['id1', 'failed', 'Waiting for an answer in the terminal.'], ['id1', 'done', 'late'],
  ])
  expect(settled).toEqual([true])
})

test('command: a late rejection after the wait → final failed with the reason (same id)', async () => {
  let fail!: (e: unknown) => void
  const settled: boolean[] = []
  const f = fake({ run: () => new Promise((_, j) => { fail = j }), settled: ok => settled.push(ok) })
  const p = f.control.handle(cmd({ type: 'command', command: 'humanizer', args: '' }))
  await flush()
  f.waits()[0]!.fire()
  await p
  fail(new Error('boom'))
  await flush()
  expect(f.cmds().map(c => [c.id, c.status, c.error])).toEqual([
    ['id1', 'failed', 'Waiting for an answer in the terminal.'], ['id1', 'failed', 'Could not run /humanizer: boom'],
  ])
  expect(settled).toEqual([false])
})

test('command: /compact gets a 300 s budget, others 30 s', async () => {
  expect(COMPACT_WAIT_MS).toBe(300_000)
  const f = fake({ run: () => new Promise(() => {}) })
  void f.control.handle(cmd({ type: 'command', command: 'compact', args: '' }))
  await flush()
  expect(f.waits().map(w => w.ms)).toEqual([COMPACT_WAIT_MS])
})

test('command: queued behind a turn, the 30 s start only when the turn ends', async () => {
  const f = fake({ run: () => new Promise(() => {}) })
  f.control.turnStart({ turnId: 't1' })
  const p = f.control.handle(cmd({ type: 'command', command: 'humanizer', args: '' }))
  await flush()
  expect(f.cmds().map(c => c.status)).toEqual(['queued'])
  expect(f.waits().length).toBe(0)
  // a subagent's end is not the turn's
  f.control.turnEnd({ agentId: 'a1' })
  await flush()
  expect(f.waits().length).toBe(0)
  f.control.turnEnd({})
  await flush()
  expect(f.waits().length).toBe(1)
  f.waits()[0]!.fire()
  await p
  expect(f.cmds().map(c => [c.status, c.error])).toEqual([['queued', undefined], ['failed', 'Waiting for an answer in the terminal.']])
})

test('command: queued, a turn starts again before the wait ran out → the clock restarts at the end after which none runs', async () => {
  const f = fake({ run: () => new Promise(() => {}) })
  f.control.turnStart({ turnId: 't1' })
  const p = f.control.handle(cmd({ type: 'command', command: 'humanizer', args: '' }))
  await flush()
  f.control.turnEnd({})
  await flush()
  // another queued prompt runs first: its turn starts while the first wait is pending
  f.control.turnStart({ turnId: 't2' })
  f.waits()[0]!.fire()
  await flush()
  expect(f.cmds().map(c => c.status)).toEqual(['queued'])
  expect(f.waits().length).toBe(1)
  f.control.turnEnd({})
  await flush()
  expect(f.waits().length).toBe(2)
  f.waits()[1]!.fire()
  await p
  expect(f.cmds().map(c => c.status)).toEqual(['queued', 'failed'])
})

test('command: settled while the session stays busy → its wait stops re-arming (no further sleeps)', async () => {
  let release!: (v: unknown) => void
  const f = fake({ run: () => new Promise(r => { release = r }) })
  const p = f.control.handle(cmd({ type: 'command', command: 'humanizer', args: '' }))
  await flush()
  expect(f.waits().length).toBe(1)
  // the command's own turn starts, then the command settles mid-turn
  f.control.turnStart({ turnId: 't1' })
  release({ text: 'ok' })
  await p
  expect(f.cmds().map(c => c.status)).toEqual(['done'])
  // its first sleep ends during the busy session: no turn-end wait and no new sleep
  f.waits()[0]!.fire()
  await flush()
  f.control.turnEnd({})
  await flush()
  f.control.turnStart({ turnId: 't2' })
  f.control.turnEnd({})
  await flush()
  expect(f.waits().length).toBe(1)
})

test('set_model: validated against the reported options, set through config, reported as a model command', async () => {
  const f = fake()
  await f.control.handle(cmd({ type: 'set_model', value: 'sonnet' } as never))
  expect(f.runs).toEqual([['set_model', 'sonnet']])
  expect(f.cmds()).toEqual([{ id: 'id1', name: 'model', args: 'sonnet', origin: 'device', status: 'done', text: 'Set model to Sonnet' }])
})

test('set_model: a value not in the options → failed, nothing set', async () => {
  const f = fake()
  await f.control.handle(cmd({ type: 'set_model', value: 'gpt' } as never))
  await f.control.handle(cmd({ type: 'set_model', value: '' } as never))
  expect(f.runs).toEqual([])
  expect(f.cmds().map(c => [c.name, c.status, c.error])).toEqual([
    ['model', 'failed', 'Unknown model: gpt'], ['model', 'failed', 'Unknown model: '],
  ])
})

test('set_model: a refusal (deny) or a rejection → failed with the reason', async () => {
  const f = fake({ setModel: async () => ({ deny: 'confirmation required (run /model to confirm)' }) })
  await f.control.handle(cmd({ type: 'set_model', value: 'haiku' } as never))
  expect(f.cmds()[0]).toEqual({ id: 'id1', name: 'model', args: 'haiku', origin: 'device', status: 'failed', error: 'confirmation required (run /model to confirm)' })
  const g = fake({ setModel: async () => { throw new Error('no row') } })
  await g.control.handle(cmd({ type: 'set_model', value: 'haiku' } as never))
  expect(g.cmds()[0].error).toBe('Could not set the model: no row')
})

test('set_model: during a turn → applied at once, never queued', async () => {
  const f = fake()
  f.control.turnStart({ turnId: 't1' })
  await f.control.handle(cmd({ type: 'set_model', value: 'sonnet' } as never))
  expect(f.runs).toEqual([['set_model', 'sonnet']])
  expect(f.cmds().map(c => c.status)).toEqual(['done'])
})

test('set_model: no options read yet → one refresh, then validated', async () => {
  let opts: ReturnType<typeof modelOptions> | undefined
  // the refresh (the reporter's check) is what reads the options
  const f = fake({ options: () => opts, onRefresh: () => { opts = modelOptions(ROWS as never) } })
  await f.control.handle(cmd({ type: 'set_model', value: 'haiku' } as never))
  expect(f.refreshes()).toBe(1)
  expect(f.runs).toEqual([['set_model', 'haiku']])
  expect(f.cmds().map(c => c.status)).toEqual(['done'])
})

test('set_model: options known → no refresh', async () => {
  const f = fake()
  await f.control.handle(cmd({ type: 'set_model', value: 'haiku' } as never))
  expect(f.refreshes()).toBe(0)
})

test('set_model: settles → the reporter re-checks (the model it reads is the new one)', async () => {
  const settled: Array<[string, string, boolean]> = []
  const evs: any[] = []
  const link = { role: 'work', emit: (e: any) => evs.push(e), update: () => {} } as unknown as Link
  const control = makeControl({
    getLink: () => link,
    submit: async () => {}, abort: async () => {}, stopTask: async () => {}, exit: async () => {}, sleep: () => new Promise(() => {}),
    setModel: async v => ({ value: v }),
    modelOptions: () => modelOptions(ROWS as never),
    commandSettled: (n, a, ok) => settled.push([n, a, ok]),
  })
  await control.handle(cmd({ type: 'set_model', value: 'opus' } as never))
  expect(settled).toEqual([['model', 'opus', true]])
})

test('command: a rejected run → failed with the reason; output text capped', async () => {
  const f = fake({ run: async () => { throw new Error('unknown command') } })
  await f.control.handle(cmd({ type: 'command', command: 'compact', args: '' }))
  expect(f.cmds()[0].status).toBe('failed')
  expect(f.cmds()[0].error).toContain('unknown command')
  const g = fake({ run: async () => ({ text: 'x'.repeat(COMMAND_TEXT_MAX + 50) }) })
  await g.control.handle(cmd({ type: 'command', command: 'compact', args: '' }))
  expect(g.cmds()[0].text.length).toBe(COMMAND_TEXT_MAX)
  const h = fake({ run: async () => undefined })
  await h.control.handle(cmd({ type: 'command', command: 'compact', args: '' }))
  expect(h.cmds()[0]).toEqual({ id: 'id1', name: 'compact', args: '', origin: 'device', status: 'done' })
})

test('command: a service session runs nothing', async () => {
  const runs: string[] = []
  const evs: any[] = []
  const link = { role: 'service', emit: (e: any) => evs.push(e), update: () => {} } as unknown as Link
  const control = makeControl({
    getLink: () => link,
    submit: async () => {}, abort: async () => {}, stopTask: async () => {}, exit: async () => {}, sleep: () => new Promise(() => {}),
    commandRun: async c => { runs.push(c) },
    commands: () => toSessionCommands(LIST as never, SKILLS as never),
  })
  await control.handle(cmd({ type: 'command', command: 'compact', args: '' }))
  expect(runs).toEqual([])
})

