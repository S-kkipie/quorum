/*
 * Plan 10 Task 2: background item details, tool_end marks for background starts,
 * `<task-notification>` prompts as task_end cards, and live compact events.
 *
 * Notification shapes follow what Claude Code injects for a background Bash, a failed command,
 * a background subagent (with its `<result>`) and a monitor event; every field but the task id
 * may be missing.
 */
import { expect, test } from 'claude-code/testing'

import { backgroundStart, guessKind, isTaskNotification, label, LABEL_MAX, OUTPUT_TAIL_MAX, parseTaskNotifications } from '../src/background'
import { CLOSE_SETTLE_MS, makeControl, RECHECK_MS } from '../src/control'
import { makeHandlers, toolHook } from '../src/events'
import type { Link } from '../src/link'

const bashDone = [
  '<task-notification>',
  '<task-id>bq7x2k9</task-id>',
  '<tool-use-id>toolu_01AbC</tool-use-id>',
  '<output-file>/tmp/claude-1000/-home-u-app/S1/tasks/bq7x2k9.output</output-file>',
  '<status>completed</status>',
  '<summary>Background command "npm test" completed (exit code 0)</summary>',
  '</task-notification>',
  'Read the output file to retrieve the result: /tmp/claude-1000/-home-u-app/S1/tasks/bq7x2k9.output',
].join('\n')

const bashFailed = [
  '<task-notification>',
  '<task-id>bf1</task-id>',
  '<status>failed</status>',
  '<exit-code>2</exit-code>',
  '<summary>Background command "make lint" failed with exit code 2</summary>',
  '</task-notification>',
].join('\n')

const agentDone = (result: string) => [
  '<task-notification>',
  '<task-id>a5d9e1</task-id>',
  '<tool-use-id>toolu_02</tool-use-id>',
  '<output-file>/tmp/claude-1000/x/tasks/a5d9e1.output</output-file>',
  '<status>completed</status>',
  '<summary>Agent "Explore the repo" completed</summary>',
  `<result>${result}</result>`,
  '<usage><total_tokens>1200</total_tokens><tool_uses>4</tool_uses><duration_ms>5000</duration_ms></usage>',
  '</task-notification>',
].join('\n')

const monitorEvent = '<task-notification>\n<task-id>m1</task-id>\n<summary>Monitor "dev server log" event</summary>\n<event>GET /health 200</event>\n</task-notification>'

test('parse: a background Bash completion (exit code from the summary; the output file is only named)', () => {
  const [n, ...rest] = parseTaskNotifications(bashDone)
  expect(rest.length).toBe(0)
  expect(n).toEqual({
    taskId: 'bq7x2k9', toolUseId: 'toolu_01AbC', status: 'completed', ended: true,
    summary: 'Background command "npm test" completed (exit code 0)',
    outputFile: '/tmp/claude-1000/-home-u-app/S1/tasks/bq7x2k9.output', exitCode: 0,
  })
  expect(isTaskNotification(bashDone)).toBe(true)
  expect(isTaskNotification('  \n' + bashDone)).toBe(true)
  expect(isTaskNotification('please read <task-notification>')).toBe(false)
})

test('parse: failed with an <exit-code> tag; a subagent result tail capped at 2000; several blocks; missing fields', () => {
  expect(parseTaskNotifications(bashFailed)[0]).toMatchObject({ taskId: 'bf1', status: 'failed', exitCode: 2, ended: true })
  const long = 'x'.repeat(3000) + '<b>markup</b> THE END'
  const a = parseTaskNotifications(agentDone(long))[0]!
  expect(a.outputTail!.length).toBe(OUTPUT_TAIL_MAX)
  expect(a.outputTail!.endsWith('<b>markup</b> THE END')).toBe(true)
  expect(a.exitCode).toBeUndefined()
  const both = parseTaskNotifications(bashDone + '\n' + bashFailed)
  expect(both.map(n => n.taskId)).toEqual(['bq7x2k9', 'bf1'])
  expect(parseTaskNotifications('<task-notification><task-id>z</task-id></task-notification>')).toEqual([{ taskId: 'z', summary: '', ended: false }])
  expect(parseTaskNotifications('<task-notification><status>completed</status></task-notification>')).toEqual([])
  expect(parseTaskNotifications('<task-notification><task-id>q')).toEqual([])
  const m = parseTaskNotifications(monitorEvent)[0]!
  expect(m).toMatchObject({ taskId: 'm1', ended: false, event: 'GET /health 200' })
})

test('guessKind and backgroundStart', () => {
  expect(guessKind('Background command "x" completed')).toBe('command')
  expect(guessKind('Monitor "x" stopped')).toBe('monitor')
  expect(guessKind('Agent "x" completed')).toBe('subagent')
  expect(guessKind('')).toBe('task')
  expect(backgroundStart('Bash', { result: { stdout: '', backgroundTaskId: 'b1' } })).toEqual({ taskId: 'b1', kind: 'command' })
  expect(backgroundStart('Monitor', { result: { taskId: 'm1', timeoutMs: 0 } })).toEqual({ taskId: 'm1', kind: 'monitor' })
  expect(backgroundStart('Agent', { result: { status: 'async_launched', agentId: 'a1', outputFile: '/o' } })).toEqual({ taskId: 'a1', kind: 'subagent' })
  expect(backgroundStart('Agent', { result: { status: 'completed', agentId: 'a1' } })).toBeUndefined()
  expect(backgroundStart('Bash', { result: { stdout: 'ok' } })).toBeUndefined()
  expect(backgroundStart('Bash', { deny: 'no', result: { backgroundTaskId: 'b1' } })).toBeUndefined()
  expect(backgroundStart('Bash', { isError: true, result: { backgroundTaskId: 'b1' } })).toBeUndefined()
})

const s2 = <T,>(x: T) => x

function session(role = 'work', start = 1_000_000) {
  const evs: Array<{ kind: string; data: any }> = []
  const updates: any[] = []
  let now = start
  const sleeps: Array<{ ms: number; fire: () => void }> = []
  const link = { role, emit: (e: any) => evs.push(e), update: (p: any) => updates.push(p) } as unknown as Link
  const control = makeControl({
    getLink: () => link,
    submit: async () => {},
    abort: async () => {},
    stopTask: async () => {},
    exit: async () => {},
    sleep: ms => (ms === CLOSE_SETTLE_MS ? Promise.resolve() : new Promise<void>(r => sleeps.push({ ms, fire: r }))),
    now: () => now,
  })
  const h = makeHandlers(() => link, { background: () => control.background() })
  // the hook order of register.ts: tool.call = toolHook(events) around control.toolCall
  const tool = (tool: string, input: Record<string, unknown>, result: unknown, id = `u-${tool}`) =>
    toolHook(h, { tool, tool_use_id: id, ...input }, () => control.toolCall({ tool, tool_use_id: id, ...input }, async () => ({ result })))
  const bgUpdates = () => updates.filter(u => u.background && !u.state)
  const fire = async (ms: number) => {
    for (const z of sleeps.filter(z => z.ms === ms)) { sleeps.splice(sleeps.indexOf(z), 1); z.fire() }
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }
  const taskEnds = () => s2(evs.filter(e => e.kind === 'task_end').map(e => e.data))
  return { control, h, evs, updates, tool, bgUpdates, fire, taskEnds, tick: (ms: number) => { now += ms }, now: () => now }
}

test('items: one per kind with its label, start time and next wake; tasks/wakeAt kept', async () => {
  const s = session()
  s.control.turnStart({ turnId: 't' })
  await s.tool('Bash', { command: `  npm test -- ${'a'.repeat(300)}`, run_in_background: true }, { backgroundTaskId: 'b1' })
  s.tick(1000)
  await s.tool('Monitor', { description: 'dev server log', command: 'tail -f log', timeout_ms: 300000 }, { taskId: 'm1', timeoutMs: 300000 })
  s.tick(1000)
  s.control.agentSpawned('a1', { description: 'Explore the repo', prompt: 'long prompt', background: true })
  await s.tool('Agent', { description: 'Explore the repo', prompt: 'p', run_in_background: true }, { status: 'async_launched', agentId: 'a1', outputFile: '/o' })
  s.tick(1000)
  await s.tool('ScheduleWakeup', { delaySeconds: 600, prompt: '/loop check the deploy', reason: 'r' }, { scheduledFor: s.now() + 600_000 })
  s.tick(1000)
  await s.tool('CronCreate', { cron: '0 9 * * *', prompt: 'morning report', recurring: true }, { id: 'c1', nextFireAt: 9_999_999, recurring: true })
  const bg = s.control.background()
  expect(bg.tasks).toBe(3)
  expect(bg.wakeAt).toBe(1_003_000 + 600_000)
  expect(bg.items).toEqual([
    { id: 'b1', kind: 'command', label: ('npm test -- ' + 'a'.repeat(300)).slice(0, LABEL_MAX), startedAt: 1_000_000 },
    { id: 'm1', kind: 'monitor', label: 'dev server log', startedAt: 1_001_000 },
    { id: 'a1', kind: 'subagent', label: 'Explore the repo', startedAt: 1_002_000 },
    { id: 'schedule-wakeup', kind: 'loop', label: '/loop check the deploy', startedAt: 1_003_000, nextWake: 1_603_000 },
    { id: 'c1', kind: 'cron', label: 'morning report', startedAt: 1_004_000, nextWake: 9_999_999 },
  ])
  expect(bg.items![0]!.label.length).toBe(LABEL_MAX)
  // reported live, once per change (the Agent result repeated what agent.spawn reported)
  expect(s.bgUpdates().map(u => u.background.items.map((i: any) => i.id))).toEqual([
    ['b1'], ['b1', 'm1'], ['b1', 'm1', 'a1'], ['b1', 'm1', 'a1', 'schedule-wakeup'], ['b1', 'm1', 'a1', 'schedule-wakeup', 'c1'],
  ])
  // a plain tool call changes nothing: no new update
  await s.tool('Read', { file_path: '/x' }, { content: '' })
  expect(s.bgUpdates().length).toBe(5)
})

test('classic Stop: tasks the mod never saw start get their kind and label from the report; crons their prompt', () => {
  const s = session()
  s.control.stopHook({
    background_tasks: [
      { id: 'b9', type: 'shell', description: 'Run the tests', command: 'npm test' },
      { id: 'm9', type: 'monitor', description: 'watch CI' },
      { id: 'a9', type: 'subagent', description: 'Review the diff' },
    ],
    session_crons: [{ id: 'c9', schedule: '*/5 * * * *', recurring: true, prompt: 'poll the queue' }],
  })
  const items = s.control.background().items!
  expect(items.map(i => [i.id, i.kind, i.label])).toEqual([
    ['b9', 'command', 'npm test'], ['m9', 'monitor', 'watch CI'], ['a9', 'subagent', 'Review the diff'], ['c9', 'cron', 'poll the queue'],
  ])
  expect(typeof items[3]!.nextWake).toBe('number')
})

test('tool_end of a background start carries background.taskId; a foreground call does not', async () => {
  const s = session()
  s.control.turnStart({ turnId: 't' })
  await s.tool('Bash', { command: 'npm test', run_in_background: true }, { stdout: '', backgroundTaskId: 'b1' }, 'u1')
  await s.tool('Monitor', { description: 'log' }, { taskId: 'm1', timeoutMs: 0 }, 'u2')
  await s.tool('Agent', { description: 'd', prompt: 'p' }, { status: 'async_launched', agentId: 'a1' }, 'u3')
  await s.tool('Bash', { command: 'ls' }, { stdout: 'x' }, 'u4')
  await s.tool('Agent', { description: 'd', prompt: 'p' }, { status: 'completed', agentId: 'a2', content: [] }, 'u5')
  const ends = s.evs.filter(e => e.kind === 'tool_end')
  expect(ends.map(e => [e.data.id, e.data.background?.taskId])).toEqual([
    ['u1', 'b1'], ['u2', 'm1'], ['u3', 'a1'], ['u4', undefined], ['u5', undefined],
  ])
  expect(ends.every(e => e.data.ok)).toBe(true)
})

test('a notification emits task_end with the tracked kind, drops the task and shows no user bubble', async () => {
  const s = session()
  s.control.turnStart({ turnId: 't' })
  s.h.turnStart({ text: 'go' })
  await s.tool('Bash', { command: 'npm test', run_in_background: true }, { backgroundTaskId: 'bq7x2k9' })
  s.control.turnEnd({})
  s.control.taskNotification(bashDone)
  const ends = s.evs.filter(e => e.kind === 'task_end')
  expect(ends.map(e => e.data)).toEqual([{
    taskId: 'bq7x2k9', kind: 'command', summary: 'Background command "npm test" completed (exit code 0)', status: 'completed', exitCode: 0,
  }])
  expect(s.control.background()).toEqual({ tasks: 0, wakeAt: 0, items: [] })
  expect(s.updates[s.updates.length - 1]).toEqual({ background: { tasks: 0, wakeAt: 0, items: [] } })
  // the follow-up turn the notification starts: turn_start and working, never a user event
  const users = () => s.evs.filter(e => e.kind === 'user').length
  const before = users()
  s.control.turnStart({ turnId: 't2', text: bashDone })
  s.h.turnStart({ text: bashDone })
  expect(users()).toBe(before)
  expect(s.evs[s.evs.length - 1]).toEqual({ kind: 'status', data: { state: 'working' } })
  expect(s.evs.filter(e => e.kind === 'turn_start').length).toBe(2)
  // handled once: the turn start does not emit a second task_end
  expect(s.evs.filter(e => e.kind === 'task_end').length).toBe(1)
})

test('a subagent notification after its turn.complete keeps the subagent kind and its result tail', () => {
  const s = session()
  s.control.agentSpawned('a5d9e1', { description: 'Explore the repo' })
  s.control.turnEnd({ agentId: 'a5d9e1' })
  s.control.taskNotification(agentDone('Found 3 entry points.'))
  const end = s.evs.find(e => e.kind === 'task_end')!
  expect(end.data).toEqual({ taskId: 'a5d9e1', kind: 'subagent', summary: 'Agent "Explore the repo" completed', status: 'completed', outputTail: 'Found 3 entry points.' })
})

test('an unknown task guesses its kind; a failed one reports its exit code; a monitor event is an info line, no task_end', () => {
  const s = session()
  s.control.taskNotification(bashFailed)
  s.control.taskNotification(monitorEvent)
  expect(s.evs.filter(e => e.kind === 'task_end').map(e => e.data)).toEqual([
    { taskId: 'bf1', kind: 'command', summary: 'Background command "make lint" failed with exit code 2', status: 'failed', exitCode: 2 },
  ])
  expect(s.evs.filter(e => e.kind === 'info').map(e => e.data.text)).toEqual(['Background event: GET /health 200'])
})

test('a notification turn that prompt.submit missed is handled at turn start (once)', async () => {
  const s = session()
  await s.tool('Monitor', { description: 'log' }, { taskId: 'm1' })
  const stop = '<task-notification><task-id>m1</task-id><status>killed</status><summary>Monitor "log" stopped</summary></task-notification>'
  s.control.turnStart({ turnId: 't2', text: stop })
  s.control.turnStart({ turnId: 't3', text: 'typed by the owner' })
  expect(s.evs.filter(e => e.kind === 'task_end').map(e => [e.data.taskId, e.data.kind, e.data.status])).toEqual([['m1', 'monitor', 'killed']])
  expect(s.control.background().tasks).toBe(0)
})

test('a service session emits no task_end (tracking still drops the task)', async () => {
  const s = session('service')
  await s.tool('Bash', { command: 'x', run_in_background: true }, { backgroundTaskId: 'bq7x2k9' })
  s.control.taskNotification(bashDone)
  expect(s.evs.some(e => e.kind === 'task_end')).toBe(false)
  expect(s.control.background().tasks).toBe(0)
})

test('compact: manual and auto that stand emit compact; precompute, skip and a subagent emit none', () => {
  const s = session()
  const msgs = { messages: [{ role: 'user', text: 's' }] }
  s.h.compact({ trigger: 'manual' }, { ...msgs, tokensBefore: 152_340 }, 1_700_000_000_000)
  s.h.compact({ trigger: 'auto' }, msgs, 1_700_000_100_000)
  s.h.compact({ trigger: 'plugin' }, { ...msgs, tokensBefore: 0 }, 1_700_000_200_000)
  s.h.compact({ trigger: 'precompute' }, msgs, 1)
  s.h.compact({ trigger: 'auto' }, { skip: 'blocked by a PreCompact hook' }, 2)
  s.h.compact({ trigger: 'auto', agentId: 'a1' }, msgs, 3)
  s.h.compact({ trigger: 'auto' }, undefined, 4)
  expect(s.evs.filter(e => e.kind === 'compact').map(e => e.data)).toEqual([
    { at: 1_700_000_000_000, trigger: 'manual', preTokens: 152_340 },
    { at: 1_700_000_100_000, trigger: 'auto' },
    { at: 1_700_000_200_000, trigger: 'auto' },
  ])
  const svc = session('service')
  svc.h.compact({ trigger: 'manual' }, msgs, 5)
  expect(svc.evs.length).toBe(0)
})

// fix round 1

test('a foreground subagent mid-turn is no item and re-sends nothing; still running at the main turn end it is one', () => {
  const s = session()
  s.control.turnStart({ turnId: 't' })
  s.control.agentSpawned('f1', { description: 'Quick search', background: false })
  expect(s.control.background().tasks).toBe(1)
  expect(s.control.background().items).toEqual([])
  expect(s.bgUpdates().length).toBe(0)
  // the main turn ends with it still running: it runs on in the background
  expect(s.control.background(true).items!.map(i => [i.id, i.kind])).toEqual([['f1', 'subagent']])
  s.control.turnEnd({})
  expect(s.control.background().items!.map(i => i.id)).toEqual(['f1'])
})

test('task_end is emitted once per task id (the same notification twice)', () => {
  const s = session()
  s.control.taskNotification(bashDone)
  s.control.taskNotification(bashDone)
  s.control.turnStart({ turnId: 't2', text: bashDone })
  expect(s.taskEnds().length).toBe(1)
})

test('a prompt that only looks like a notification, stamped as the owner\'s, starts an ordinary turn', () => {
  const s = session()
  s.control.ownerPrompt(bashDone)
  s.control.turnStart({ turnId: 't', text: bashDone })
  expect(s.control.isNotificationTurn()).toBe(false)
  expect(s.taskEnds().length).toBe(0)
  s.control.turnStart({ turnId: 't2', text: bashDone })
  expect(s.control.isNotificationTurn()).toBe(true)
})

test('TaskStop: a synthetic stopped task_end after the wait, unless the task\'s own notification comes first', async () => {
  const s = session()
  await s.tool('Bash', { command: 'npm run dev', run_in_background: true }, { backgroundTaskId: 'b1' })
  await s.tool('Bash', { command: 'npm run watch', run_in_background: true }, { backgroundTaskId: 'b2' })
  await s.tool('TaskStop', { task_id: 'b1' }, { message: 'stopped' })
  await s.tool('TaskStop', { task_id: 'b2' }, { message: 'stopped' })
  s.control.taskNotification('<task-notification><task-id>b2</task-id><status>killed</status><summary>Background command "npm run watch" was stopped</summary></task-notification>')
  await s.fire(RECHECK_MS)
  expect(s.taskEnds()).toEqual([
    { taskId: 'b2', kind: 'command', summary: 'Background command "npm run watch" was stopped', status: 'killed' },
    { taskId: 'b1', kind: 'command', summary: 'npm run dev', status: 'stopped', synthetic: true },
  ])
})

test('the Stop report dropping a background task: synthetic stopped task_end after the wait; foreground subagents get none', async () => {
  const s = session()
  s.control.turnStart({ turnId: 't' })
  await s.tool('Monitor', { description: 'ci log' }, { taskId: 'm1' })
  s.control.agentSpawned('f1', { description: 'fg' })
  s.control.turnEnd({ agentId: 'f1' })
  s.control.stopHook({ background_tasks: [], session_crons: [] })
  expect(s.taskEnds()).toEqual([])
  await s.fire(RECHECK_MS)
  expect(s.taskEnds()).toEqual([{ taskId: 'm1', kind: 'monitor', summary: 'ci log', status: 'stopped', synthetic: true }])
})

test('close: every live background task gets a stopped task_end at once', async () => {
  const s = session()
  await s.tool('Bash', { command: 'sleep 100', run_in_background: true }, { backgroundTaskId: 'b1' })
  await s.control.handle({ type: 'close', text: '', mode: '', askId: '', decision: '', reason: '', answers: null as never, command: '', args: '' })
  expect(s.taskEnds()).toEqual([{ taskId: 'b1', kind: 'command', summary: 'sleep 100', status: 'stopped', synthetic: true }])
})

test('a real end after a synthetic one is still emitted (it replaces it); a second real one is not', async () => {
  const s = session()
  await s.tool('Bash', { command: 'npm run dev', run_in_background: true }, { backgroundTaskId: 'b1' })
  await s.tool('TaskStop', { task_id: 'b1' }, { message: 'stopped' })
  await s.fire(RECHECK_MS)
  const real = '<task-notification><task-id>b1</task-id><status>killed</status><summary>Background command "npm run dev" was stopped</summary></task-notification>'
  s.control.taskNotification(real)
  s.control.taskNotification(real)
  expect(s.taskEnds()).toEqual([
    { taskId: 'b1', kind: 'command', summary: 'npm run dev', status: 'stopped', synthetic: true },
    { taskId: 'b1', kind: 'command', summary: 'Background command "npm run dev" was stopped', status: 'killed' },
  ])
})

test('label collapses whitespace to one line', () => {
  expect(label('  npm test \\\n  --watch\t\tnow  ')).toBe('npm test \\ --watch now')
  expect(label('a\n\nb')).toBe('a b')
  expect(label(42)).toBe('')
})

test('parse stays fast and bounded on adversarial 1 MB input; a huge result keeps its real tail', () => {
  const MB = 1024 * 1024
  const inputs = [
    '<task-notification>'.repeat(MB / 19),
    '<task-notification><task-id>x</task-id>' + '<summary>'.repeat(MB / 9) + '</task-notification>',
    '<task-notification><task-id>x</task-id><status>completed</status>' + ' '.repeat(MB) + '<summary>s</summary></task-notification>',
    '<task-notification>' + '<task-id>'.repeat(MB / 9),
  ]
  for (const text of inputs) {
    const t0 = Date.now()
    parseTaskNotifications(text)
    expect(Date.now() - t0).toBeLessThan(250)
  }
  const big = '<task-notification><task-id>a1</task-id><status>completed</status><summary>Agent "x" completed</summary><result>'
    + 'y'.repeat(MB) + 'THE REAL END</result></task-notification>'
  const t0 = Date.now()
  const [n] = parseTaskNotifications(big)
  expect(Date.now() - t0).toBeLessThan(250)
  expect(n).toMatchObject({ taskId: 'a1', status: 'completed', ended: true, summary: 'Agent "x" completed' })
  expect(n!.outputTail!.endsWith('THE REAL END')).toBe(true)
  expect(n!.outputTail!.length).toBe(OUTPUT_TAIL_MAX)
  // header tags inside a result are not read as the header
  const quoted = '<task-notification><task-id>a2</task-id><status>completed</status><result><task-id>evil</task-id><status>failed</status></result></task-notification>'
  expect(parseTaskNotifications(quoted)[0]).toMatchObject({ taskId: 'a2', status: 'completed' })
})
