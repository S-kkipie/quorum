import { expect, test } from 'claude-code/testing'

import { Asks } from '../src/control'
import { HOLD_MAX_MS, LATE_NOTICE, NO_TERMINAL_MS, permissionQuestion, permissionRace, type PermissionDeps } from '../src/permission'

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

/** Fakes: link that records events, manual sleep, manual clock, manual terminal dialog. */
function fake(opts: { signal?: AbortSignal } = {}) {
  const evs: Array<{ kind: string; data: any }> = []
  const sleeps: Array<{ ms: number; fire: () => void }> = []
  const clock = { t: 1_000 }
  let n = 0
  const asks = new Asks(
    () => ({ emit: (e: any) => { evs.push(e) }, update: () => {} }) as never,
    ms => new Promise<void>(r => sleeps.push({ ms, fire: r })),
    () => `a${++n}`,
  )
  const questions: string[] = []
  const logs: string[] = []
  let answer!: (s: unknown) => void
  let dismiss!: (e: unknown) => void
  const held: Array<Promise<unknown>> = []
  const deps: PermissionDeps = {
    termAsk: q => { questions.push(q); return new Promise<unknown>((res, rej) => { answer = res; dismiss = rej }) },
    asks,
    keepAlive: u => { held.push(u) },
    signal: opts.signal,
    log: m => { logs.push(m) },
    now: () => clock.t,
  }
  const a = { tool: 'Write', summary: '/x/hola.txt', detail: '{"file_path":"/x/hola.txt"}' }
  return {
    deps, a, asks, evs, sleeps, clock, questions, held, logs,
    answer: (s: unknown) => answer(s),
    dismiss: () => dismiss(new Error('no answer')),
    kinds: () => evs.map(e => e.kind),
    resolved: () => evs.filter(e => e.kind === 'ask_resolved').map(e => e.data),
  }
}

test('a device wins (allow): no ask_resolved from the mod; the late terminal answer changes nothing', async () => {
  const f = fake()
  const p = permissionRace(f.deps, f.a)
  await flush()
  expect(f.questions).toEqual(['Write: /x/hola.txt'])
  expect(f.evs[0]).toEqual({ kind: 'ask', data: { askId: 'a1', kind: 'permission', tool: 'Write', summary: '/x/hola.txt', detail: '{"file_path":"/x/hola.txt"}', questions: null, agent: '' } })
  expect(f.sleeps.map(s => s.ms)).toEqual([HOLD_MAX_MS])
  expect(f.held.length).toBe(1)
  f.asks.resolve('a1', { decision: 'allow' })
  expect(await p).toEqual({ decision: 'allow', reason: 'Allowed from Quorum' })
  f.answer('Deny')
  await flush()
  expect(f.resolved()).toEqual([])
  expect(f.logs).toEqual([LATE_NOTICE])
  expect(f.kinds()).toEqual(['ask', 'status', 'status'])
  expect(f.asks.pending).toEqual([])
  // the keep-alive is released with the decision
  let released = false
  void f.held[0].then(() => { released = true })
  await flush()
  expect(released).toBe(true)
})

test('the device denies: with its reason or the generic one', async () => {
  const f = fake()
  const p1 = permissionRace(f.deps, f.a)
  await flush()
  f.asks.resolve('a1', { decision: 'deny', reason: 'no toques eso' })
  expect(await p1).toEqual({ decision: 'deny', reason: 'no toques eso' })
  const p2 = permissionRace(f.deps, f.a)
  await flush()
  f.asks.resolve('a2', { decision: 'deny' })
  expect(await p2).toEqual({ decision: 'deny', reason: 'Denied from Quorum' })
})

test('the terminal answers Allow first → allow y ask_resolved{by:terminal}', async () => {
  const f = fake()
  const p = permissionRace(f.deps, f.a)
  await flush()
  f.answer('Allow')
  expect(await p).toEqual({ decision: 'allow', reason: 'Allowed in the terminal' })
  expect(f.resolved()).toEqual([{ askId: 'a1', by: 'terminal' }])
  expect(f.asks.pending).toEqual([])
  // a late device decision no longer finds the ask
  expect(f.asks.resolve('a1', { decision: 'deny' })).toBe(false)
})

test('the terminal answers Deny → deny', async () => {
  const f = fake()
  const p = permissionRace(f.deps, f.a)
  await flush()
  f.answer('Deny')
  expect(await p).toEqual({ decision: 'deny', reason: 'Denied in the terminal' })
  expect(f.resolved()).toEqual([{ askId: 'a1', by: 'terminal' }])
})

test('the terminal types something else (Other) → deny with what was typed', async () => {
  const f = fake()
  const p = permissionRace(f.deps, f.a)
  await flush()
  f.answer('better in /tmp')
  expect(await p).toEqual({ decision: 'deny', reason: 'Denied in the terminal: better in /tmp' })
})

test('the owner closes the dialog (Esc) → the terminal denies and withdraws the card', async () => {
  const f = fake()
  const p = permissionRace(f.deps, f.a)
  await flush()
  f.clock.t += NO_TERMINAL_MS
  f.dismiss()
  expect(await p).toEqual({ decision: 'deny', reason: 'Denied in the terminal' })
  expect(f.resolved()).toEqual([{ askId: 'a1', by: 'terminal' }])
  expect(f.asks.pending).toEqual([])
})

test('a non-text answer → deny without breaking anything', async () => {
  const f = fake()
  const p = permissionRace(f.deps, f.a)
  await flush()
  f.answer(undefined)
  expect(await p).toEqual({ decision: 'deny', reason: 'Denied in the terminal' })
})

test('nobody answers within HOLD_MAX_MS → deny with a reason y ask_resolved{by:terminal}', async () => {
  const f = fake()
  const p = permissionRace(f.deps, f.a)
  await flush()
  f.sleeps[0].fire()
  expect(await p).toEqual({ decision: 'deny', reason: 'No answer in 19 min (Quorum)' })
  expect(f.resolved()).toEqual([{ askId: 'a1', by: 'terminal' }])
})

test('aborted signal (turn interrupted) → withdraws the ask and denies', async () => {
  const ac = new AbortController()
  const f = fake({ signal: ac.signal })
  const p = permissionRace(f.deps, f.a)
  await flush()
  ac.abort()
  expect(await p).toEqual({ decision: 'deny', reason: 'Turn interrupted' })
  expect(f.kinds()).toEqual(['ask', 'status', 'ask_resolved', 'status'])
  expect(f.resolved()).toEqual([{ askId: 'a1', by: 'terminal' }])
  // the terminal's late answer emits nothing more
  f.answer('Allow')
  await flush()
  expect(f.resolved().length).toBe(1)
})

test('signal already aborted → denies without asking', async () => {
  const ac = new AbortController()
  ac.abort()
  const f = fake({ signal: ac.signal })
  expect(await permissionRace(f.deps, f.a)).toEqual({ decision: 'deny', reason: 'Turn interrupted' })
  expect(f.evs).toEqual([])
  expect(f.questions).toEqual([])
})

test('withdrawn from outside (end of turn, close) → deny Turn interrupted', async () => {
  const f = fake()
  const p = permissionRace(f.deps, f.a)
  await flush()
  f.asks.withdrawKind('permission')
  expect(await p).toEqual({ decision: 'deny', reason: 'Turn interrupted' })
  expect(f.resolved()).toEqual([{ askId: 'a1', by: 'terminal' }])
})

test('termAsk that throws when called = no terminal: the device continues, no exception', async () => {
  const f = fake()
  f.deps.termAsk = () => { throw new Error('no ui') }
  const p = permissionRace(f.deps, f.a)
  await flush()
  expect(f.asks.pending).toEqual(['a1'])
  f.asks.resolve('a1', { decision: 'allow' })
  expect(await p).toEqual({ decision: 'allow', reason: 'Allowed from Quorum' })
})

test('no terminal (no termAsk): only the device, up to the cap', async () => {
  const f = fake()
  f.deps.termAsk = undefined
  const p = permissionRace(f.deps, f.a)
  await flush()
  expect(f.questions).toEqual([])
  expect(f.kinds()).toEqual(['ask', 'status'])
  expect(f.held.length).toBe(1)
  f.sleeps[0].fire()
  expect(await p).toEqual({ decision: 'deny', reason: 'No answer in 19 min (Quorum)' })
  expect(f.resolved()).toEqual([{ askId: 'a1', by: 'terminal' }])
})

test('$.ui.ask rejects right away (< 500 ms, -p run) → not Esc: waits for the device', async () => {
  const f = fake()
  const p = permissionRace(f.deps, f.a)
  let out: unknown
  void p.then(v => { out = v })
  await flush()
  f.clock.t += NO_TERMINAL_MS - 1
  f.dismiss()
  await flush()
  expect(out).toBe(undefined)
  expect(f.asks.pending).toEqual(['a1'])
  expect(f.resolved()).toEqual([])
  f.asks.resolve('a1', { decision: 'deny', reason: 'from the phone' })
  expect(await p).toEqual({ decision: 'deny', reason: 'from the phone' })
})

test('late answer after expiring or being withdrawn: no Quorum notice', async () => {
  const f = fake()
  const p = permissionRace(f.deps, f.a)
  await flush()
  f.asks.withdrawKind('permission')
  await p
  f.answer('Allow')
  await flush()
  expect(f.logs).toEqual([])
})

test('two races at once: distinct askIds; answering one withdraws only that one; needs_you until the other', async () => {
  const f = fake()
  const answers: Array<(s: string) => void> = []
  f.deps.termAsk = () => new Promise<string>(r => { answers.push(r) })
  const p1 = permissionRace(f.deps, f.a)
  const p2 = permissionRace(f.deps, { tool: 'Bash', summary: 'ls', detail: '' })
  await flush()
  expect(f.evs.filter(e => e.kind === 'ask').map(e => e.data.askId)).toEqual(['a1', 'a2'])
  answers[0]('Allow')
  expect(await p1).toEqual({ decision: 'allow', reason: 'Allowed in the terminal' })
  expect(f.resolved()).toEqual([{ askId: 'a1', by: 'terminal' }])
  expect(f.asks.pending).toEqual(['a2'])
  const statuses = () => f.evs.filter(e => e.kind === 'status').map(e => e.data.state)
  expect(statuses()).toEqual(['needs_you', 'needs_you'])
  f.asks.resolve('a2', { decision: 'deny' })
  expect(await p2).toEqual({ decision: 'deny', reason: 'Denied from Quorum' })
  expect(statuses()).toEqual(['needs_you', 'needs_you', 'working'])
})

test('a subagent ask: withdrawAgent withdraws only its own', async () => {
  const f = fake()
  const p1 = permissionRace(f.deps, { ...f.a, agentId: 'ag1' })
  const p2 = permissionRace(f.deps, { ...f.a, agentId: 'ag2' })
  await flush()
  f.asks.withdrawAgent('ag1')
  expect(await p1).toEqual({ decision: 'deny', reason: 'Turn interrupted' })
  expect(f.asks.pending).toEqual(['a2'])
  f.asks.resolve('a2', { decision: 'allow' })
  expect(await p2).toEqual({ decision: 'allow', reason: 'Allowed from Quorum' })
})

test('terminal question: "<tool>: <summary>" up to 120 characters', () => {
  expect(permissionQuestion('Bash', 'ls')).toBe('Bash: ls')
  const q = permissionQuestion('Bash', 'x'.repeat(300))
  expect(q.length).toBe(120)
  expect(q.startsWith('Bash: xxx')).toBe(true)
  expect(q.endsWith('…')).toBe(true)
  expect(permissionQuestion('Bash', '')).toBe('Bash')
  expect(permissionQuestion('Bash', '  echo a\n\n  echo\tb  ')).toBe('Bash: echo a echo b')
  const long = permissionQuestion('Bash', 'a\n'.repeat(200))
  expect(long.length).toBe(120)
  expect(long.includes('\n')).toBe(false)
})
