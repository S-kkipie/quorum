import { expect, mock, test } from 'claude-code/testing'

import { disabled, quorum } from '../hooks/register'

// The kit has no processes or network: quorumd does not exist here, so the session ends up
// "no daemon", but the role is decided earlier and /quorum reports it.
test('/quorum reports the status after session.start and does not block', async ($, on) => {
  mock.env(on, { CCAPI_SERVER: '1' })
  mock.clock(on)
  on('command.register', async () => ({ value: undefined }) as never)
  on('session.start', async (_$, e) => ({ cwd: '/x' }) as never)
  await $.session.start({ cwd: '/x', surface: null, interactive: false } as never)
  const r = await $.command.run({ command: 'quorum', args: '' } as never)
  expect(String((r as { text?: string }).text)).toContain('role: service')
})

// QUORUM_DISABLE=1 (the `claude -p` of the hub's summarizer): the session is not registered.
test('QUORUM_DISABLE=1 starts no Link and does not register /quorum', async ($, on) => {
  mock.env(on, { CCAPI_SERVER: '1', QUORUM_DISABLE: '1' })
  mock.clock(on)
  let registered = 0
  on('command.register', async () => { registered++; return { value: undefined } as never })
  on('session.start', async (_$, e) => ({ cwd: '/x' }) as never)
  await $.session.start({ cwd: '/x', surface: null, interactive: false } as never)
  expect(registered).toBe(0)
  expect(quorum.link).toBeUndefined()
  expect(quorum.control).toBeUndefined()
})

// Headless runs (`claude -p`, the SDK) report isInteractive: false and must not register.
async function startWith(on: never, $: never, extra: Record<string, unknown>): Promise<number> {
  const o = on as (...a: unknown[]) => void
  mock.env(on as never, { CCAPI_SERVER: '1' })
  mock.clock(on as never)
  let registered = 0
  o('command.register', async () => { registered++; return { value: undefined } })
  o('session.start', async () => ({ cwd: '/x' }))
  await ($ as { session: { start(x: unknown): Promise<unknown> } }).session.start({ cwd: '/x', surface: null, ...extra })
  return registered
}

test('isInteractive=false (headless) starts no Link and still calls next', async ($, on) => {
  expect(await startWith(on as never, $ as never, { isInteractive: false })).toBe(0)
  expect(quorum.link).toBeUndefined()
  expect(quorum.control).toBeUndefined()
})

test('headless: next() still runs and nothing is sent to /v1/sessions/register', async ($, on) => {
  const o = on as unknown as (...a: unknown[]) => void
  mock.env(on as never, { CCAPI_SERVER: '1' })
  mock.clock(on as never)
  let nextRan = 0
  let registerCalls = 0
  o('command.register', async () => ({ value: undefined }))
  o('session.start', async () => { nextRan++; return { cwd: '/x' } })
  o('process.run', async () => ({ value: { exitCode: 0, stdout: JSON.stringify({ ok: true, port: 1, token: 't', machine: 'm' }), stderr: '' } }))
  o('http.fetch', async (_$: unknown, e: { url?: string }) => {
    if (String(e.url).endsWith('/v1/sessions/register')) registerCalls++
    return { value: { status: 204 } }
  })
  await ($ as never as { session: { start(x: unknown): Promise<unknown> } }).session.start({ cwd: '/x', surface: null, isInteractive: false })
  await new Promise((r) => setTimeout(r, 0))
  expect(nextRan).toBe(1)
  expect(registerCalls).toBe(0)
})

test('isInteractive=true registers as before', async ($, on) => {
  expect(await startWith(on as never, $ as never, { isInteractive: true })).toBe(1)
})

test('isInteractive absent (older Claude Code) is treated as interactive', async ($, on) => {
  expect(await startWith(on as never, $ as never, {})).toBe(1)
})

test('disabled only with QUORUM_DISABLE=1', () => {
  expect(disabled('1')).toBe(true)
  expect(disabled(undefined)).toBe(false)
  expect(disabled('0')).toBe(false)
})

// Task 5 (Plan 3): the session reports which launch and which herdr pane it runs in.
// The kit has no quorumd: ensure is faked and the body of /v1/sessions/register is captured.
async function registered($: never, on: never, env: Record<string, string>): Promise<Record<string, unknown>> {
  const o = on as (...a: unknown[]) => void
  mock.env(on as never, env)
  mock.clock(on as never)
  o('command.register', async () => ({ value: undefined }))
  o('session.start', async () => ({ cwd: '/x' }))
  o('process.run', async () => ({ value: { exitCode: 0, stdout: JSON.stringify({ ok: true, port: 1, token: 't', machine: 'm' }), stderr: '' } }))
  let body: Record<string, unknown> | undefined
  let got: () => void = () => {}
  const done = new Promise<void>(r => { got = r })
  o('http.fetch', async (_$: unknown, e: { url?: string; init?: { body?: string } }) => {
    if (String(e.url).endsWith('/v1/sessions/register') && !body) { body = JSON.parse(String(e.init?.body)); got() }
    return { value: { status: 204 } }
  })
  await ($ as { session: { start(x: unknown): Promise<unknown> } }).session.start({ cwd: '/x', surface: null, interactive: false })
  await done
  return body!
}

test('register sends launchReq and herdr pane from env', async ($, on) => {
  const b = await registered($ as never, on as never, { CCAPI_SERVER: '1', QUORUM_LAUNCH_REQ: 'req-1', HERDR_PANE_ID: 'p_3', HERDR_WORKSPACE_ID: 'w_2' })
  expect(b.launchReq).toBe('req-1')
  expect(b.herdrPane).toBe('p_3')
  expect(b.herdrWorkspace).toBe('w_2')
})

test('without the environment variables, launchReq and herdrPane are empty', async ($, on) => {
  const b = await registered($ as never, on as never, { CCAPI_SERVER: '1' })
  expect(b.launchReq).toBe('')
  expect(b.herdrPane).toBe('')
  expect(b.herdrWorkspace).toBe('')
})

// Plan 6 Task 2: account, config dir, plugins and meters travel with the registration.
test('register reports account, accountKey, configDir and plugins; never the identity itself', async ($, on) => {
  const o = on as unknown as (...a: unknown[]) => void
  mock.env(on as never, { CCAPI_SERVER: '1', CLAUDE_CONFIG_DIR: '/cfg' })
  mock.clock(on as never)
  const email = 'secret.person@example.com'
  o('command.register', async () => ({ value: undefined }))
  o('session.start', async () => ({ cwd: '/x' }))
  o('session.cwd', async () => ({ value: '/x' }))
  o('session.identity', async () => ({ value: { kind: 'claude.ai', email, organizationId: 'org-secret-1' } }))
  o('fs.read', async () => ({ value: JSON.stringify({ enabledPlugins: { 'after@better-claude': true, 'quick-peek@better-claude': true, 'use-haiku@better-claude': false } }) }))
  const runs: string[][] = []
  o('process.run', async (_$: unknown, e: { argv?: string[] }) => {
    runs.push(e.argv ?? [])
    if (e.argv?.[0] === 'bash') return { value: { exitCode: 0, stdout: 'claude@work via default profile', stderr: '' } }
    return { value: { exitCode: 0, stdout: JSON.stringify({ ok: true, port: 1, token: 't', machine: 'vps-1' }), stderr: '' } }
  })
  const bodies: Array<Record<string, unknown>> = []
  o('http.fetch', async (_$: unknown, e: { url?: string; init?: { body?: string } }) => {
    if (String(e.url).endsWith('/v1/sessions/register')) bodies.push(JSON.parse(String(e.init?.body)))
    return { value: { status: 204 } }
  })
  await ($ as never as { session: { start(x: unknown): Promise<unknown> } }).session.start({ cwd: '/x', surface: null })
  for (let i = 0; i < 50 && !bodies.some(b => b.account === 'work'); i++) await new Promise(r => setTimeout(r, 5))
  const b = bodies.find(x => x.account === 'work')!
  expect(b).toBeTruthy()
  expect(b.accountKey).toMatch(/^[0-9a-f]{16}$/)
  expect(b.configDir).toBe('/cfg')
  expect(b.plugins).toEqual(['after', 'quick-peek'])
  expect(runs.some(a => a[0] === 'bash' && a[1] === '-lc' && a[2] === 'whoas which claude')).toBe(true)
  const all = JSON.stringify(bodies)
  expect(all).not.toContain(email)
  expect(all).not.toContain('org-secret-1')
})

// Plan 6 Task 2 fix round: turn.complete and session.measure at hook level.
async function metered($: never, on: never, usage: () => unknown, startAt = 0) {
  const o = on as unknown as (...a: unknown[]) => void
  mock.env(on as never, { CLAUDE_CONFIG_DIR: '/cfg' }) // no CCAPI_SERVER: a work session, which emits turn_end
  const clock = mock.clock(on as never)
  let usageCalls = 0
  o('command.register', async () => ({ value: undefined }))
  o('session.start', async () => ({ cwd: '/x' }))
  o('session.id', async () => ({ value: 's-meter' }))
  o('session.cwd', async () => ({ value: '/x' }))
  o('session.usage', async () => { usageCalls++; return { value: usage() } })
  // the attach stream stays open, as quorumd's does
  o('process.spawn', async function* () { await new Promise(() => {}) })
  o('turn.complete', async () => ({ text: 'ok' }))
  o('session.measure', async () => ({ changed: [] }))
  o('process.run', async () => ({ value: { exitCode: 0, stdout: JSON.stringify({ ok: true, port: 1, token: 't', machine: 'vps-1' }), stderr: '' } }))
  const registers: Array<Record<string, any>> = []
  const turnEnds: Array<Record<string, any>> = []
  o('http.fetch', async (_$: unknown, e: { url?: string; init?: { body?: string } }) => {
    const url = String(e.url)
    if (url.endsWith('/v1/sessions/register')) registers.push(JSON.parse(String(e.init?.body)))
    else if (url.endsWith('/events')) for (const ev of JSON.parse(String(e.init?.body))) if (ev.kind === 'turn_end') turnEnds.push(ev.data)
    return { value: { status: 204 } }
  })
  if (startAt) await clock.advance(startAt)
  await ($ as { session: { start(x: unknown): Promise<unknown> } }).session.start({ cwd: '/x', surface: null })
  const until = async (f: () => boolean) => { for (let i = 0; i < 100 && !f(); i++) await new Promise(r => setTimeout(r, 5)) }
  await until(() => registers.length > 0)
  return { clock, registers, turnEnds, until, usageCalls: () => usageCalls }
}

const doneInput = (extra: Record<string, unknown>) => ({
  answer: 'ok', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer',
  usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 50, cache_creation_input_tokens: 25, model: 'model-x' },
  ...extra,
})

test('turn.complete: turn_end carries tokens and model, totals reach the next register, subagent turns do not count', async ($, on) => {
  const m = await metered($ as never, on as never, () => ({ context: { window: 1000, percent: 10 }, rateLimits: [{ kind: 'five_hour', percentUsed: 7, resetsAt: '2026-01-01T00:00:00Z' }] }))
  const t = $ as unknown as { turn: { complete(x: unknown): Promise<unknown> } }
  await t.turn.complete(doneInput({ agentId: 'ag1' }))
  await m.until(() => m.turnEnds.length > 0)
  expect(m.turnEnds).toHaveLength(0) // a subagent turn is not a turn_end
  expect(m.registers.every(r => r.tokens.in === 0)).toBe(true)
  await t.turn.complete(doneInput({}))
  await m.clock.advance(1000)
  await m.until(() => m.registers.some(r => r.tokens?.in === 1000))
  expect(m.turnEnds[0]).toMatchObject({ tokens: { in: 1000, out: 200, cache: 75 }, model: 'model-x' })
  const r = m.registers.find(x => x.tokens?.in === 1000)!
  expect(r.tokens).toEqual({ in: 1000, out: 200, cache: 75 })
  expect(r.rateLimits).toEqual([{ kind: 'five_hour', percentUsed: 7, resetsAt: '2026-01-01T00:00:00Z' }])
  expect(m.usageCalls()).toBe(2) // one usage read at session start, one per main-thread turn
})

test('two main turns 5 s apart: the second update carries both turns\' totals; usageAt only with fresh rate limits', async ($, on) => {
  const m = await metered($ as never, on as never, () => ({ context: { window: 1000, percent: 10 }, rateLimits: [{ kind: 'five_hour', percentUsed: 7, resetsAt: '' }] }))
  const t = $ as unknown as { turn: { complete(x: unknown): Promise<unknown> } }
  await m.clock.advance(60_000) // the mock clock starts at 0
  await t.turn.complete(doneInput({}))
  await m.clock.advance(1000)
  await m.until(() => m.registers.some(r => r.tokens?.in === 1000))
  const first = m.registers.find(r => r.tokens?.in === 1000)!
  expect(first.usageAt).toBeGreaterThan(0)
  await m.clock.advance(4_000)
  await t.turn.complete(doneInput({}))
  await m.clock.advance(1000)
  await m.until(() => m.registers.some(r => r.tokens?.in === 2000))
  const second = m.registers.find(r => r.tokens?.in === 2000)!
  expect(second.tokens).toEqual({ in: 2000, out: 400, cache: 150 })
  expect(second.usageAt).toBe(first.usageAt) // rate limits throttled: the old stamp is kept, not renewed
})

test('session.measure feeds rate limits through the 30 s throttle', async ($, on) => {
  const m = await metered($ as never, on as never, () => ({ context: { window: 1000, percent: 10 }, rateLimits: [] }))
  {
    const s = $ as unknown as { session: { measure(x: unknown): Promise<unknown> } }
    const meas = (p: number) => ({ context: { window: 1000, percent: 10 }, rateLimits: [{ kind: 'seven_day', percentUsed: p }], changed: ['rateLimits'] })
    const withRl = (p: number) => m.registers.filter(r => r.rateLimits?.[0]?.percentUsed === p).length
    await s.session.measure(meas(11))
    await m.until(() => withRl(11) > 0)
    await m.clock.advance(10_000)
    await s.session.measure(meas(12))
    await new Promise(r => setTimeout(r, 40))
    expect(withRl(12)).toBe(0)
    await m.clock.advance(25_000)
    await s.session.measure(meas(13))
    await m.until(() => withRl(13) > 0)
    // (debug removed)
    expect(withRl(13)).toBeGreaterThan(0)
    expect(withRl(11)).toBeGreaterThan(0)
  }
})

// session.start reads the usage once: rate limits go out at once, before any turn, so the account
// shows on the board right away; without rate limits nothing is reported.
test('session.start: usage with rate limits is reported at once with usageAt, no turn needed', async ($, on) => {
  const rl = [{ kind: 'five_hour', percentUsed: 41, resetsAt: '2026-01-01T05:00:00Z' }, { kind: 'seven_day', percentUsed: 9, resetsAt: '2026-01-07T00:00:00Z' }]
  const m = await metered($ as never, on as never, () => ({ context: { window: 1000, percent: 3 }, rateLimits: [...rl, { kind: 'spend_limit', percentUsed: 1 }] }), 5_000)
  await m.clock.advance(1000)
  await m.until(() => m.registers.some(r => r.rateLimits?.length))
  const r = m.registers.find(x => x.rateLimits?.length)!
  expect(r.rateLimits).toEqual(rl)
  expect(r.usageAt).toBe(5_000)
  expect(m.turnEnds).toHaveLength(0)
  expect(m.usageCalls()).toBe(1)
})

test('session.start: the first report bypasses the throttle but a measure 10 s later is still throttled', async ($, on) => {
  const m = await metered($ as never, on as never, () => ({ rateLimits: [{ kind: 'five_hour', percentUsed: 41, resetsAt: 'x' }] }), 5_000)
  await m.clock.advance(1000)
  await m.until(() => m.registers.some(r => r.rateLimits?.length))
  await m.clock.advance(9_000)
  const s = $ as unknown as { session: { measure(x: unknown): Promise<unknown> } }
  await s.session.measure({ rateLimits: [{ kind: 'five_hour', percentUsed: 77 }], changed: ['rateLimits'] })
  await new Promise(r => setTimeout(r, 40))
  expect(m.registers.some(r => r.rateLimits?.[0]?.percentUsed === 77)).toBe(false)
})

async function noRateLimits($: never, on: never, u: unknown) {
  const m = await metered($, on, () => u, 5_000)
  await m.clock.advance(1000)
  await m.until(() => m.usageCalls() > 0)
  await new Promise(r => setTimeout(r, 40))
  expect(m.usageCalls()).toBe(1)
  expect(m.registers.length).toBeGreaterThan(0)
  expect(m.registers.every(r => !r.rateLimits?.length && !r.usageAt)).toBe(true)
}

test('session.start: usage without rate limits yet reports nothing', async ($, on) => {
  await noRateLimits($ as never, on as never, { context: { window: 1000, percent: 3 } })
})

test('session.start: usage with only other limit kinds reports nothing', async ($, on) => {
  await noRateLimits($ as never, on as never, { rateLimits: [{ kind: 'spend_limit', percentUsed: 1 }] })
})

// Plan 6 Task 10: a prompt naming pasted images carries the files that exist; the register
// reports the session's images folder.
test('turn.start: [Image #N] with its file on disk -> user event images and imagesDir in the register', async ($, on) => {
  const o = on as unknown as (...a: unknown[]) => void
  mock.env(on as never, { CLAUDE_CONFIG_DIR: '/cfg', CLAUDE_CODE_TMPDIR: '/var/tmp' })
  const clock = mock.clock(on as never)
  o('command.register', async () => ({ value: undefined }))
  o('session.start', async () => ({ cwd: '/home/u/app' }))
  o('session.id', async () => ({ value: 'S1' }))
  o('session.cwd', async () => ({ value: '/home/u/app' }))
  o('session.root', async () => ({ value: '/home/u/app' }))
  o('process.spawn', async function* () { await new Promise(() => {}) })
  o('turn.start', async () => ({ turnId: 't1' }))
  o('fs.list', async (_$: unknown, e: { path?: string }) => {
    if (e.path === '/var/tmp/claude-1000/-home-u-app/S1/images') return { value: [{ name: '1.png', kind: 'file', size: 3, mtimeMs: 1, isLink: false }] }
    throw new Error('ENOENT')
  })
  o('process.run', async (_$: unknown, e: { argv?: string[] }) => {
    if (e.argv?.[0] === 'id') return { value: { exitCode: 0, stdout: '1000\n', stderr: '' } }
    return { value: { exitCode: 0, stdout: JSON.stringify({ ok: true, port: 1, token: 't', machine: 'vps-1' }), stderr: '' } }
  })
  const registers: Array<Record<string, any>> = []
  const users: Array<Record<string, any>> = []
  o('http.fetch', async (_$: unknown, e: { url?: string; init?: { body?: string } }) => {
    const url = String(e.url)
    if (url.endsWith('/v1/sessions/register')) registers.push(JSON.parse(String(e.init?.body)))
    else if (url.endsWith('/events')) for (const ev of JSON.parse(String(e.init?.body))) if (ev.kind === 'user') users.push(ev.data)
    return { value: { status: 204 } }
  })
  await ($ as never as { session: { start(x: unknown): Promise<unknown> } }).session.start({ cwd: '/home/u/app', surface: null })
  const until = async (f: () => boolean) => { for (let i = 0; i < 100 && !f(); i++) await new Promise(r => setTimeout(r, 5)) }
  await until(() => registers.length > 0)
  await ($ as never as { turn: { start(x: unknown): Promise<unknown> } }).turn.start({ text: 'look at [Image #1] and [Image #2]', turnId: 't1' })
  await clock.advance(1000)
  await until(() => users.length > 0 && registers.some(r => r.imagesDir))
  expect(users[0]).toEqual({ text: 'look at [Image #1] and [Image #2]', images: [{ n: 1, path: '/var/tmp/claude-1000/-home-u-app/S1/images/1.png' }] })
  expect(registers.find(r => r.imagesDir)!.imagesDir).toBe('/var/tmp/claude-1000/-home-u-app/S1/images')
})

// Plan 6 final fixes: a slow pasted-image lookup never holds the turn for more than ~300 ms.
test('turn.start: a hung images lookup gives up after 300 ms and the turn goes on without images', async ($, on) => {
  const o = on as unknown as (...a: unknown[]) => void
  mock.env(on as never, { CLAUDE_CONFIG_DIR: '/cfg', CLAUDE_CODE_TMPDIR: '/var/tmp' })
  const clock = mock.clock(on as never)
  o('command.register', async () => ({ value: undefined }))
  o('session.start', async () => ({ cwd: '/home/u/app' }))
  o('session.id', async () => ({ value: 'S1' }))
  o('session.cwd', async () => ({ value: '/home/u/app' }))
  o('session.root', async () => ({ value: '/home/u/app' }))
  o('process.spawn', async function* () { await new Promise(() => {}) })
  o('turn.start', async () => ({ turnId: 't1' }))
  o('fs.list', async () => new Promise(() => {})) // a stuck file system
  o('process.run', async (_$: unknown, e: { argv?: string[] }) => {
    if (e.argv?.[0] === 'id') return { value: { exitCode: 0, stdout: '1000\n', stderr: '' } }
    return { value: { exitCode: 0, stdout: JSON.stringify({ ok: true, port: 1, token: 't', machine: 'vps-1' }), stderr: '' } }
  })
  const registers: Array<Record<string, any>> = []
  const users: Array<Record<string, any>> = []
  o('http.fetch', async (_$: unknown, e: { url?: string; init?: { body?: string } }) => {
    const url = String(e.url)
    if (url.endsWith('/v1/sessions/register')) registers.push(JSON.parse(String(e.init?.body)))
    else if (url.endsWith('/events')) for (const ev of JSON.parse(String(e.init?.body))) if (ev.kind === 'user') users.push(ev.data)
    return { value: { status: 204 } }
  })
  await ($ as never as { session: { start(x: unknown): Promise<unknown> } }).session.start({ cwd: '/home/u/app', surface: null })
  const until = async (f: () => boolean) => { for (let i = 0; i < 100 && !f(); i++) await new Promise(r => setTimeout(r, 5)) }
  await until(() => registers.length > 0)
  let done = false
  const p = ($ as never as { turn: { start(x: unknown): Promise<unknown> } }).turn.start({ text: 'look at [Image #1]', turnId: 't1' }).then(() => { done = true })
  await new Promise(r => setTimeout(r, 20))
  expect(done).toBe(false)
  await clock.advance(300)
  await until(() => done)
  expect(done).toBe(true)
  await p
  await clock.advance(1000)
  await until(() => users.length > 0)
  expect(users[0]).toEqual({ text: 'look at [Image #1]' })
})
