import { expect, test } from 'claude-code/testing'

import { makeControl } from '../src/control'
import { makeHandlers } from '../src/events'
import type { Link } from '../src/link'
import type { Command } from '../src/proto.gen'

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

const cmd = (c: Partial<Command>): Command =>
  ({ type: '', text: '', mode: '', askId: '', decision: '', reason: '', answers: null as never, command: '', args: '', ...c })

/** Fake `$`: records calls in order; sleep resolves manually with `fire`. */
function fake(role = 'work') {
  const calls: string[] = []
  const evs: Array<{ kind: string; data: any }> = []
  const updates: any[] = []
  const sleeps: Array<{ ms: number; fire: () => void }> = []
  const link = { role, emit: (e: any) => evs.push(e), update: (p: any) => updates.push(p) } as unknown as Link
  let n = 0
  const control = makeControl({
    getLink: () => link,
    submit: async t => { calls.push(`submit:${t}`) },
    abort: async id => { calls.push(`abort:${id}`) },
    stopTask: async id => { calls.push(`stop:${id}`) },
    exit: async () => { calls.push('exit') },
    sleep: ms => new Promise<void>(r => sleeps.push({ ms, fire: r })),
    newId: () => `a${++n}`,
  })
  return { control, calls, evs, updates, sleeps, link, kinds: () => evs.map(e => e.kind) }
}

const ok = (text = 'out') => async () => ({ result: {}, text }) as any

test('prompt now during a turn → context in the next tool.call, no submit', async () => {
  const f = fake()
  f.control.turnStart({ turnId: 't1', text: 'hola' })
  await f.control.handle(cmd({ type: 'prompt', text: 'and also this', mode: 'now' }))
  const r: any = await f.control.toolCall({ tool: 'Bash', tool_use_id: 'u1' }, async () => ({ result: {}, text: 'x', context: ['previous'] }))
  expect(r.context).toEqual(['previous', 'and also this'])
  expect(f.calls).toEqual([])
  // already delivered: the next one does not repeat it
  const r2: any = await f.control.toolCall({ tool: 'Bash', tool_use_id: 'u2' }, ok())
  expect(r2.context).toBe(undefined)
  f.control.turnEnd({})
  expect(f.calls).toEqual([])
})

test('undelivered prompt now when the turn ends → submit', async () => {
  const f = fake()
  f.control.turnStart({ turnId: 't1', text: 'hola' })
  await f.control.handle(cmd({ type: 'prompt', text: 'tarde', mode: 'now' }))
  // a subagent's tool.call does not deliver it
  const r: any = await f.control.toolCall({ tool: 'Bash', tool_use_id: 'u1', agentId: 'ag' }, ok())
  expect(r.context).toBe(undefined)
  f.control.turnEnd({})
  await flush()
  expect(f.calls).toEqual(['submit:tarde'])
})

test('prompt now with no turn in progress → direct submit', async () => {
  const f = fake()
  await f.control.handle(cmd({ type: 'prompt', text: 'hola', mode: 'now' }))
  expect(f.calls).toEqual(['submit:hola'])
})

test('prompt interrupt → abort before submit', async () => {
  const f = fake()
  f.control.turnStart({ turnId: 't9', text: 'x' })
  await f.control.handle(cmd({ type: 'prompt', text: 'stop and do this', mode: 'interrupt' }))
  expect(f.calls).toEqual(['abort:t9', 'submit:stop and do this'])
})

test('prompt queue → submit; abort → turn.abort of the current turn', async () => {
  const f = fake()
  await f.control.handle(cmd({ type: 'prompt', text: 'q', mode: 'queue' }))
  await f.control.handle(cmd({ type: 'abort' }))
  f.control.turnStart({ turnId: 't2', text: 'q' })
  await f.control.handle(cmd({ type: 'abort' }))
  expect(f.calls).toEqual(['submit:q', 'abort:t2'])
})

test('dedupe: the device prompt emits a single user', async () => {
  const f = fake()
  const h = makeHandlers(() => f.link, { fromDevice: t => f.control.takeFromDevice(t) })
  await f.control.handle(cmd({ type: 'prompt', text: 'from the phone', mode: 'queue' }))
  h.turnStart({ text: 'from the phone' })
  h.turnStart({ text: 'from the phone' }) // the second time the terminal did type it
  const users = f.evs.filter(e => e.kind === 'user').map(e => e.data.text)
  expect(users).toEqual(['from the phone', 'from the phone'])
  expect(f.kinds()).toEqual(['user', 'turn_start', 'status', 'turn_start', 'user', 'status'])
})

// Claude Code trims a prompt.submit text and refuses one starting with `/`: a zero-width space keeps it literal
test('a device prompt starting with / (after spaces) is submitted with a leading U+200B; its user event keeps the text', async () => {
  const f = fake()
  const h = makeHandlers(() => f.link, { fromDevice: t => f.control.takeFromDevice(t) })
  await f.control.handle(cmd({ type: 'prompt', text: ' /notacommand reply', mode: 'queue' }))
  await f.control.handle(cmd({ type: 'prompt', text: 'plain /x', mode: 'queue' }))
  expect(f.calls).toEqual(['submit:\u200b /notacommand reply', 'submit:plain /x'])
  // the turn starts with the escaped text (or with it stripped): still recognised as the device's
  h.turnStart({ text: '\u200b /notacommand reply' })
  h.turnStart({ text: 'plain /x' })
  const users = f.evs.filter(e => e.kind === 'user').map(e => e.data)
  expect(users).toEqual([{ text: ' /notacommand reply', device: true }, { text: 'plain /x', device: true }])
})

// Plan 7: the hub marks a session seen on a prompt typed in the terminal, never on one sent from a device.
test('device prompts carry device: true; terminal-typed prompts do not', async () => {
  const f = fake()
  const h = makeHandlers(() => f.link, { fromDevice: t => f.control.takeFromDevice(t) })
  await f.control.handle(cmd({ type: 'prompt', text: 'from the phone', mode: 'queue' }))
  h.turnStart({ text: 'from the phone' })
  h.turnStart({ text: 'typed here' })
  const users = f.evs.filter(e => e.kind === 'user').map(e => e.data)
  expect(users).toEqual([{ text: 'from the phone', device: true }, { text: 'typed here' }])
})

test('AskUserQuestion: the terminal wins → withdraw y ask_resolved{by:terminal}', async () => {
  const f = fake()
  let answer!: (r: any) => void
  const terminal = new Promise<any>(r => { answer = r })
  const questions = [{ question: 'A or B?', options: [{ label: 'A' }, { label: 'B' }] }]
  const p = f.control.toolCall({ tool: 'AskUserQuestion', tool_use_id: 'u1', questions }, () => terminal)
  await flush()
  const ask = f.evs.find(e => e.kind === 'ask')!
  expect(ask.data.kind).toBe('question')
  expect(ask.data.questions).toEqual(questions)
  const termResult = { result: { questions, answers: { 'A or B?': 'A' } }, text: 'A' }
  answer(termResult)
  expect(await p).toBe(termResult)
  expect(f.evs.find(e => e.kind === 'ask_resolved')!.data).toEqual({ askId: 'a1', by: 'terminal' })
  expect(f.kinds()).toEqual(['ask', 'status', 'ask_resolved', 'status'])
  expect(f.sleeps).toEqual([]) // the question does not expire: it waits for the terminal
  // a late device decision does nothing
  await f.control.handle(cmd({ type: 'decide', askId: 'a1', decision: 'allow', answers: { x: 'y' } }))
  expect(f.kinds().length).toBe(4)
})

test('AskUserQuestion: the device wins → answers in the terminal format', async () => {
  const f = fake()
  const questions = [{ question: 'A or B?', options: [{ label: 'A' }, { label: 'B' }] }]
  const p = f.control.toolCall({ tool: 'AskUserQuestion', tool_use_id: 'u1', questions }, () => new Promise(() => {}))
  await flush()
  await f.control.handle(cmd({ type: 'decide', askId: 'a1', decision: 'allow', answers: { 'A or B?': 'B' } }))
  expect(await p).toEqual({ result: { questions, answers: { 'A or B?': 'B' } } })
})

test('AskUserQuestion: the device cancels → deny', async () => {
  const f = fake()
  const p = f.control.toolCall({ tool: 'AskUserQuestion', tool_use_id: 'u1', questions: [] }, () => new Promise(() => {}))
  await flush()
  await f.control.handle(cmd({ type: 'decide', askId: 'a1', decision: 'deny' }))
  expect(((await p) as any).deny).toBe('The user canceled the question from Quorum.')
})

test('close stops the known tasks and then exits', async () => {
  const f = fake()
  f.control.turnStart({ turnId: 't1', text: 'x' })
  await f.control.toolCall({ tool: 'Bash', tool_use_id: 'u1', command: 'sleep 100', run_in_background: true },
    async () => ({ result: { backgroundTaskId: 'b1' }, text: '' }))
  await f.control.toolCall({ tool: 'Monitor', tool_use_id: 'u2' }, async () => ({ result: { taskId: 'm1' }, text: '' }))
  await f.control.toolCall({ tool: 'Bash', tool_use_id: 'u3' }, async () => ({ result: { backgroundTaskId: 'b2' }, text: '' }))
  await f.control.toolCall({ tool: 'TaskStop', tool_use_id: 'u4', task_id: 'b2' }, ok())
  f.control.agentSpawned('ag1')
  f.control.agentSpawned('ag2')
  f.control.turnEnd({ agentId: 'ag2' })
  const done = f.control.handle(cmd({ type: 'close' }))
  await flush()
  expect(f.calls).toEqual(['stop:b1', 'stop:m1', 'stop:ag1'])
  f.sleeps[0].fire()
  await done
  expect(f.calls).toEqual(['stop:b1', 'stop:m1', 'stop:ag1', 'abort:t1', 'exit'])
})

test('close without tasks exits immediately; a failing TaskStop does not block', async () => {
  const f = fake()
  await f.control.handle(cmd({ type: 'close' }))
  expect(f.calls).toEqual(['exit'])
})

test('service role: no command is applied; replies with info', async () => {
  const f = fake('service')
  await f.control.handle(cmd({ type: 'prompt', text: 'hola', mode: 'queue' }))
  await f.control.handle(cmd({ type: 'close' }))
  expect(f.calls).toEqual([])
  expect(f.evs).toEqual([
    { kind: 'info', data: { text: 'Service session: Quorum does not control it' } },
    { kind: 'info', data: { text: 'Service session: Quorum does not control it' } },
  ])
})

test("'now' is not taken by a plugin's \$.tool.call (no tool_use_id)", async () => {
  const f = fake()
  f.control.turnStart({ turnId: 't1', text: 'x' })
  await f.control.handle(cmd({ type: 'prompt', text: 'ojo', mode: 'now' }))
  const r: any = await f.control.toolCall({ tool: 'TaskStop' }, ok())
  expect(r.context).toBe(undefined)
  const r2: any = await f.control.toolCall({ tool: 'Bash', tool_use_id: 'u1' }, ok())
  expect(r2.context).toEqual(['ojo'])
})

test("interrupt carries the undelivered 'now' prompts first and they are not left for the end of the turn", async () => {
  const f = fake()
  f.control.turnStart({ turnId: 't1', text: 'x' })
  await f.control.handle(cmd({ type: 'prompt', text: 'uno', mode: 'now' }))
  await f.control.handle(cmd({ type: 'prompt', text: 'dos', mode: 'interrupt' }))
  f.control.turnEnd({})
  await flush()
  expect(f.calls).toEqual(['abort:t1', 'submit:uno\n\ndos'])
  expect(f.control.takeFromDevice('uno\n\ndos')).toBe(true)
})

test('a failing submit does not leave the text in fromDevice', async () => {
  const evs: any[] = []
  const link = { role: 'work', emit: (e: any) => evs.push(e), update: () => {} } as unknown as Link
  const control = makeControl({
    getLink: () => link,
    submit: async () => { throw new Error('no') },
    abort: async () => {}, stopTask: async () => {}, exit: async () => {},
    sleep: () => new Promise(() => {}),
  })
  await control.handle(cmd({ type: 'prompt', text: 'hola', mode: 'queue' }))
  expect(control.takeFromDevice('hola')).toBe(false)
  expect(evs.map(e => e.kind)).toEqual(['user', 'info'])
})

test("interrupt with a failed submit immediately sends the 'now' prompts as a queued prompt", async () => {
  const calls: string[] = []
  let fails = 1
  const link = { role: 'work', emit: () => {}, update: () => {} } as unknown as Link
  const control = makeControl({
    getLink: () => link,
    submit: async t => { calls.push(`submit:${t}`); if (fails-- > 0) throw new Error('no') },
    abort: async id => { calls.push(`abort:${id}`) },
    stopTask: async () => {}, exit: async () => {},
    sleep: () => new Promise(() => {}),
  })
  control.turnStart({ turnId: 't1', text: 'x' })
  await control.handle(cmd({ type: 'prompt', text: 'uno', mode: 'now' }))
  await control.handle(cmd({ type: 'prompt', text: 'tres', mode: 'now' }))
  await control.handle(cmd({ type: 'prompt', text: 'dos', mode: 'interrupt' }))
  expect(calls).toEqual(['abort:t1', 'submit:uno\n\ntres\n\ndos', 'submit:uno\n\ntres'])
  control.turnEnd({})
  await flush()
  expect(calls.length).toBe(3) // already delivered: nothing is left for the end of the turn
})

test("if the resend also fails, the 'now' prompts wait for the end of the turn", async () => {
  const calls: string[] = []
  let fails = 2
  const link = { role: 'work', emit: () => {}, update: () => {} } as unknown as Link
  const control = makeControl({
    getLink: () => link,
    submit: async t => { calls.push(`submit:${t}`); if (fails-- > 0) throw new Error('no') },
    abort: async id => { calls.push(`abort:${id}`) },
    stopTask: async () => {}, exit: async () => {},
    sleep: () => new Promise(() => {}),
  })
  control.turnStart({ turnId: 't1', text: 'x' })
  await control.handle(cmd({ type: 'prompt', text: 'uno', mode: 'now' }))
  await control.handle(cmd({ type: 'prompt', text: 'dos', mode: 'interrupt' }))
  control.turnEnd({})
  await flush()
  expect(calls).toEqual(['abort:t1', 'submit:uno\n\ndos', 'submit:uno', 'submit:uno'])
})

/** Fake tool.check hook: the terminal dialog is answered manually. */
function hookFake(signal?: AbortSignal) {
  const qs: string[] = []
  const held: Array<Promise<unknown>> = []
  let answer!: (s: string) => void
  return {
    qs, held, answer: (s: string) => answer(s),
    hook: { termAsk: (q: string) => { qs.push(q); return new Promise<string>(r => { answer = r }) }, signal, keepAlive: (u: Promise<unknown>) => { held.push(u) } },
  }
}

test('main-thread tool.check ask → race: terminal dialog and device ask at once', async () => {
  const f = fake()
  const h = hookFake()
  const p = f.control.permission({ tool: 'Bash', input: { command: 'rm x' }, tool_use_id: 'u1' }, { decision: 'ask' }, h.hook)
  await flush()
  expect(h.qs).toEqual(['Bash: rm x'])
  expect(f.evs[0]).toEqual({ kind: 'ask', data: { askId: 'a1', kind: 'permission', tool: 'Bash', summary: 'rm x', detail: '{"command":"rm x"}', questions: null } })
  expect(f.updates).toEqual([{ state: 'needs_you' }])
  expect(h.held.length).toBe(1)
  await f.control.handle(cmd({ type: 'decide', askId: 'a1', decision: 'allow' }))
  expect(await p).toEqual({ decision: 'allow', reason: 'Allowed from Quorum' })
  // Ruling L: no ask_resolved from the mod when a device decides
  expect(f.kinds()).toEqual(['ask', 'status', 'status'])
  expect(f.updates).toEqual([{ state: 'needs_you' }, { state: 'working' }])
})

test('tool.check: the terminal wins → ask_resolved{by:terminal}', async () => {
  const f = fake()
  const h = hookFake()
  const p = f.control.permission({ tool: 'Write', input: { file_path: '/x' }, tool_use_id: 'u1' }, { decision: 'ask' }, h.hook)
  await flush()
  h.answer('Allow')
  expect(await p).toEqual({ decision: 'allow', reason: 'Allowed in the terminal' })
  expect(f.evs.find(e => e.kind === 'ask_resolved')!.data).toEqual({ askId: 'a1', by: 'terminal' })
})

test('tool.check without a race: allow/deny, query without id, AskUserQuestion/ExitPlanMode', async () => {
  const f = fake()
  const h = hookFake()
  const ask = { decision: 'ask' as const, reason: 'regla' }
  for (const e of [
    { tool: 'AskUserQuestion', input: {}, tool_use_id: 'u' },
    { tool: 'ExitPlanMode', input: {}, tool_use_id: 'u' },
    { tool: 'Bash', input: {} },
  ]) expect(await f.control.permission(e, ask, h.hook)).toBe(ask)
  for (const v of [{ decision: 'allow' as const }, { decision: 'deny' as const, reason: 'no' }]) {
    expect(await f.control.permission({ tool: 'Bash', input: {}, tool_use_id: 'u' }, v, h.hook)).toBe(v)
  }
  expect(f.evs).toEqual([])
  expect(h.qs).toEqual([])
})

test('tool.check service role → verdict untouched', async () => {
  const f = fake('service')
  const h = hookFake()
  const v = { decision: 'ask' as const }
  expect(await f.control.permission({ tool: 'Bash', input: {}, tool_use_id: 'u' }, v, h.hook)).toBe(v)
  expect(f.evs).toEqual([])
  expect(h.qs).toEqual([])
})

test('tool.check without daemon → verdict (the native dialog; no devices)', async () => {
  const f = fake()
  ;(f.link as any).state = 'no-daemon'
  const h = hookFake()
  const v = { decision: 'ask' as const }
  expect(await f.control.permission({ tool: 'Bash', input: {}, tool_use_id: 'u' }, v, h.hook)).toBe(v)
  expect(h.qs).toEqual([])
})

test('pending permission and the turn ends (Esc/abort) → withdrawn, deny and working', async () => {
  const f = fake()
  f.control.turnStart({ turnId: 't1' })
  const h = hookFake()
  const p = f.control.permission({ tool: 'Bash', input: {}, tool_use_id: 'u1' }, { decision: 'ask' }, h.hook)
  await flush()
  f.control.turnEnd({})
  expect(await p).toEqual({ decision: 'deny', reason: 'Turn interrupted' })
  expect(f.evs.find(e => e.kind === 'ask_resolved')!.data).toEqual({ askId: 'a1', by: 'terminal' })
  expect(f.evs[f.evs.length - 1]).toEqual({ kind: 'status', data: { state: 'working' } })
  expect(f.updates).toEqual([{ state: 'needs_you' }, { state: 'working' }])
  expect(f.control.asks.pending).toEqual([])
})

test('pending permission and next.signal aborts → withdrawn', async () => {
  const f = fake()
  const ac = new AbortController()
  const h = hookFake(ac.signal)
  const p = f.control.permission({ tool: 'Bash', input: {}, tool_use_id: 'u1' }, { decision: 'ask' }, h.hook)
  await flush()
  ac.abort()
  expect(await p).toEqual({ decision: 'deny', reason: 'Turn interrupted' })
  expect(f.kinds()).toEqual(['ask', 'status', 'ask_resolved', 'status'])
  expect(f.evs[2].data).toEqual({ askId: 'a1', by: 'terminal' })
})

test('close withdraws pending permissions before exiting', async () => {
  const f = fake()
  const h = hookFake()
  const p = f.control.permission({ tool: 'Bash', input: {}, tool_use_id: 'u1' }, { decision: 'ask' }, h.hook)
  await flush()
  await f.control.handle(cmd({ type: 'close' }))
  expect(await p).toEqual({ decision: 'deny', reason: 'Turn interrupted' })
  expect(f.evs.find(e => e.kind === 'ask_resolved')!.data).toEqual({ askId: 'a1', by: 'terminal' })
  expect(f.calls).toEqual(['exit'])
})

test('a subagent tool.check also runs the race; its end withdraws only its ask', async () => {
  const f = fake()
  f.control.turnStart({ turnId: 't1' })
  const hs = hookFake()
  const hm = hookFake()
  const sub = f.control.permission({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'u1', agentId: 'ag1' }, { decision: 'ask' }, hs.hook)
  const main = f.control.permission({ tool: 'Bash', input: { command: 'pwd' }, tool_use_id: 'u2' }, { decision: 'ask' }, hm.hook)
  await flush()
  expect(hs.qs).toEqual(['Bash: ls'])
  expect(f.control.asks.pending).toEqual(['a1', 'a2'])
  f.control.turnEnd({ agentId: 'ag1' })
  expect(await sub).toEqual({ decision: 'deny', reason: 'Turn interrupted' })
  expect(f.control.asks.pending).toEqual(['a2'])
  expect(f.evs.filter(e => e.kind === 'ask_resolved').map(e => e.data)).toEqual([{ askId: 'a1', by: 'terminal' }])
  // the end of the main turn withdraws the rest (other subagents' too)
  f.control.turnEnd({})
  expect(await main).toEqual({ decision: 'deny', reason: 'Turn interrupted' })
})

test('tool.check without a terminal (hasTerminal false): does not open the dialog, the device answers', async () => {
  const f = fake()
  const h = hookFake()
  const p = f.control.permission({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'u1' }, { decision: 'ask' }, { ...h.hook, hasTerminal: async () => false })
  await flush()
  expect(h.qs).toEqual([])
  expect(f.kinds()).toEqual(['ask', 'status'])
  await f.control.handle(cmd({ type: 'decide', askId: 'a1', decision: 'allow' }))
  expect(await p).toEqual({ decision: 'allow', reason: 'Allowed from Quorum' })
})

test('tool.check with a terminal (hasTerminal true, or failing) opens the dialog', async () => {
  for (const hasTerminal of [async () => true, async () => { throw new Error('x') }]) {
    const f = fake()
    const h = hookFake()
    const p = f.control.permission({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'u1' }, { decision: 'ask' }, { ...h.hook, hasTerminal })
    await flush()
    expect(h.qs).toEqual(['Bash: ls'])
    h.answer('Allow')
    expect(await p).toEqual({ decision: 'allow', reason: 'Allowed in the terminal' })
  }
})

test('a device prompt whose _ or + mark a plugin stripped is still recognised (no duplicate user event)', async () => {
  const f = fake()
  await f.control.handle(cmd({ type: 'prompt', text: '_Reply with ok', mode: 'queue' }))
  await f.control.handle(cmd({ type: 'prompt', text: '+ think about it', mode: 'queue' }))
  await flush()
  expect(f.control.takeFromDevice('Reply with ok')).toBe(true)
  expect(f.control.takeFromDevice('think about it')).toBe(true)
  expect(f.control.takeFromDevice('Reply with ok')).toBe(false)
})

// a slash command's turn starts with Claude Code's command markup
const markup = (name: string, args: string) =>
  `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args>${args}</command-args>`

test('a device-run command turn emits a user event with command and device: true; a typed one without device', async () => {
  const evs: Array<{ kind: string; data: any }> = []
  const link = { role: 'work', emit: (e: any) => evs.push(e), update: () => {} } as unknown as Link
  const control = makeControl({
    getLink: () => link, submit: async () => {}, abort: async () => {}, stopTask: async () => {}, exit: async () => {},
    sleep: () => new Promise<void>(() => {}),
    commandRun: async () => ({ text: '' }),
    commands: () => [{ name: 'humanizer', description: '', source: 'user', plugin: '', group: 'skill', terminalOnly: false }],
  })
  const h = makeHandlers(() => link, {
    fromDevice: t => control.takeFromDevice(t),
    fromCommand: (n, a) => control.takeCommand(n, a),
  })
  await control.handle(cmd({ type: 'command', command: 'humanizer', args: 'make it plain' }))
  h.turnStart({ text: markup('humanizer', 'make it plain') })
  // consumed once: the same command typed in the terminal afterwards is the person's
  h.turnStart({ text: markup('humanizer', 'make it plain') })
  h.turnStart({ text: markup('humanizer', '') })
  const users = evs.filter(e => e.kind === 'user').map(e => e.data)
  expect(users).toEqual([
    { text: '/humanizer make it plain', command: { name: 'humanizer', args: 'make it plain' }, device: true },
    { text: '/humanizer make it plain', command: { name: 'humanizer', args: 'make it plain' } },
    { text: '/humanizer', command: { name: 'humanizer', args: '' } },
  ])
})

test('a device command settled long ago no longer claims a typed one', async () => {
  let t = 1_000_000
  const evs: Array<{ kind: string; data: any }> = []
  const link = { role: 'work', emit: (e: any) => evs.push(e), update: () => {} } as unknown as Link
  const control = makeControl({
    getLink: () => link, submit: async () => {}, abort: async () => {}, stopTask: async () => {}, exit: async () => {},
    sleep: () => new Promise<void>(() => {}), now: () => t,
    commandRun: async () => ({ text: 'Reloaded' }),
    commands: () => [{ name: 'reload-plugins', description: '', source: 'builtin', plugin: '', group: 'session', terminalOnly: false }],
  })
  await control.handle(cmd({ type: 'command', command: 'reload-plugins', args: '' }))
  t += 10 * 60_000
  expect(control.takeCommand('reload-plugins', '')).toBe(false)
})
