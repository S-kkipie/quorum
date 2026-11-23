import { describe, it, expect } from 'vitest'
import { reduce, replaceSessions, seed, initialState, type AppState } from './store'
import type { Envelope, SessionInfo, Event } from '../proto.gen'

const sess = (id: string, o: Partial<SessionInfo> = {}): SessionInfo => ({
  id, recap: '', previousId: '', machine: 'm1', name: id, cwd: '/x', root: '/x', model: '', role: 'work',
  state: 'idle', contextPct: 0, startedAt: 1, updatedAt: 1, transcriptPath: '', repoUrl: '', branch: '', projectId: '', launchReq: '', herdrPane: '', herdrWorkspace: '', ...o,
})
const up = (s: SessionInfo): Envelope => ({ type: 'session_upsert', machine: s.machine, session: s.id, payload: s })
const ev = (session: string, seq: number, kind: string, data: any = {}): Envelope => {
  const e: Event = { seq, session, ts: seq, kind, data }
  return { type: 'event', machine: 'm1', session, payload: e }
}
const run = (envs: Envelope[], s: AppState = initialState()) => envs.reduce(reduce, s)

describe('reduce', () => {
  it('concatena deltas y los vacia con assistant', () => {
    let s = run([ev('a', 1, 'assistant_delta', { text: 'Ho' }), ev('a', 2, 'assistant_delta', { text: 'la' })])
    expect(s.live['a']).toBe('Hola')
    s = run([ev('a', 3, 'assistant', { text: 'Hola' })], s)
    expect(s.live['a']).toBeUndefined()
    expect(s.events['a'].map((e) => e.kind)).toEqual(['assistant'])
  })
  it('deltas de subagente no van al texto principal', () => {
    const s = run([ev('a', 1, 'assistant_delta', { agent: 'g1', text: 'x' })])
    expect(s.live['a']).toBeUndefined()
    expect(s.liveAgent['a']['g1']).toBe('x')
  })
  it('ask y ask_resolved', () => {
    let s = run([ev('a', 1, 'ask', { askId: 'k1', kind: 'permission', tool: 'Bash', summary: 'ls', detail: '', questions: null })])
    expect(s.asks['k1'].tool).toBe('Bash')
    s = run([ev('a', 2, 'ask_resolved', { askId: 'k1', by: 'terminal' })], s)
    expect(s.asks['k1']).toBeUndefined()
  })
  it('cambio de estado no altera order', () => {
    let s = run([up(sess('a')), up(sess('b')), up(sess('c'))])
    s = run([up(sess('a', { state: 'working', updatedAt: 9 }))], s)
    expect(s.order).toEqual(['a', 'b', 'c'])
    expect(s.sessions['a'].state).toBe('working')
  })
  it('previousId conserva posicion y mueve eventos', () => {
    let s = run([up(sess('a')), up(sess('b')), up(sess('c')), ev('b', 1, 'user', { text: 'hi' })])
    s = run([up(sess('b2', { previousId: 'b' }))], s)
    expect(s.order).toEqual(['a', 'b2', 'c'])
    expect(s.sessions['b']).toBeUndefined()
    expect(s.events['b2'].length).toBe(1)
    expect(s.events['b']).toBeUndefined()
  })
  it('ordena por seq (negativos incluidos) y deduplica', () => {
    const s = run([ev('a', 5, 'user'), ev('a', -2, 'user'), ev('a', 1, 'user'), ev('a', 5, 'user'), ev('a', -2, 'user')])
    expect(s.events['a'].map((e) => e.seq)).toEqual([-2, 1, 5])
  })
  it('session_gone marca closed sin borrar', () => {
    const s = run([up(sess('a', { state: 'working' })), { type: 'session_gone', machine: 'm1', session: 'a', payload: null }])
    expect(s.sessions['a'].state).toBe('closed')
    expect(s.order).toEqual(['a'])
  })
  it('machine_status y tipos desconocidos', () => {
    let s = run([{ type: 'machine_status', machine: 'm1', session: '', payload: { name: 'm1', os: 'linux', env: 'linux', version: '1', online: true, lastSeen: 1 } }])
    expect(s.machines['m1'].online).toBe(true)
    const s2 = run([{ type: 'wat', machine: '', session: '', payload: null }], s)
    expect(s2).toBe(s)
  })
  it('previousId con el id nuevo ya en order no duplica', () => {
    // /resume de b2 (cerrada) desde b
    let s = run([up(sess('a')), up(sess('b')), up(sess('b2', { state: 'closed' }))])
    s = run([up(sess('b2', { previousId: 'b' }))], s)
    expect(s.order).toEqual(['a', 'b2'])
  })
  it('agent_end limpia liveAgent', () => {
    let s = run([ev('a', 1, 'assistant_delta', { agent: 'g1', text: 'x' })])
    s = run([ev('a', 2, 'agent_end', { id: 'g1', status: 'ok', answer: '' })], s)
    expect(s.liveAgent['a']['g1']).toBeUndefined()
  })
  it('seed no pisa estado fresco ni resucita ids reemplazados', () => {
    let s = run([up(sess('a', { state: 'needs_you' })), up(sess('b')), up(sess('b2', { previousId: 'b' }))])
    s = seed(s, [], [sess('a', { state: 'idle' }), sess('b'), sess('c')])
    expect(s.sessions['a'].state).toBe('needs_you')
    expect(s.sessions['b']).toBeUndefined()
    expect(s.order).toEqual(['a', 'b2', 'c'])
  })
  it('seed inserta máquinas faltantes sin pisar', () => {
    const m = (online: boolean) => ({ name: 'm1', os: '', env: '', version: '', online, lastSeen: 1, caps: { herdr: false, terminal: false, root: false } })
    const s = seed(run([{ type: 'machine_status', machine: 'm1', session: '', payload: m(true) }]), [m(false)], [])
    expect(s.machines['m1'].online).toBe(true)
  })
})

describe('replacedBy y asks por sesión', () => {
  it('registra prev -> nuevo y mueve los asks', () => {
    let s = initialState()
    const info = (id: string, previousId = ''): any => ({ id, previousId, machine: 'm', state: 'idle' })
    s = reduce(s, { type: 'session_upsert', payload: info('a') } as any)
    s = reduce(s, { type: 'event', payload: { seq: 1, session: 'a', ts: 0, kind: 'ask', data: { askId: 'k', kind: 'permission' } } } as any)
    expect(s.asks.k.session).toBe('a')
    s = reduce(s, { type: 'session_upsert', payload: info('b', 'a') } as any)
    expect(s.replacedBy.a).toBe('b')
    expect(s.asks.k.session).toBe('b')
  })
})

describe('revisión final', () => {
  it('assistant de un subagente no limpia el texto en vivo principal', () => {
    let s = run([ev('a', 1, 'assistant_delta', { text: 'Ho' })])
    s = run([ev('a', 2, 'assistant', { agent: 'g1', text: 'fin del subagente' })], s)
    expect(s.live['a']).toBe('Ho')
    s = run([ev('a', 3, 'assistant', { text: 'Hola' })], s)
    expect(s.live['a']).toBeUndefined()
  })
  it('envelope events agrega el lote ordenado', () => {
    const batch: Event[] = [-2, -1].map((seq) => ({ seq, session: 'a', ts: 0, kind: 'user', data: { text: String(seq) } }))
    let s = run([ev('a', 1, 'user')])
    s = reduce(s, { type: 'events', machine: 'm1', session: 'a', payload: batch })
    expect(s.events['a'].map((e) => e.seq)).toEqual([-2, -1, 1])
  })
  it('un envelope away (de un hub viejo) se ignora', () => {
    const s0 = initialState()
    expect(reduce(s0, { type: 'away', machine: '', session: '', payload: { a: true } })).toBe(s0)
    expect('away' in s0).toBe(false)
  })
  it('previousId desconocido igual registra el reemplazo', () => {
    const s = run([up(sess('b2', { previousId: 'b' }))])
    expect(s.replacedBy['b']).toBe('b2')
    expect(s.replaced['b']).toBe(true)
    expect(s.order).toEqual(['b2'])
    expect(seed(s, [], [sess('b')]).sessions['b']).toBeUndefined()
  })
  it('replaceSessions pisa, quita lo que ya no está, sigue renombres y conserva eventos', () => {
    let s = run([up(sess('a', { state: 'working' })), up(sess('b')), up(sess('c')), ev('b', 1, 'user', { text: 'hi' }), ev('c', 1, 'user')])
    const m = { name: 'm1', os: '', env: '', version: '', online: false, lastSeen: 1, caps: { herdr: false, terminal: false, root: false } }
    s = replaceSessions(s, [m], [sess('a', { state: 'idle' }), sess('b2', { previousId: 'b' })])
    expect(s.order).toEqual(['a', 'b2'])
    expect(s.sessions['a'].state).toBe('idle')
    expect(s.sessions['b']).toBeUndefined()
    expect(s.sessions['c']).toBeUndefined()
    expect(s.replacedBy['b']).toBe('b2')
    expect(s.events['b2'].length).toBe(1)
    expect(s.events['c'].length).toBe(1)
    expect(s.machines['m1'].online).toBe(false)
  })
})

describe('Ruling Q: el id viejo vuelve (resume tras /clear)', () => {
  it('A reaparece: deja de estar reemplazada, sin redirección ni ciclo', () => {
    let s = run([up(sess('a')), up(sess('b', { previousId: 'a' }))])
    expect(s.replacedBy['a']).toBe('b')
    s = run([up(sess('a'))], s) // claude --resume a
    expect(s.replaced['a']).toBeUndefined()
    expect(s.replacedBy['a']).toBeUndefined()
    expect(Object.keys(s.sessions).sort()).toEqual(['a', 'b'])
    expect(s.order).toEqual(['b', 'a'])
    // un upsert viejo de b con previousId=a no se aplica: a sigue viva
    s = run([up(sess('b', { previousId: 'a', state: 'working' })), ev('a', 1, 'user', { text: 'x' })], s)
    expect(s.sessions['a']).toBeDefined()
    expect(s.sessions['b'].previousId).toBe('')
    expect(s.replacedBy['a']).toBeUndefined()
    expect(s.events['a'].length).toBe(1)
    expect(seed(s, [], [sess('a')]).sessions['a']).toBeDefined()
  })
  it('A→B y luego B→A no deja un ciclo en replacedBy', () => {
    let s = run([up(sess('a')), up(sess('b', { previousId: 'a' }))])
    s = run([up(sess('a', { previousId: 'b' }))], s) // /resume a desde b
    expect(s.replacedBy['a']).toBeUndefined()
    expect(s.replacedBy['b']).toBe('a')
    expect(s.sessions['b']).toBeUndefined()
    expect(s.order).toEqual(['a'])
  })
  it('replaceSessions ignora un previousId que también está en la lista', () => {
    const s = replaceSessions(run([up(sess('a')), up(sess('b'))]), [], [sess('b', { previousId: 'a' }), sess('a')])
    expect(Object.keys(s.sessions).sort()).toEqual(['a', 'b'])
    expect(s.replacedBy['a']).toBeUndefined()
  })
})

describe('arreglos menores', () => {
  it('el backfill no duplica lo que ya llegó en vivo', () => {
    const e = (seq: number, ts: number, kind: string, text: string): Event => ({ seq, session: 'a', ts, kind, data: { text } })
    let s = reduce(initialState(), { type: 'event', machine: 'm1', session: 'a', payload: e(1, 10_000, 'user', 'hola') })
    s = reduce(s, { type: 'event', machine: 'm1', session: 'a', payload: e(2, 11_000, 'assistant', 'qué tal') })
    const backfill = [e(-4, 1_000, 'user', 'antes'), e(-3, 9_000, 'user', 'hola'), e(-2, 10_500, 'user', 'hola'), e(-1, 11_000, 'assistant', 'qué tal')]
    s = reduce(s, { type: 'events', machine: 'm1', session: 'a', payload: backfill })
    expect(s.events['a'].map((x) => x.seq)).toEqual([-4, 1, 2])
  })
})
