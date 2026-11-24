import { describe, it, expect } from 'vitest'
import { markSeen, reduce, replaceSessions, setUsage, setCommands, loadCommands, seed, initialState, setConversations, type AppState } from './store'
import type { AccountUsage, Envelope, SessionCommands, SessionInfo, Event } from '../proto.gen'

const sess = (id: string, o: Partial<SessionInfo> = {}): SessionInfo => ({
  id, recap: '', previousId: '', machine: 'm1', name: id, cwd: '/x', root: '/x', model: '', role: 'work',
  state: 'idle', contextPct: 0, startedAt: 1, updatedAt: 1, transcriptPath: '', repoUrl: '', branch: '', projectId: '', launchReq: '', herdrPane: '', herdrWorkspace: '', account: '', accountKey: '', configDir: '', plugins: [], contextEstimate: false, tokens: { in: 0, out: 0, cache: 0 }, rateLimits: [], usageAt: 0, imagesDir: '', background: { tasks: 0, wakeAt: 0 }, unread: false, effort: '', modelOptions: [], effortOptions: [], ...o,
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

describe('usage', () => {
  const u = (key: string, pct: number, at: number): AccountUsage => ({ key, alias: 'work', fiveHour: { pct, resetsAt: '' }, sevenDay: { pct: 0, resetsAt: '' }, at })
  const env = (p: AccountUsage): Envelope => ({ type: 'usage_upsert', machine: 'vps-1', session: '', payload: p })
  it('usage_upsert stores per key and keeps the newest', () => {
    let s = run([env(u('a', 10, 100)), env(u('b', 5, 100))])
    expect(Object.keys(s.usage).sort()).toEqual(['a', 'b'])
    s = run([env(u('a', 20, 200))], s)
    expect(s.usage.a.fiveHour.pct).toBe(20)
    s = run([env(u('a', 1, 150))], s)
    expect(s.usage.a.fiveHour.pct).toBe(20)
  })
  it('usage_gone removes the key', () => {
    let s = run([env(u('vps-1/work', 10, 100)), env(u('abcd', 10, 100))])
    s = run([{ type: 'usage_gone', machine: 'vps-1', session: '', payload: { key: 'vps-1/work' } }], s)
    expect(Object.keys(s.usage)).toEqual(['abcd'])
  })
  it('the REST load seeds without overwriting newer live data and replace drops absent keys', () => {
    let s = run([env(u('a', 20, 200))])
    s = setUsage(s, [u('a', 10, 100), u('b', 5, 100)])
    expect(s.usage.a.fiveHour.pct).toBe(20)
    expect(s.usage.b).toBeDefined()
    s = setUsage(s, [u('b', 6, 300)], true)
    expect(Object.keys(s.usage)).toEqual(['b'])
  })
})

describe('attention and unread', () => {
  const att = (session: string, kind: string, at: number): Envelope => ({ type: 'attention', machine: 'm1', session, payload: { session, kind, at } })
  it('keeps the last attention per session', () => {
    let s = run([up(sess('a')), att('a', 'needs_you', 10)])
    expect(s.lastAttention['a']).toEqual({ kind: 'needs_you', at: 10 })
    s = run([att('a', 'done', 20), att('b', 'done', 5)], s)
    expect(s.lastAttention).toEqual({ a: { kind: 'done', at: 20 }, b: { kind: 'done', at: 5 } })
  })
  it('ignores malformed attentions', () => {
    const s0 = initialState()
    expect(run([{ type: 'attention', machine: 'm1', session: '', payload: null }], s0)).toBe(s0)
    expect(run([{ type: 'attention', machine: 'm1', session: 'a', payload: { session: 'a', kind: 'other', at: 1 } }], s0)).toBe(s0)
  })
  it('unread follows the hub upserts and a closed session is never unread', () => {
    let s = run([up(sess('a', { unread: true }))])
    expect(s.sessions['a'].unread).toBe(true)
    s = run([up(sess('a', { unread: false }))], s)
    expect(s.sessions['a'].unread).toBe(false)
    s = run([up(sess('a', { unread: true })), { type: 'session_gone', machine: 'm1', session: 'a', payload: null }], s)
    expect(s.sessions['a'].state).toBe('closed')
    expect(s.sessions['a'].unread).toBe(false)
  })
  it('session_removed drops its last attention', () => {
    let s = run([up(sess('a')), att('a', 'done', 1)])
    s = run([{ type: 'session_removed', machine: 'm1', session: 'a', payload: null }], s)
    expect(s.lastAttention['a']).toBeUndefined()
  })
})

describe('markSeen', () => {
  it('clears unread locally and leaves others alone', () => {
    const s0 = reduce(initialState(), up(sess('a', { state: 'idle', unread: true })))
    const s1 = markSeen(s0, 'a')
    expect(s1.sessions.a.unread).toBe(false)
    expect(markSeen(s1, 'a')).toBe(s1)
    expect(markSeen(s1, 'zz')).toBe(s1)
  })
})

describe('session commands', () => {
  const sc = (hash: string, names: string[] = ['clear']): SessionCommands => ({
    session: 's1', hash, commands: names.map((name) => ({ name, description: '', source: 'builtin', plugin: '', group: 'session', terminalOnly: false })),
  })
  const env = (p: SessionCommands): Envelope => ({ type: 'session_commands', machine: 'vps-1', session: p.session, payload: p })
  it('session_commands stores the list per session', () => {
    const s = run([env(sc('h1', ['clear', 'compact']))])
    expect(s.commands.s1.commands.map((c) => c.name)).toEqual(['clear', 'compact'])
  })
  it('a new hash replaces the list, the same hash keeps the state object', () => {
    const a = run([env(sc('h1'))])
    expect(run([env(sc("h1"))], a).commands).toBe(a.commands)
    expect(run([env(sc('h2', ['a', 'b']))], a).commands.s1.commands).toHaveLength(2)
  })
  it('a GET that started before a live envelope does not overwrite it', () => {
    const rev = initialState().commandsRev.s1 // read before the request
    let s = run([env(sc('h2', ['new']))])
    s = loadCommands(s, sc('h1', ['old']), rev)
    expect(s.commands.s1.hash).toBe('h2')
    // with no live envelope meanwhile the GET result is stored
    const s2 = loadCommands(initialState(), sc('h1', ['old']), undefined)
    expect(s2.commands.s1.hash).toBe('h1')
    // a revision read after the envelope is current
    expect(loadCommands(s, sc('h3'), s.commandsRev.s1).commands.s1.hash).toBe('h3')
  })
  it('ignores malformed payloads; an empty list is kept', () => {
    const s0 = initialState()
    expect(reduce(s0, { type: 'session_commands', machine: 'm', session: 's1', payload: null as any })).toBe(s0)
    expect(setCommands(s0, { session: 's1', hash: '', commands: null as any })).toBe(s0)
    expect(setCommands(s0, sc('', [])).commands.s1.commands).toEqual([])
  })
  it('session_removed drops it', () => {
    let s = run([env(sc('h1'))])
    s = run([{ type: 'session_removed', machine: 'vps-1', session: 's1', payload: null as any }], s)
    expect(s.commands.s1).toBeUndefined()
  })
})

describe('addEvents asks', () => {
  const evt = (seq: number, kind: string, data: any): Event => ({ seq, session: 'a', ts: seq, kind, data })
  const askData = (askId: string) => ({ askId, kind: 'permission', tool: 'Bash', summary: 'ls', detail: '', questions: null })
  it('history with an unresolved ask populates asks', () => {
    const s = run([{ type: 'events', machine: 'm1', session: 'a', payload: [evt(1, 'user', { text: 'x' }), evt(2, 'ask', askData('k1'))] }])
    expect(s.asks['k1']).toMatchObject({ askId: 'k1', session: 'a' })
  })
  it('history ask followed by ask_resolved is not an open ask', () => {
    const s = run([{ type: 'events', machine: 'm1', session: 'a', payload: [evt(2, 'ask', askData('k1')), evt(3, 'ask_resolved', { askId: 'k1' })] }])
    expect(s.asks['k1']).toBeUndefined()
  })
  it('history ask_resolved removes an ask already in state', () => {
    let s = run([ev('a', 2, 'ask', askData('k1'))])
    s = run([{ type: 'events', machine: 'm1', session: 'a', payload: [evt(3, 'ask_resolved', { askId: 'k1' })] }], s)
    expect(s.asks['k1']).toBeUndefined()
  })
  it('does not resurrect an ask already resolved in state', () => {
    let s = run([ev('a', 2, 'ask', askData('k1')), ev('a', 3, 'ask_resolved', { askId: 'k1' })])
    s = run([{ type: 'events', machine: 'm1', session: 'a', payload: [evt(2, 'ask', askData('k1'))] }], s)
    expect(s.asks['k1']).toBeUndefined()
  })
})
