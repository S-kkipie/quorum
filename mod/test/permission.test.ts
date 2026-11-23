import { expect, test } from 'claude-code/testing'

import { Asks } from '../src/control'
import { HOLD_MAX_MS, LATE_NOTICE, NO_TERMINAL_MS, permissionQuestion, permissionRace, type PermissionDeps } from '../src/permission'

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

/** Fakes: link que registra eventos, sleep a mano, reloj a mano, diálogo de la terminal a mano. */
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

test('gana el dispositivo (allow): sin ask_resolved del mod; la respuesta tardía de la terminal no cambia nada', async () => {
  const f = fake()
  const p = permissionRace(f.deps, f.a)
  await flush()
  expect(f.questions).toEqual(['Write: /x/hola.txt'])
  expect(f.evs[0]).toEqual({ kind: 'ask', data: { askId: 'a1', kind: 'permission', tool: 'Write', summary: '/x/hola.txt', detail: '{"file_path":"/x/hola.txt"}', questions: null } })
  expect(f.sleeps.map(s => s.ms)).toEqual([HOLD_MAX_MS])
  expect(f.held.length).toBe(1)
  f.asks.resolve('a1', { decision: 'allow' })
  expect(await p).toEqual({ decision: 'allow', reason: 'Permitido desde Quorum' })
  f.answer('Denegar')
  await flush()
  expect(f.resolved()).toEqual([])
  expect(f.logs).toEqual([LATE_NOTICE])
  expect(f.kinds()).toEqual(['ask', 'status', 'status'])
  expect(f.asks.pending).toEqual([])
  // el sostén se libera con la decisión
  let released = false
  void f.held[0].then(() => { released = true })
  await flush()
  expect(released).toBe(true)
})

test('el dispositivo deniega: con su motivo o el genérico', async () => {
  const f = fake()
  const p1 = permissionRace(f.deps, f.a)
  await flush()
  f.asks.resolve('a1', { decision: 'deny', reason: 'no toques eso' })
  expect(await p1).toEqual({ decision: 'deny', reason: 'no toques eso' })
  const p2 = permissionRace(f.deps, f.a)
  await flush()
  f.asks.resolve('a2', { decision: 'deny' })
  expect(await p2).toEqual({ decision: 'deny', reason: 'Denegado desde Quorum' })
})

test('la terminal responde Permitir primero → allow y ask_resolved{by:terminal}', async () => {
  const f = fake()
  const p = permissionRace(f.deps, f.a)
  await flush()
  f.answer('Permitir')
  expect(await p).toEqual({ decision: 'allow', reason: 'Permitido en la terminal' })
  expect(f.resolved()).toEqual([{ askId: 'a1', by: 'terminal' }])
  expect(f.asks.pending).toEqual([])
  // una decisión tardía del dispositivo ya no encuentra el ask
  expect(f.asks.resolve('a1', { decision: 'deny' })).toBe(false)
})

test('la terminal responde Denegar → deny', async () => {
  const f = fake()
  const p = permissionRace(f.deps, f.a)
  await flush()
  f.answer('Denegar')
  expect(await p).toEqual({ decision: 'deny', reason: 'Denegado en la terminal' })
  expect(f.resolved()).toEqual([{ askId: 'a1', by: 'terminal' }])
})

test('la terminal escribe otra cosa (Other) → deny con lo que escribió', async () => {
  const f = fake()
  const p = permissionRace(f.deps, f.a)
  await flush()
  f.answer('mejor en /tmp')
  expect(await p).toEqual({ decision: 'deny', reason: 'Denegado en la terminal: mejor en /tmp' })
})

test('el dueño cierra el diálogo (Esc) → la terminal deniega y retira la tarjeta', async () => {
  const f = fake()
  const p = permissionRace(f.deps, f.a)
  await flush()
  f.clock.t += NO_TERMINAL_MS
  f.dismiss()
  expect(await p).toEqual({ decision: 'deny', reason: 'Denegado en la terminal' })
  expect(f.resolved()).toEqual([{ askId: 'a1', by: 'terminal' }])
  expect(f.asks.pending).toEqual([])
})

test('respuesta que no es texto → deny sin romper nada', async () => {
  const f = fake()
  const p = permissionRace(f.deps, f.a)
  await flush()
  f.answer(undefined)
  expect(await p).toEqual({ decision: 'deny', reason: 'Denegado en la terminal' })
})

test('nadie responde en HOLD_MAX_MS → deny con motivo y ask_resolved{by:terminal}', async () => {
  const f = fake()
  const p = permissionRace(f.deps, f.a)
  await flush()
  f.sleeps[0].fire()
  expect(await p).toEqual({ decision: 'deny', reason: 'Sin respuesta en 19 min (Quorum)' })
  expect(f.resolved()).toEqual([{ askId: 'a1', by: 'terminal' }])
})

test('signal abortado (turno interrumpido) → retira el ask y deniega', async () => {
  const ac = new AbortController()
  const f = fake({ signal: ac.signal })
  const p = permissionRace(f.deps, f.a)
  await flush()
  ac.abort()
  expect(await p).toEqual({ decision: 'deny', reason: 'Turno interrumpido' })
  expect(f.kinds()).toEqual(['ask', 'status', 'ask_resolved', 'status'])
  expect(f.resolved()).toEqual([{ askId: 'a1', by: 'terminal' }])
  // la respuesta tardía de la terminal no emite nada más
  f.answer('Permitir')
  await flush()
  expect(f.resolved().length).toBe(1)
})

test('signal ya abortado → deniega sin preguntar', async () => {
  const ac = new AbortController()
  ac.abort()
  const f = fake({ signal: ac.signal })
  expect(await permissionRace(f.deps, f.a)).toEqual({ decision: 'deny', reason: 'Turno interrumpido' })
  expect(f.evs).toEqual([])
  expect(f.questions).toEqual([])
})

test('retirado desde fuera (fin de turno, cierre) → deny Turno interrumpido', async () => {
  const f = fake()
  const p = permissionRace(f.deps, f.a)
  await flush()
  f.asks.withdrawKind('permission')
  expect(await p).toEqual({ decision: 'deny', reason: 'Turno interrumpido' })
  expect(f.resolved()).toEqual([{ askId: 'a1', by: 'terminal' }])
})

test('termAsk que lanza al llamarse = sin terminal: sigue el dispositivo, sin excepción', async () => {
  const f = fake()
  f.deps.termAsk = () => { throw new Error('sin ui') }
  const p = permissionRace(f.deps, f.a)
  await flush()
  expect(f.asks.pending).toEqual(['a1'])
  f.asks.resolve('a1', { decision: 'allow' })
  expect(await p).toEqual({ decision: 'allow', reason: 'Permitido desde Quorum' })
})

test('sin terminal (sin termAsk): solo el dispositivo, hasta el tope', async () => {
  const f = fake()
  f.deps.termAsk = undefined
  const p = permissionRace(f.deps, f.a)
  await flush()
  expect(f.questions).toEqual([])
  expect(f.kinds()).toEqual(['ask', 'status'])
  expect(f.held.length).toBe(1)
  f.sleeps[0].fire()
  expect(await p).toEqual({ decision: 'deny', reason: 'Sin respuesta en 19 min (Quorum)' })
  expect(f.resolved()).toEqual([{ askId: 'a1', by: 'terminal' }])
})

test('$.ui.ask rechaza enseguida (< 500 ms, corrida -p) → no es Esc: espera al dispositivo', async () => {
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
  f.asks.resolve('a1', { decision: 'deny', reason: 'desde el móvil' })
  expect(await p).toEqual({ decision: 'deny', reason: 'desde el móvil' })
})

test('respuesta tardía tras vencer o retirarse: sin aviso de Quorum', async () => {
  const f = fake()
  const p = permissionRace(f.deps, f.a)
  await flush()
  f.asks.withdrawKind('permission')
  await p
  f.answer('Permitir')
  await flush()
  expect(f.logs).toEqual([])
})

test('dos carreras a la vez: askIds distintos; responder una retira solo esa; needs_you hasta la otra', async () => {
  const f = fake()
  const answers: Array<(s: string) => void> = []
  f.deps.termAsk = () => new Promise<string>(r => { answers.push(r) })
  const p1 = permissionRace(f.deps, f.a)
  const p2 = permissionRace(f.deps, { tool: 'Bash', summary: 'ls', detail: '' })
  await flush()
  expect(f.evs.filter(e => e.kind === 'ask').map(e => e.data.askId)).toEqual(['a1', 'a2'])
  answers[0]('Permitir')
  expect(await p1).toEqual({ decision: 'allow', reason: 'Permitido en la terminal' })
  expect(f.resolved()).toEqual([{ askId: 'a1', by: 'terminal' }])
  expect(f.asks.pending).toEqual(['a2'])
  const statuses = () => f.evs.filter(e => e.kind === 'status').map(e => e.data.state)
  expect(statuses()).toEqual(['needs_you', 'needs_you'])
  f.asks.resolve('a2', { decision: 'deny' })
  expect(await p2).toEqual({ decision: 'deny', reason: 'Denegado desde Quorum' })
  expect(statuses()).toEqual(['needs_you', 'needs_you', 'working'])
})

test('ask de un subagente: withdrawAgent retira solo los suyos', async () => {
  const f = fake()
  const p1 = permissionRace(f.deps, { ...f.a, agentId: 'ag1' })
  const p2 = permissionRace(f.deps, { ...f.a, agentId: 'ag2' })
  await flush()
  f.asks.withdrawAgent('ag1')
  expect(await p1).toEqual({ decision: 'deny', reason: 'Turno interrumpido' })
  expect(f.asks.pending).toEqual(['a2'])
  f.asks.resolve('a2', { decision: 'allow' })
  expect(await p2).toEqual({ decision: 'allow', reason: 'Permitido desde Quorum' })
})

test('pregunta de la terminal: "<tool>: <summary>" hasta 120 caracteres', () => {
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
