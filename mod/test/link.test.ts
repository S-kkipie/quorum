import { expect, test } from 'claude-code/testing'

import { Link } from '../src/link'
import type { LinkIO } from '../src/link'
import type { SessionInfo } from '../src/proto.gen'

const ENSURE = JSON.stringify({ ok: true, port: 4444, token: 'tok', machine: 'm1', version: '0.1.0' })
const INFO: SessionInfo = {
  id: 's1', previousId: '', machine: '', name: '', cwd: '/x', root: '/x', model: 'm', role: 'work',
  state: 'idle', contextPct: 0, startedAt: 1, updatedAt: 1,
  transcriptPath: '/home/u/.claude/projects/x/s1.jsonl',
}

const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }

// Fake clock: sleep resolves on advance.
function fake() {
  let t = 0
  const sleepers: Array<{ at: number; fn: () => void }> = []
  const runs: string[][] = []
  const posts: Array<{ url: string; body: any }> = []
  const sleeps: number[] = []
  const spawns: Array<{ push(text: string, stream?: string): void; end(): void }> = []
  let fetchImpl: (url: string, init: any) => Promise<{ status: number }> = async () => ({ status: 204 })
  const io: LinkIO = {
    run: async argv => { runs.push(argv); return { exitCode: 0, stdout: ENSURE } },
    fetch: (url, init) => {
      posts.push({ url, body: init.body ? JSON.parse(init.body) : undefined })
      return fetchImpl(url, init)
    },
    spawn: argv => {
      const q: Array<{ stream: string; text: string }> = []
      let wake: (() => void) | undefined
      let done = false
      spawns.push({
        push: (text, stream = 'stdout') => { q.push({ stream, text }); wake?.() },
        end: () => { done = true; wake?.() },
      })
      return (async function* () {
        while (true) {
          if (q.length) { yield q.shift()!; continue }
          if (done) return
          await new Promise<void>(r => { wake = r })
        }
      })()
    },
    sleep: ms => { sleeps.push(ms); return new Promise<void>(r => { sleepers.push({ at: t + ms, fn: r }) }) },
    now: () => t,
  }
  const advance = async (ms: number) => {
    const end = t + ms
    for (;;) {
      await tick()
      const due = sleepers.filter(s => s.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      sleepers.splice(sleepers.indexOf(due), 1)
      t = Math.max(t, due.at)
      due.fn()
    }
    t = end
    await tick()
  }
  return { io, runs, posts, spawns, sleeps, advance, setFetch: (f: typeof fetchImpl) => { fetchImpl = f } }
}

test('300 assistant_delta in <150 ms produce a single POST with one delta', async () => {
  const f = fake()
  const link = new Link(f.io)
  await link.start(INFO)
  f.posts.length = 0
  for (let i = 0; i < 300; i++) link.emit({ kind: 'assistant_delta', data: { text: 'a' } })
  await f.advance(150)
  const evs = f.posts.filter(p => p.url.endsWith('/v1/sessions/s1/events'))
  expect(evs.length).toBe(1)
  expect(evs[0].body.length).toBe(1)
  expect(evs[0].body[0].data.text).toBe('a'.repeat(300))
  link.stop()
})

test('the register includes transcriptPath', async () => {
  const f = fake()
  const link = new Link(f.io)
  await link.start(INFO)
  await tick()
  const reg = f.posts.find(p => p.url.endsWith('/register'))
  expect(reg?.body.transcriptPath).toBe(INFO.transcriptPath)
  link.stop()
})

test('if attach ends, after 1 s there is a new ensure and a new register', async () => {
  const f = fake()
  const link = new Link(f.io)
  await link.start(INFO)
  await tick()
  expect(f.runs.length).toBe(1)
  expect(f.spawns.length).toBe(1)
  f.spawns[0].end()
  await f.advance(900)
  expect(f.runs.length).toBe(1)
  await f.advance(200)
  expect(f.runs.length).toBe(2)
  expect(f.runs[1]).toEqual(['quorumd', 'ensure', '--json'])
  expect(f.posts.filter(p => p.url.endsWith('/register')).length).toBe(2)
  expect(f.spawns.length).toBe(2)
  link.stop()
})

test('backoff 1, 2, 5, 10, 10 s', async () => {
  const f = fake()
  const link = new Link(f.io)
  await link.start(INFO)
  let expected = 1
  for (const wait of [1000, 2000, 5000, 10000, 10000]) {
    f.spawns[f.spawns.length - 1].end()
    await f.advance(wait - 1)
    expect(f.runs.length).toBe(expected)
    await f.advance(2)
    expected++
    expect(f.runs.length).toBe(expected)
  }
  link.stop()
})

test('a JSON line split across two chunks produces a single Command; ping is ignored', async () => {
  const f = fake()
  const link = new Link(f.io)
  const got: any[] = []
  link.onCommand(c => got.push(c))
  await link.start(INFO)
  const s = f.spawns[0]
  s.push('{"type":"ping"}\n{"type":"prompt","te')
  await tick()
  expect(got.length).toBe(0)
  s.push('xt":"hola"}\n')
  await tick()
  expect(got.length).toBe(1)
  expect(got[0].text).toBe('hola')
  link.stop()
})

test('a rejecting fetch does not throw outward', async () => {
  const f = fake()
  f.setFetch(async () => { throw new Error('boom') })
  const link = new Link(f.io)
  await link.start(INFO)
  link.emit({ kind: 'info', data: { text: 'x' } })
  await f.advance(400)
  expect(link.state).toBe('reconnecting')
  link.stop()
})

test('adoptId re-registers with previousId', async () => {
  const f = fake()
  const link = new Link(f.io)
  await link.start(INFO)
  link.adoptId('s2')
  await f.advance(10)
  const regs = f.posts.filter(p => p.url.endsWith('/register'))
  expect(regs[regs.length - 1].body.id).toBe('s2')
  expect(regs[regs.length - 1].body.previousId).toBe('s1')
  link.stop()
})

test('adoptId leaves no two attach loops: the old one stops consuming and does not retry', async () => {
  const f = fake()
  const link = new Link(f.io)
  const got: string[] = []
  link.onCommand(c => got.push(c.text))
  await link.start(INFO)
  expect(f.spawns.length).toBe(1)
  link.adoptId('s2')
  await f.advance(10)
  expect(f.spawns.length).toBe(2)
  // the old attach is no longer consumed: its commands do not arrive
  f.spawns[0].push('{"type":"prompt","text":"viejo"}\n')
  f.spawns[1].push('{"type":"prompt","text":"new"}\n')
  await f.advance(10)
  expect(got).toEqual(['new'])
  // the daemon closes the old stream (Upsert with previousId): no retry and no third attach
  f.spawns[0].end()
  await f.advance(20_000)
  expect(f.spawns.length).toBe(2)
  link.stop()
})

test('a stale connect does not overwrite the state of the new epoch', async () => {
  const f = fake()
  const link = new Link(f.io)
  let release!: () => void
  f.setFetch(async url => {
    if (url.endsWith('/register') && !release) await new Promise<void>(r => { release = r })
    return { status: 204 }
  })
  const first = link.start(INFO)
  await tick()
  link.adoptId('s2') // new epoch while s1's register is still in flight
  await f.advance(10)
  expect(link.state).toBe('connected')
  const spawnsBefore = f.spawns.length
  release()
  await first
  await f.advance(10)
  expect(f.spawns.length).toBe(spawnsBefore) // the old connect does not launch another loop
  expect(link.sessionId).toBe('s2')
  link.stop()
})

test('ensure with a non-zero code leaves no daemon and reports stderr', async () => {
  const f = fake()
  f.io.run = async () => ({ exitCode: 1, stdout: 'no json', stderr: 'boom' })
  const link = new Link(f.io)
  await link.start(INFO)
  expect(link.state).toBe('no-daemon')
  expect(link.error).toContain('boom')
  link.stop()
})

test('events are stamped with the current id when flushing the queue', async () => {
  const f = fake()
  const link = new Link(f.io)
  await link.start(INFO)
  f.posts.length = 0
  link.emit({ kind: 'info', data: { text: 'x' } })
  link.adoptId('s2')
  await f.advance(400)
  const ev = f.posts.find(p => p.url.endsWith('/events'))!
  expect(ev.url).toContain('/s2/')
  expect(ev.body[0].session).toBe('s2')
  link.stop()
})

test('non-zero ensure without stderr takes the error from the stdout JSON', async () => {
  const f = fake()
  f.io.run = async () => ({ exitCode: 1, stdout: '{"ok":false,"error":"no port"}', stderr: '' })
  const link = new Link(f.io)
  await link.start(INFO)
  expect(link.error).toContain('no port')
  link.stop()
})

test('update merges the info and re-registers with the new state', async () => {
  const f = fake()
  const link = new Link(f.io)
  await link.start(INFO)
  f.posts.length = 0
  link.update({ state: 'working', contextPct: 33 })
  await tick()
  const regs = f.posts.filter(p => p.url.endsWith('/register'))
  expect(regs.length).toBe(1)
  expect(regs[0].body.state).toBe('working')
  expect(regs[0].body.contextPct).toBe(33)
  expect(regs[0].body.machine).toBe('m1')
  link.stop()
})

test('update serializes registers: never an old state after a new one', async () => {
  const f = fake()
  const link = new Link(f.io)
  await link.start(INFO)
  f.posts.length = 0
  let release!: () => void
  f.setFetch(() => new Promise(r => { release = () => r({ status: 204 }) }))
  link.update({ state: 'working' })
  link.update({ state: 'idle' })
  link.update({ contextPct: 9 })
  await tick()
  expect(f.posts.filter(p => p.url.endsWith('/register')).length).toBe(1)
  f.setFetch(async () => ({ status: 204 }))
  release()
  await tick()
  const regs = f.posts.filter(p => p.url.endsWith('/register'))
  expect(regs.length).toBe(2)
  expect(regs[1].body.state).toBe('idle')
  expect(regs[1].body.contextPct).toBe(9)
  link.stop()
})

test('full queue: an assistant_delta is dropped first and, if none, the oldest', async () => {
  const f = fake()
  f.io.run = async () => ({ exitCode: 1, stdout: '', stderr: 'no daemon' }) // nothing flushes
  const link = new Link(f.io)
  await link.start(INFO)
  link.emit({ kind: 'info', data: { text: 'i0' } })
  link.emit({ kind: 'assistant_delta', data: { text: 'd' } })
  for (let i = 1; i < 2000; i++) link.emit({ kind: 'info', data: { text: `i${i}` } })
  const q = () => (link as any).queue as Array<{ kind: string; data: any }>
  expect(q().length).toBe(2000)
  expect(q().some(e => e.kind === 'assistant_delta')).toBe(false)
  expect(q()[0].data.text).toBe('i0')
  link.emit({ kind: 'info', data: { text: 'i2000' } })
  expect(q().length).toBe(2000)
  expect(q()[0].data.text).toBe('i1')
  expect(q()[1999].data.text).toBe('i2000')
  link.stop()
})

test('after 30 s of healthy attach the backoff goes back to 1 s', async () => {
  const f = fake()
  const link = new Link(f.io)
  await link.start(INFO)
  f.spawns[0].end()
  await f.advance(1001) // 1 s
  f.spawns[1].end()
  await f.advance(2001) // 2 s
  expect(f.runs.length).toBe(3)
  await f.advance(31_000) // attach sano > 30 s
  f.spawns[2].end()
  await f.advance(999)
  expect(f.runs.length).toBe(3)
  await f.advance(2)
  expect(f.runs.length).toBe(4)
  link.stop()
})

test('stderr chunks of attach are ignored', async () => {
  const f = fake()
  const link = new Link(f.io)
  const got: any[] = []
  link.onCommand(c => got.push(c))
  await link.start(INFO)
  f.spawns[0].push('{"type":"prompt","text":"err"}\n', 'stderr')
  f.spawns[0].push('{"type":"prompt","text":"out"}\n')
  await tick()
  expect(got.map(c => c.text)).toEqual(['out'])
  link.stop()
})

test('consecutive stop and start leave a single flush loop', async () => {
  const f = fake()
  const link = new Link(f.io)
  await link.start(INFO)
  link.stop()
  await link.start(INFO)
  f.sleeps.length = 0
  await f.advance(150 * 4)
  expect(f.sleeps.filter(ms => ms === 150).length).toBe(4)
  link.emit({ kind: 'info', data: { text: 'x' } })
  f.posts.length = 0
  await f.advance(150)
  expect(f.posts.filter(p => p.url.endsWith('/events')).length).toBe(1)
  link.stop()
})

test('stop/start with an events POST in flight: the next one waits for it to finish', async () => {
  const f = fake()
  const link = new Link(f.io)
  await link.start(INFO)
  let release!: () => void
  let inflight = 0
  f.setFetch(async url => {
    if (url.endsWith('/events') && !release) { inflight++; await new Promise<void>(r => { release = r }); inflight-- }
    return { status: 204 }
  })
  link.emit({ kind: 'info', data: { text: 'a' } })
  await f.advance(150)
  expect(inflight).toBe(1)
  link.stop()
  await link.start(INFO)
  link.emit({ kind: 'info', data: { text: 'b' } })
  f.posts.length = 0
  await f.advance(600)
  expect(f.posts.filter(p => p.url.endsWith('/events')).length).toBe(0)
  release()
  await f.advance(300)
  const evs = f.posts.filter(p => p.url.endsWith('/events'))
  expect(evs.length).toBe(1)
  expect(evs[0].body[0].data.text).toBe('b')
  link.stop()
})

test('daemon version different from the mod: warning in log and versionWarning', async () => {
  const f = fake()
  const logs: string[] = []
  f.io.log = m => { logs.push(m) }
  f.io.run = async () => ({ exitCode: 0, stdout: JSON.stringify({ ok: true, port: 4444, token: 'tok', machine: 'm1', version: '0.0.1' }) })
  const link = new Link(f.io)
  await link.start(INFO)
  expect(link.daemonVersion).toBe('0.0.1')
  expect(link.versionWarning).toContain('0.0.1')
  expect(logs.some(l => l.includes('does not match'))).toBe(true)
  link.stop()
})

test('same version (or not reported): no warning', async () => {
  const f = fake()
  const link = new Link(f.io)
  await link.start(INFO)
  expect(link.versionWarning).toBe('')
  link.stop()
})

test('update() during the first register in flight causes exactly one follow-up register', async () => {
  const f = fake()
  let release: () => void = () => {}
  const gate = new Promise<void>(r => { release = r })
  let n = 0
  f.setFetch(async url => {
    if (url.endsWith('/register') && n++ === 0) await gate
    return { status: 204 }
  })
  const link = new Link(f.io)
  const started = link.start(INFO)
  await tick()
  link.update({ account: 'work' } as never)
  release()
  await started
  await f.advance(100)
  const regs = f.posts.filter(p => p.url.endsWith('/register'))
  expect(regs).toHaveLength(2)
  expect(regs[0].body.account).toBeUndefined()
  expect(regs[1].body.account).toBe('work')
  await f.advance(5000)
  expect(f.posts.filter(p => p.url.endsWith('/register'))).toHaveLength(2)
  link.stop()
})
