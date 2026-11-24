/*
 * Background state: how background work and scheduled wake-ups show up to a mod
 * (from mod/.claude-plugin/types: claude-code and claude-code-tools index.d.ts).
 *
 * Start of background work (tool.call results, already tracked in control.ts):
 *   - Bash with run_in_background (or moved to the background): `result.backgroundTaskId`.
 *   - Monitor: `result.taskId`.
 *   - Background subagent: `agent.spawn` answers `{ agentId }` (AgentSpawnInput.background true);
 *     its loop's `turn.complete` carries `agentId`.
 *
 * End of background work: there is no dedicated mod event. Claude Code queues a
 * `<task-notification>` prompt (`<task-id>`, `<status>completed|failed|killed`) and raises
 * `prompt.submit` with `e.origin.kind === 'task-notification'` ("dequeued when the session
 * went idle or delivered into a running turn"). Dequeued while idle it starts the follow-up
 * turn itself, so the session goes straight back to working. A subagent's end is also its
 * `turn.complete` with `agentId`; TaskStop removes a task explicitly.
 *
 * Scheduled wake-ups:
 *   - `ScheduleWakeup { delaySeconds (clamped to [60, 3600]), prompt, stop? }` answers
 *     `{ scheduledFor (epoch ms), clampedDelaySeconds, stopped? }`. One-shot; `stop: true`
 *     cancels the dynamic loop.
 *   - `CronCreate { cron (5-field, local time), prompt, recurring? = true }` answers
 *     `{ id, nextFireAt?, recurring }`; `CronDelete { id }` answers `{ id, endedLoopWakeup? }`.
 *   - The follow-up turn comes from a `prompt.submit` with origin `scheduled-trigger`
 *     (UserPromptSubmit source `loop_wakeup` / `schedule_wakeup`).
 *
 * Authority at turn end: the classic `Stop` hook (`classic.Stop`, raised whether or not a
 * settings hook is configured) carries `background_tasks: BackgroundTaskSummary[]` (in-flight
 * work: "session is done" vs "paused waiting for background work to wake it") and
 * `session_crons: SessionCronSummary[]` ({ id, schedule, recurring, prompt }). The mod
 * reconciles its own tracking with it when present (older builds omit both fields).
 */
import { expect, test } from 'claude-code/testing'

import { nextCron, stateOf, taskEnds } from '../src/background'
import { CLOSE_SETTLE_MS, makeControl, RECHECK_MS, WAKE_GRACE_MS } from '../src/control'
import { makeHandlers } from '../src/events'
import type { Link } from '../src/link'
import type { Command } from '../src/proto.gen'

/** The counts of a BackgroundInfo (its items are checked by the Plan 10 tests). */
const counts = (bg: any) => (bg ? { tasks: bg.tasks, wakeAt: bg.wakeAt } : bg)
/** An update with its background reduced to the counts. */
const plainUpdate = (u: any) => (u && u.background ? { ...u, background: counts(u.background) } : u)

const cmd = (c: Partial<Command>): Command =>
  ({ type: '', text: '', mode: '', askId: '', decision: '', reason: '', answers: null as never, command: '', args: '', ...c })

/** Control + event handlers over one fake link and a settable clock. */
function session(start = 1_000_000) {
  const evs: Array<{ kind: string; data: any }> = []
  const updates: any[] = []
  const calls: string[] = []
  // re-checks wait for `fire()`; the close settle passes at once
  const sleeps: Array<{ ms: number; fire: () => void }> = []
  let now = start
  const link = { role: 'work', emit: (e: any) => evs.push(e), update: (p: any) => updates.push(p) } as unknown as Link
  const control = makeControl({
    getLink: () => link,
    submit: async () => {},
    abort: async () => {},
    stopTask: async id => { calls.push(`stop:${id}`) },
    exit: async () => { calls.push('exit') },
    sleep: ms => (ms === CLOSE_SETTLE_MS ? Promise.resolve() : new Promise<void>(r => sleeps.push({ ms, fire: r }))),
    now: () => now,
  })
  const h = makeHandlers(() => link, { background: () => control.background() })
  const turnStart = (turnId = 't') => { control.turnStart({ turnId }); h.turnStart({ text: 'go' }) }
  const turnEnd = () => { h.turnComplete({ answer: 'ok', reason: 'answer' }); control.turnEnd({}) }
  const states = () => evs.filter(e => e.kind === 'status').map(e => e.data.state)
  const last = () => plainUpdate(updates[updates.length - 1])
  const tool = (tool: string, input: Record<string, unknown>, result: unknown, agentId?: string) =>
    control.toolCall({ tool, tool_use_id: `u-${tool}`, agentId, ...input }, async () => ({ result, text: '' }))
  const fire = async () => { for (const z of sleeps.splice(0)) z.fire(); for (let i = 0; i < 10; i++) await Promise.resolve() }
  return { control, h, evs, updates, calls, sleeps, fire, states, last, turnStart, turnEnd, tool, tick: (ms: number) => { now += ms }, now: () => now }
}

const notification = (id: string, status: string) =>
  `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n<summary>done</summary>\n</task-notification>`

test('(a) a turn ending with a background Bash → background with tasks=1; completion → 0; next turn working; nothing → idle', async () => {
  const s = session()
  s.turnStart()
  await s.tool('Bash', { command: 'sleep 100', run_in_background: true }, { backgroundTaskId: 'b1' })
  s.turnEnd()
  expect(s.states()).toEqual(['working', 'background'])
  expect(s.last()).toEqual({ state: 'background', background: { tasks: 1, wakeAt: 0 } })
  const end = s.evs.find(e => e.kind === 'turn_end')!
  expect(counts(end.data.background)).toEqual({ tasks: 1, wakeAt: 0 })
  // the completion arrives as a task-notification prompt, which starts the follow-up turn
  s.control.taskNotification(notification('b1', 'completed'))
  expect(counts(s.control.background())).toEqual({ tasks: 0, wakeAt: 0 })
  s.turnStart('t2')
  expect(s.states()[s.states().length - 1]).toBe('working')
  s.turnEnd()
  expect(s.states()[s.states().length - 1]).toBe('idle')
  expect(s.last()).toEqual({ state: 'idle', background: { tasks: 0, wakeAt: 0 } })
})

test('(a) Monitor and a background subagent count; the subagent ending removes it', async () => {
  const s = session()
  s.turnStart()
  await s.tool('Monitor', { command: 'tail -f x' }, { taskId: 'm1' })
  s.control.agentSpawned('ag1')
  s.turnEnd()
  expect(s.control.background().tasks).toBe(2)
  s.control.turnEnd({ agentId: 'ag1' })
  expect(s.control.background().tasks).toBe(1)
})

test('(a) a monitor event without a terminal status keeps the task', () => {
  expect(taskEnds('<task-notification><task-id>m1</task-id><event>line</event></task-notification>')).toEqual([])
  expect(taskEnds(notification('m1', 'running'))).toEqual([])
  expect(taskEnds(notification('a', 'failed') + notification('b', 'killed'))).toEqual(['a', 'b'])
  expect(taskEnds('plain prompt')).toEqual([])
})

test('(b) ScheduleWakeup delaySeconds 1800 → wakeAt ≈ now+1 800 000; the wake-up turn clears it', async () => {
  const s = session()
  s.turnStart()
  await s.tool('ScheduleWakeup', { delaySeconds: 1800, prompt: '/loop check', reason: 'r' }, {})
  s.turnEnd()
  expect(s.states()).toEqual(['working', 'background'])
  expect(s.last().background).toEqual({ tasks: 0, wakeAt: s.now() + 1_800_000 })
  // the wake-up fires: its turn runs and ends without scheduling another one
  s.tick(1_800_000)
  s.turnStart('t2')
  s.turnEnd()
  expect(s.states()).toEqual(['working', 'background', 'working', 'idle'])
  expect(s.last().background).toEqual({ tasks: 0, wakeAt: 0 })
})

test('(b) ScheduleWakeup uses scheduledFor when present; stop:true cancels it', async () => {
  const s = session()
  s.turnStart()
  await s.tool('ScheduleWakeup', { delaySeconds: 99999 }, { scheduledFor: 5_000_000, clampedDelaySeconds: 3600 })
  expect(s.control.background().wakeAt).toBe(5_000_000)
  await s.tool('ScheduleWakeup', { stop: true }, { stopped: true, cancelledWakeups: 1 })
  expect(s.control.background().wakeAt).toBe(0)
})

test('(b) a typed prompt before the wake-up keeps it pending', async () => {
  const s = session()
  s.turnStart()
  await s.tool('ScheduleWakeup', { delaySeconds: 600 }, {})
  s.turnEnd()
  s.tick(60_000)
  s.turnStart('t2')
  s.turnEnd()
  expect(s.states()[s.states().length - 1]).toBe('background')
  expect(s.last().background.wakeAt).toBe(1_000_000 + 600_000)
})

test('(b) a recurring CronCreate stays scheduled, moving to its next fire; CronDelete clears it', async () => {
  const at = new Date(2026, 10, 24, 14, 2, 0, 0).getTime()
  const s = session(at)
  s.turnStart()
  await s.tool('CronCreate', { cron: '*/5 * * * *', prompt: 'p' }, { id: 'c1', recurring: true, nextFireAt: new Date(2026, 10, 24, 14, 5).getTime() })
  s.turnEnd()
  expect(s.last().background.wakeAt).toBe(new Date(2026, 10, 24, 14, 5).getTime())
  s.tick(4 * 60_000) // 14:06: it fired
  s.turnStart('t2')
  s.turnEnd()
  expect(s.states()[s.states().length - 1]).toBe('background')
  expect(s.last().background.wakeAt).toBe(new Date(2026, 10, 24, 14, 10).getTime())
  s.turnStart('t3')
  await s.tool('CronDelete', { id: 'c1' }, { id: 'c1' })
  s.turnEnd()
  expect(s.states()[s.states().length - 1]).toBe('idle')
})

test('(b) a one-shot CronCreate is dropped after it fires', async () => {
  const s = session()
  s.turnStart()
  await s.tool('CronCreate', { cron: '30 14 28 2 *', prompt: 'p', recurring: false }, { id: 'c2', recurring: false, nextFireAt: 2_000_000 })
  s.turnEnd()
  expect(s.last().background.wakeAt).toBe(2_000_000)
  s.tick(1_000_001) // due: its turn is about to start, still background
  expect(s.control.background().wakeAt).toBe(2_000_000)
  s.tick(60_000) // over a minute late and no turn: it never fired
  expect(s.control.background().wakeAt).toBe(0)
})

test('(b) a passed wake-up that never fired is dropped when re-published', async () => {
  const s = session()
  s.turnStart()
  await s.tool('ScheduleWakeup', { delaySeconds: 600 }, {})
  await s.tool('Bash', { command: 'x', run_in_background: true }, { backgroundTaskId: 'b1' })
  s.turnEnd()
  expect(s.last().background).toEqual({ tasks: 1, wakeAt: 1_000_000 + 600_000 })
  s.tick(600_000 + 61_000)
  s.control.taskNotification(notification('b1', 'completed'))
  await s.fire()
  expect(s.states()[s.states().length - 1]).toBe('idle')
  expect(s.last().background).toEqual({ tasks: 0, wakeAt: 0 })
})

test('(b) a wake-up that never fires does not leave the session "waking up": one re-check after its grace', async () => {
  const s = session()
  s.turnStart()
  await s.tool('ScheduleWakeup', { delaySeconds: 600 }, {})
  s.turnEnd()
  expect(s.last().background).toEqual({ tasks: 0, wakeAt: 1_000_000 + 600_000 })
  expect(s.sleeps.map(z => z.ms)).toEqual([600_000 + WAKE_GRACE_MS + 1])
  s.tick(600_000 + WAKE_GRACE_MS + 1)
  await s.fire()
  expect(s.states()[s.states().length - 1]).toBe('idle')
  expect(s.last().background).toEqual({ tasks: 0, wakeAt: 0 })
  expect(s.sleeps).toEqual([]) // nothing left to watch
})

test('(b) a wake-up that fires cancels its re-check; a recurring cron is watched again at its next time', async () => {
  const s = session(new Date(2026, 10, 24, 14, 2).getTime())
  s.turnStart()
  await s.tool('ScheduleWakeup', { delaySeconds: 600 }, {})
  s.turnEnd()
  const n = s.states().length
  s.tick(600_000)
  s.turnStart('t2') // it fired
  await s.fire() // the stale re-check finds a turn running: nothing
  expect(s.states().length).toBe(n + 1)
  s.turnStart('t3')
  await s.tool('CronCreate', { cron: '*/5 * * * *', prompt: 'p' }, { id: 'c1', recurring: true })
  s.turnEnd()
  const at = s.last().background.wakeAt
  expect(s.sleeps.length).toBe(1)
  s.tick(at - s.now() + WAKE_GRACE_MS + 1) // missed: the cron moves on
  await s.fire()
  expect(s.last().background.wakeAt).toBeGreaterThan(s.now())
  expect(s.sleeps.length).toBe(1) // the next time is watched
})

test('(c) a foreground subagent keeps the session working', async () => {
  const s = session()
  s.turnStart()
  s.control.agentSpawned('fg1')
  s.control.turnStart({ turnId: 'sub', agentId: 'fg1' })
  s.h.turnStart({ text: 'sub', agentId: 'fg1' })
  s.h.turnComplete({ answer: 'r', reason: 'answer', agentId: 'fg1' })
  s.control.turnEnd({ agentId: 'fg1' })
  expect(s.states()).toEqual(['working'])
  s.turnEnd()
  expect(s.states()).toEqual(['working', 'idle'])
})

test('(d) TaskStop of a task removes it', async () => {
  const s = session()
  s.turnStart()
  await s.tool('Bash', { command: 'x', run_in_background: true }, { backgroundTaskId: 'b1' })
  await s.tool('Bash', { command: 'y', run_in_background: true }, { backgroundTaskId: 'b2' })
  await s.tool('TaskStop', { task_id: 'b1' }, {})
  s.turnEnd()
  expect(s.last().background).toEqual({ tasks: 1, wakeAt: 0 })
})

test('(e) closing the session clears the background', async () => {
  const s = session()
  s.turnStart()
  await s.tool('Bash', { command: 'x', run_in_background: true }, { backgroundTaskId: 'b1' })
  await s.tool('ScheduleWakeup', { delaySeconds: 600 }, {})
  s.turnEnd()
  await s.control.handle(cmd({ type: 'close' }))
  expect(s.calls).toEqual(['stop:b1', 'exit'])
  expect(counts(s.control.background())).toEqual({ tasks: 0, wakeAt: 0 })
})

test('classic Stop reconciles: unknown tasks added, missing ones dropped, crons without a known time scheduled', async () => {
  const s = session(new Date(2026, 10, 24, 14, 2).getTime())
  s.turnStart()
  await s.tool('Bash', { command: 'x', run_in_background: true }, { backgroundTaskId: 'gone' })
  s.turnEnd()
  expect(s.states()).toEqual(['working', 'background'])
  // after turn.complete: it differs from what was published, so the session state is re-sent
  s.control.stopHook({ background_tasks: [{ id: 'x1' }, { id: 'x2' }], session_crons: [{ id: 'k', schedule: '0 15 * * *', recurring: true }] })
  expect(s.states()).toEqual(['working', 'background', 'background'])
  expect(s.last().background).toEqual({ tasks: 2, wakeAt: new Date(2026, 10, 24, 15, 0).getTime() })
  // nothing in flight and no crons: idle
  s.control.stopHook({ background_tasks: [], session_crons: [] })
  expect(s.states()[s.states().length - 1]).toBe('idle')
  expect(counts(s.control.background())).toEqual({ tasks: 0, wakeAt: 0 })
  // same result again: nothing re-sent
  const n = s.states().length
  s.control.stopHook({ background_tasks: [], session_crons: [] })
  expect(s.states().length).toBe(n)
})

test('classic Stop during the turn does not publish; old builds without the fields change nothing', async () => {
  const s = session()
  s.turnStart()
  await s.tool('Bash', { command: 'x', run_in_background: true }, { backgroundTaskId: 'b1' })
  s.control.stopHook({})
  s.control.stopHook({ background_tasks: [{ id: 'b1' }] })
  expect(s.states()).toEqual(['working'])
  s.turnEnd()
  expect(s.last().background).toEqual({ tasks: 1, wakeAt: 0 })
})

test('a pending question is not overridden by a background re-publish', async () => {
  const s = session()
  s.turnStart()
  await s.tool('Bash', { command: 'x', run_in_background: true }, { backgroundTaskId: 'b1' })
  s.turnEnd()
  void s.control.asks.ask({ kind: 'permission', tool: 'Bash', summary: '', detail: '', questions: null as never }, Infinity)
  s.control.stopHook({ background_tasks: [] })
  expect(s.states()[s.states().length - 1]).toBe('needs_you')
})

test('nextCron: steps, lists, ranges, day of week; undefined when invalid', () => {
  const from = new Date(2026, 10, 24, 14, 2, 30).getTime() // Tuesday
  expect(nextCron('*/5 * * * *', from)).toBe(new Date(2026, 10, 24, 14, 5).getTime())
  expect(nextCron('0 9,17 * * *', from)).toBe(new Date(2026, 10, 24, 17, 0).getTime())
  expect(nextCron('0 9 * * 1-5', new Date(2026, 10, 27, 18, 0).getTime())).toBe(new Date(2026, 10, 30, 9, 0).getTime())
  expect(nextCron('30 14 28 2 *', from)).toBe(new Date(2027, 1, 28, 14, 30).getTime())
  expect(nextCron('2 14 * * *', from)).toBe(new Date(2026, 10, 25, 14, 2).getTime())
  expect(nextCron('bad', from)).toBe(undefined)
  expect(nextCron('61 * * * *', from)).toBe(undefined)
})

test('a task ending between turns with no follow-up turn → idle after the re-check', async () => {
  const s = session()
  s.turnStart()
  await s.tool('Bash', { command: 'x', run_in_background: true }, { backgroundTaskId: 'b1' })
  s.turnEnd()
  s.control.taskNotification(notification('b1', 'completed'))
  expect(s.sleeps.map(z => z.ms)).toEqual([RECHECK_MS])
  expect(s.states()).toEqual(['working', 'background'])
  await s.fire()
  expect(s.states()).toEqual(['working', 'background', 'idle'])
  expect(s.last()).toEqual({ state: 'idle', background: { tasks: 0, wakeAt: 0 } })
})

test('a task ending between turns with a follow-up turn → no transient idle', async () => {
  const s = session()
  s.turnStart()
  await s.tool('Bash', { command: 'x', run_in_background: true }, { backgroundTaskId: 'b1' })
  s.turnEnd()
  s.control.taskNotification(notification('b1', 'completed'))
  s.turnStart('t2')
  await s.fire() // the re-check lands mid-turn: nothing
  expect(s.states()).toEqual(['working', 'background', 'working'])
  s.turnEnd()
  await s.fire()
  expect(s.states()).toEqual(['working', 'background', 'working', 'idle'])
})

test('a re-check after the follow-up turn already ended re-sends nothing', async () => {
  const s = session()
  s.turnStart()
  await s.tool('Bash', { command: 'x', run_in_background: true }, { backgroundTaskId: 'b1' })
  s.turnEnd()
  s.control.taskNotification(notification('b1', 'completed'))
  s.turnStart('t2')
  s.turnEnd()
  await s.fire()
  expect(s.states()).toEqual(['working', 'background', 'working', 'idle'])
})

test('a background subagent ending between turns → re-check → idle; an unknown or mid-turn end schedules none', async () => {
  const s = session()
  s.turnStart()
  s.control.agentSpawned('bg1')
  s.control.turnEnd({ agentId: 'other' }) // unknown: nothing removed
  s.turnEnd()
  expect(s.states()).toEqual(['working', 'background'])
  expect(s.sleeps).toHaveLength(0)
  s.control.turnEnd({ agentId: 'bg1' })
  await s.fire()
  expect(s.states()).toEqual(['working', 'background', 'idle'])
})

test('stateOf: background with tasks or a wake-up, else idle', () => {
  expect(stateOf({ tasks: 0, wakeAt: 0 })).toBe('idle')
  expect(stateOf({ tasks: 2, wakeAt: 0 })).toBe('background')
  expect(stateOf({ tasks: 0, wakeAt: 5 })).toBe('background')
})

test('nextCron: day-of-month OR day-of-week when both are restricted; `*/n` days do not restrict; 7 is Sunday; leap day', () => {
  const from = new Date(2026, 10, 24, 14, 2).getTime() // Tuesday 24 Nov 2026
  // the 1st of the month OR a Friday: Friday 27 Nov comes first
  expect(nextCron('0 9 1 * 5', from)).toBe(new Date(2026, 10, 27, 9, 0).getTime())
  // the 25th OR a Friday: the 25th comes first
  expect(nextCron('0 9 25 * 5', from)).toBe(new Date(2026, 10, 25, 9, 0).getTime())
  // `*/2` in day-of-week does not restrict: only day-of-month (the 1st) decides
  expect(nextCron('0 9 1 * */2', from)).toBe(new Date(2026, 11, 1, 9, 0).getTime())
  // 7 and 0 are both Sunday
  expect(nextCron('0 9 * * 7', from)).toBe(new Date(2026, 10, 29, 9, 0).getTime())
  expect(nextCron('0 9 * * 0', from)).toBe(new Date(2026, 10, 29, 9, 0).getTime())
  // Feb 29 is over a year away
  expect(nextCron('0 0 29 2 *', from)).toBe(new Date(2028, 1, 29, 0, 0).getTime())
})
