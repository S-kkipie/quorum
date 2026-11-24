import { describe, it, expect } from 'vitest'
import { reduce, replaceSessions, seed, initialState, setConversations, type AppState } from './store'
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
  it('concatenates deltas and clears them on assistant', () => {
    let s = run([ev('a', 1, 'assistant_delta', { text: 'Hel' }), ev('a', 2, 'assistant_delta', { text: 'lo' })])
    expect(s.live['a']).toBe('Hello')
    s = run([ev('a', 3, 'assistant', { text: 'Hello' })], s)
    expect(s.live['a']).toBeUndefined()
    expect(s.events['a'].map((e) => e.kind)).toEqual(['assistant'])
  })
  it('subagent deltas do not go to the main text', () => {
    const s = run([ev('a', 1, 'assistant_delta', { agent: 'g1', text: 'x' })])
    expect(s.live['a']).toBeUndefined()
    expect(s.liveAgent['a']['g1']).toBe('x')
  })
  it('ask and ask_resolved', () => {
    let s = run([ev('a', 1, 'ask', { askId: 'k1', kind: 'permission', tool: 'Bash', summary: 'ls', detail: '', questions: null })])
    expect(s.asks['k1'].tool).toBe('Bash')
    s = run([ev('a', 2, 'ask_resolved', { askId: 'k1', by: 'terminal' })], s)
    expect(s.asks['k1']).toBeUndefined()
  })
  it('state change does not alter order', () => {
    let s = run([up(sess('a')), up(sess('b')), up(sess('c'))])
    s = run([up(sess('a', { state: 'working', updatedAt: 9 }))], s)
    expect(s.order).toEqual(['a', 'b', 'c'])
    expect(s.sessions['a'].state).toBe('working')
  })
  it('previousId keeps position and moves events', () => {
    let s = run([up(sess('a')), up(sess('b')), up(sess('c')), ev('b', 1, 'user', { text: 'hi' })])
    s = run([up(sess('b2', { previousId: 'b' }))], s)
    expect(s.order).toEqual(['a', 'b2', 'c'])
    expect(s.sessions['b']).toBeUndefined()
    expect(s.events['b2'].length).toBe(1)
    expect(s.events['b']).toBeUndefined()
  })
  it('sorts by seq (negatives included) and deduplicates', () => {
    const s = run([ev('a', 5, 'user'), ev('a', -2, 'user'), ev('a', 1, 'user'), ev('a', 5, 'user'), ev('a', -2, 'user')])
    expect(s.events['a'].map((e) => e.seq)).toEqual([-2, 1, 5])
  })
  it('session_gone marks closed without deleting', () => {
    const s = run([up(sess('a', { state: 'working' })), { type: 'session_gone', machine: 'm1', session: 'a', payload: null }])
    expect(s.sessions['a'].state).toBe('closed')
    expect(s.order).toEqual(['a'])
  })
  it('session_removed deletes the session everywhere and leaves others intact', () => {
    let s = run([up(sess('a', { state: 'working' })), up(sess('b')), ev('a', 1, 'status'), ev('b', 1, 'user', { text: 'hi' })])
    s = {
      ...s,
      live: { a: 'x', b: 'y' },
      liveAgent: { a: { g: 'x' }, b: { g: 'y' } },
      asks: { k1: { session: 'a' } as never, k2: { session: 'b' } as never },
      replaced: { a: true },
      replacedBy: { a: 'z' },
    }
    s = run([{ type: 'session_removed', machine: 'm1', session: 'a', payload: null }], s)
    expect(s.sessions['a']).toBeUndefined()
    expect(s.order).toEqual(['b'])
    expect(s.events['a']).toBeUndefined()
    expect(s.live).toEqual({ b: 'y' })
    expect(s.liveAgent).toEqual({ b: { g: 'y' } })
    expect(Object.keys(s.asks)).toEqual(['k2'])
    expect(s.worked['a']).toBeUndefined()
    expect(s.replaced['a']).toBeUndefined()
    expect(s.replacedBy['a']).toBeUndefined()
    expect(s.sessions['b']).toBeDefined()
    expect(s.events['b'].length).toBe(1)
  })
  it('machine_status and unknown types', () => {
    let s = run([{ type: 'machine_status', machine: 'm1', session: '', payload: { name: 'm1', os: 'linux', env: 'linux', version: '1', online: true, lastSeen: 1 } }])
    expect(s.machines['m1'].online).toBe(true)
    const s2 = run([{ type: 'wat', machine: '', session: '', payload: null }], s)
    expect(s2).toBe(s)
  })
  it('previousId with the new id already in order does not duplicate', () => {
    // /resume of b2 (closed) from b
    let s = run([up(sess('a')), up(sess('b')), up(sess('b2', { state: 'closed' }))])
    s = run([up(sess('b2', { previousId: 'b' }))], s)
    expect(s.order).toEqual(['a', 'b2'])
  })
  it('agent_end clears liveAgent', () => {
    let s = run([ev('a', 1, 'assistant_delta', { agent: 'g1', text: 'x' })])
    s = run([ev('a', 2, 'agent_end', { id: 'g1', status: 'ok', answer: '' })], s)
    expect(s.liveAgent['a']['g1']).toBeUndefined()
  })
  it('seed does not overwrite fresh state nor resurrect replaced ids', () => {
    let s = run([up(sess('a', { state: 'needs_you' })), up(sess('b')), up(sess('b2', { previousId: 'b' }))])
    s = seed(s, [], [sess('a', { state: 'idle' }), sess('b'), sess('c')])
    expect(s.sessions['a'].state).toBe('needs_you')
    expect(s.sessions['b']).toBeUndefined()
    expect(s.order).toEqual(['a', 'b2', 'c'])
  })
  it('seed inserts missing machines without overwriting', () => {
    const m = (online: boolean) => ({ name: 'm1', os: '', env: '', version: '', online, lastSeen: 1, caps: { herdr: false, terminal: false, root: false } })
    const s = seed(run([{ type: 'machine_status', machine: 'm1', session: '', payload: m(true) }]), [m(false)], [])
    expect(s.machines['m1'].online).toBe(true)
  })
})

describe('replacedBy and asks per session', () => {
  it('records prev -> new and moves the asks', () => {
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

describe('final review', () => {
  it('a subagent\'s assistant does not clear the main live text', () => {
    let s = run([ev('a', 1, 'assistant_delta', { text: 'He' })])
    s = run([ev('a', 2, 'assistant', { agent: 'g1', text: 'subagent done' })], s)
    expect(s.live['a']).toBe('He')
    s = run([ev('a', 3, 'assistant', { text: 'Hello' })], s)
    expect(s.live['a']).toBeUndefined()
  })
  it('events envelope adds the sorted batch', () => {
    const batch: Event[] = [-2, -1].map((seq) => ({ seq, session: 'a', ts: 0, kind: 'user', data: { text: String(seq) } }))
    let s = run([ev('a', 1, 'user')])
    s = reduce(s, { type: 'events', machine: 'm1', session: 'a', payload: batch })
    expect(s.events['a'].map((e) => e.seq)).toEqual([-2, -1, 1])
  })
  it('an away envelope (from an old hub) is ignored', () => {
    const s0 = initialState()
    expect(reduce(s0, { type: 'away', machine: '', session: '', payload: { a: true } })).toBe(s0)
    expect('away' in s0).toBe(false)
  })
  it('unknown previousId still records the replacement', () => {
    const s = run([up(sess('b2', { previousId: 'b' }))])
    expect(s.replacedBy['b']).toBe('b2')
    expect(s.replaced['b']).toBe(true)
    expect(s.order).toEqual(['b2'])
    expect(seed(s, [], [sess('b')]).sessions['b']).toBeUndefined()
  })
  it('replaceSessions overwrites, removes what is gone, follows renames and keeps events', () => {
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

describe('Ruling Q: the old id comes back (resume after /clear)', () => {
  it('A reappears: stops being replaced, with no redirect or cycle', () => {
    let s = run([up(sess('a')), up(sess('b', { previousId: 'a' }))])
    expect(s.replacedBy['a']).toBe('b')
    s = run([up(sess('a'))], s) // claude --resume a
    expect(s.replaced['a']).toBeUndefined()
    expect(s.replacedBy['a']).toBeUndefined()
    expect(Object.keys(s.sessions).sort()).toEqual(['a', 'b'])
    expect(s.order).toEqual(['b', 'a'])
    // an old upsert of b with previousId=a is not applied: a is still alive
    s = run([up(sess('b', { previousId: 'a', state: 'working' })), ev('a', 1, 'user', { text: 'x' })], s)
    expect(s.sessions['a']).toBeDefined()
    expect(s.sessions['b'].previousId).toBe('')
    expect(s.replacedBy['a']).toBeUndefined()
    expect(s.events['a'].length).toBe(1)
    expect(seed(s, [], [sess('a')]).sessions['a']).toBeDefined()
  })
  it('A→B then B→A leaves no cycle in replacedBy', () => {
    let s = run([up(sess('a')), up(sess('b', { previousId: 'a' }))])
    s = run([up(sess('a', { previousId: 'b' }))], s) // /resume a from b
    expect(s.replacedBy['a']).toBeUndefined()
    expect(s.replacedBy['b']).toBe('a')
    expect(s.sessions['b']).toBeUndefined()
    expect(s.order).toEqual(['a'])
  })
  it('replaceSessions ignores a previousId that is also in the list', () => {
    const s = replaceSessions(run([up(sess('a')), up(sess('b'))]), [], [sess('b', { previousId: 'a' }), sess('a')])
    expect(Object.keys(s.sessions).sort()).toEqual(['a', 'b'])
    expect(s.replacedBy['a']).toBeUndefined()
  })
})

describe('minor fixes', () => {
  it('backfill does not duplicate what already arrived live', () => {
    const e = (seq: number, ts: number, kind: string, text: string): Event => ({ seq, session: 'a', ts, kind, data: { text } })
    let s = reduce(initialState(), { type: 'event', machine: 'm1', session: 'a', payload: e(1, 10_000, 'user', 'hello') })
    s = reduce(s, { type: 'event', machine: 'm1', session: 'a', payload: e(2, 11_000, 'assistant', 'how are you') })
    const backfill = [e(-4, 1_000, 'user', 'before'), e(-3, 9_000, 'user', 'hello'), e(-2, 10_500, 'user', 'hello'), e(-1, 11_000, 'assistant', 'how are you')]
    s = reduce(s, { type: 'events', machine: 'm1', session: 'a', payload: backfill })
    expect(s.events['a'].map((x) => x.seq)).toEqual([-4, 1, 2])
  })
})

describe('setConversations', () => {
  it('stores under the composed key and leaves others alone', () => {
    const c = (id: string) => ({ id, title: '', firstPrompt: '', messages: 1, updatedAt: 1, open: false })
    let s = setConversations(initialState(), 'vps-1', '/w/app', [c('a')])
    s = setConversations(s, 'laptop', '/w/app', [c('b')])
    expect(Object.keys(s.conversations).sort()).toEqual(['laptop\u0000/w/app', 'vps-1\u0000/w/app'])
    s = setConversations(s, 'vps-1', '/w/app', [])
    expect(s.conversations['vps-1\u0000/w/app']).toEqual([])
    expect(s.conversations['laptop\u0000/w/app']).toHaveLength(1)
  })
})
