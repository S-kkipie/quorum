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

// Reloj falso: sleep se resuelve al avanzar.
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

test('300 assistant_delta en <150 ms producen un solo POST con un delta', async () => {
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

test('el register incluye transcriptPath', async () => {
  const f = fake()
  const link = new Link(f.io)
  await link.start(INFO)
  await tick()
  const reg = f.posts.find(p => p.url.endsWith('/register'))
  expect(reg?.body.transcriptPath).toBe(INFO.transcriptPath)
  link.stop()
})

test('si attach termina, tras 1 s hay nuevo ensure y nuevo register', async () => {
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

test('una línea JSON partida en dos chunks produce un solo Command; ping se ignora', async () => {
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

test('un fetch que rechaza no lanza hacia afuera', async () => {
  const f = fake()
  f.setFetch(async () => { throw new Error('boom') })
  const link = new Link(f.io)
  await link.start(INFO)
  link.emit({ kind: 'info', data: { text: 'x' } })
  await f.advance(400)
  expect(link.state).toBe('reconnecting')
  link.stop()
})

test('adoptId vuelve a registrar con previousId', async () => {
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

test('adoptId no deja dos bucles attach: el viejo deja de consumir y no reintenta', async () => {
  const f = fake()
  const link = new Link(f.io)
  const got: string[] = []
  link.onCommand(c => got.push(c.text))
  await link.start(INFO)
  expect(f.spawns.length).toBe(1)
  link.adoptId('s2')
  await f.advance(10)
  expect(f.spawns.length).toBe(2)
  // el attach viejo ya no se consume: sus comandos no llegan
  f.spawns[0].push('{"type":"prompt","text":"viejo"}\n')
  f.spawns[1].push('{"type":"prompt","text":"nuevo"}\n')
  await f.advance(10)
  expect(got).toEqual(['nuevo'])
  // el daemon cierra el stream viejo (Upsert con previousId): no hay reintento ni tercer attach
  f.spawns[0].end()
  await f.advance(20_000)
  expect(f.spawns.length).toBe(2)
  link.stop()
})

test('un connect obsoleto no pisa el estado de la época nueva', async () => {
  const f = fake()
  const link = new Link(f.io)
  let release!: () => void
  f.setFetch(async url => {
    if (url.endsWith('/register') && !release) await new Promise<void>(r => { release = r })
    return { status: 204 }
  })
  const first = link.start(INFO)
  await tick()
  link.adoptId('s2') // época nueva mientras el register de s1 sigue en vuelo
  await f.advance(10)
  expect(link.state).toBe('connected')
  const spawnsBefore = f.spawns.length
  release()
  await first
  await f.advance(10)
  expect(f.spawns.length).toBe(spawnsBefore) // el connect viejo no lanza otro bucle
  expect(link.sessionId).toBe('s2')
  link.stop()
})

test('ensure con código distinto de 0 deja sin daemon y reporta stderr', async () => {
  const f = fake()
  f.io.run = async () => ({ exitCode: 1, stdout: 'no json', stderr: 'boom' })
  const link = new Link(f.io)
  await link.start(INFO)
  expect(link.state).toBe('no-daemon')
  expect(link.error).toContain('boom')
  link.stop()
})

test('los eventos se sellan con el id vigente al vaciar la cola', async () => {
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

test('ensure no-cero sin stderr toma el error del stdout JSON', async () => {
  const f = fake()
  f.io.run = async () => ({ exitCode: 1, stdout: '{"ok":false,"error":"sin puerto"}', stderr: '' })
  const link = new Link(f.io)
  await link.start(INFO)
  expect(link.error).toContain('sin puerto')
  link.stop()
})

test('update mezcla la info y re-registra con el estado nuevo', async () => {
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

test('update serializa los register: nunca un estado viejo después de uno nuevo', async () => {
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

test('cola llena: se descarta primero un assistant_delta y si no hay, el más viejo', async () => {
  const f = fake()
  f.io.run = async () => ({ exitCode: 1, stdout: '', stderr: 'sin daemon' }) // nada se vacía
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

test('tras 30 s de attach sano el backoff vuelve a 1 s', async () => {
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

test('los chunks de stderr del attach se ignoran', async () => {
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

test('stop y start seguidos dejan un solo bucle de vaciado', async () => {
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

test('stop/start con un POST de eventos en vuelo: el siguiente espera a que termine', async () => {
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

test('versión del daemon distinta de la del mod: aviso en log y versionWarning', async () => {
  const f = fake()
  const logs: string[] = []
  f.io.log = m => { logs.push(m) }
  f.io.run = async () => ({ exitCode: 0, stdout: JSON.stringify({ ok: true, port: 4444, token: 'tok', machine: 'm1', version: '0.0.1' }) })
  const link = new Link(f.io)
  await link.start(INFO)
  expect(link.daemonVersion).toBe('0.0.1')
  expect(link.versionWarning).toContain('0.0.1')
  expect(logs.some(l => l.includes('no coincide'))).toBe(true)
  link.stop()
})

test('versión igual (o no informada): sin aviso', async () => {
  const f = fake()
  const link = new Link(f.io)
  await link.start(INFO)
  expect(link.versionWarning).toBe('')
  link.stop()
})
