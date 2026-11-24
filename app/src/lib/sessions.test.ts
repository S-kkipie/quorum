import { describe, it, expect } from 'vitest'
import { mergeSessions, lastActivity, displayState, attentionCount, stateDetail, stateText, nextWake, ATTENTION } from './sessions'
import { initialState, setConversations, reduce } from './store'
import type { Conversation, SessionInfo, Envelope } from '../proto.gen'

const sess = (id: string, o: Partial<SessionInfo> = {}): SessionInfo => ({
  id, recap: '', previousId: '', machine: 'vps-1', name: id, cwd: '/w/app', root: '/w/app', model: '', role: 'work',
  state: 'idle', contextPct: 0, startedAt: 1, updatedAt: 1, transcriptPath: '', repoUrl: '', branch: '', projectId: '', launchReq: '', herdrPane: '', herdrWorkspace: '', account: '', accountKey: '', configDir: '', plugins: [], contextEstimate: false, tokens: { in: 0, out: 0, cache: 0 }, rateLimits: [], usageAt: 0, imagesDir: '', background: { tasks: 0, wakeAt: 0 }, unread: false, effort: '', modelOptions: [], effortOptions: [], ...o,
})
const conv = (id: string, o: Partial<Conversation> = {}): Conversation => ({ id, title: '', firstPrompt: '', messages: 1, updatedAt: 1, open: false, ...o })

describe('mergeSessions with closed sessions', () => {
  it('adds a closed session the app knows but no list has yet', () => {
    const rows = mergeSessions([], [], [sess('z', { state: 'closed', name: 'quick', updatedAt: 500 })])
    expect(rows).toEqual([{ kind: 'closed', id: 'z', machine: 'vps-1', root: '/w/app', title: 'quick', updatedAt: 500000, messages: 0 }])
  })
  it('a listed conversation wins for title and messages; newest updatedAt wins', () => {
    const rows = mergeSessions([], [{ machine: 'vps-1', root: '/w/app', list: [conv('z', { title: 'Listed', messages: 7, updatedAt: 100 })] }],
      [sess('z', { state: 'closed', name: 'quick', updatedAt: 500 })])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ title: 'Listed', messages: 7, updatedAt: 500000 })
  })
  it('a live session hides its closed twin', () => {
    expect(mergeSessions([sess('z')], [], [sess('z', { state: 'closed' })])).toHaveLength(1)
  })
})

describe('mergeSessions', () => {
  it('live wins over listed', () => {
    const rows = mergeSessions([sess('a')], [{ machine: 'laptop', root: '/w/app', list: [conv('a', { open: false })] }])
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('live')
  })
  it('closed listed twice keeps the newest', () => {
    const rows = mergeSessions([], [
      { machine: 'vps-1', root: '/w/app', list: [conv('b', { updatedAt: 100 })] },
      { machine: 'laptop', root: '/w/app', list: [conv('b', { updatedAt: 200 })] },
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'closed', updatedAt: 200000, machine: 'laptop' })
  })
  it('order', () => {
    const live = [sess('i', { state: 'idle' }), sess('w1', { state: 'working' }), sess('n', { state: 'needs_you' }), sess('w2', { state: 'working' }), sess('q', { state: 'waiting' }), sess('d', { state: 'idle', unread: true }), sess('b', { state: 'background' })]
    const rows = mergeSessions(live, [{ machine: 'vps-1', root: '/w/app', list: [conv('c1', { updatedAt: 5 }), conv('c2', { updatedAt: 9 })] }])
    expect(rows.map((r) => r.id)).toEqual(['n', 'd', 'w1', 'w2', 'b', 'i', 'q', 'c2', 'c1'])
  })
  it('title fallback', () => {
    const rows = mergeSessions([], [{ machine: 'vps-1', root: '/r', list: [
      conv('t', { title: 'T', firstPrompt: 'P', updatedAt: 3 }), conv('p', { firstPrompt: 'P', updatedAt: 2 }), conv('z', { updatedAt: 1 }),
    ] }])
    expect(rows.map((r) => r.kind === 'closed' && r.title)).toEqual(['T', 'P', 'z'])
  })
  it('open but not live', () => {
    const rows = mergeSessions([], [{ machine: 'vps-1', root: '/r', list: [conv('o', { open: true })] }])
    expect(rows[0].kind).toBe('closed')
  })
})

describe('lastActivity', () => {
  it('is 0 when nothing is known', () => {
    expect(lastActivity(initialState(), 'p1')).toBe(0)
  })
  it('is the max of live sessions and cached conversations', () => {
    const up = (s: SessionInfo): Envelope => ({ type: 'session_upsert', machine: s.machine, session: s.id, payload: s })
    let s = reduce(initialState(), up(sess('a', { projectId: 'p1', updatedAt: 1_700_000_000 })))
    expect(lastActivity(s, 'p1')).toBe(1_700_000_000_000)
    s = setConversations(s, 'vps-1', '/w/app', [conv('x', { updatedAt: 1_800_000_000_000 }), conv('y', { updatedAt: 5 })])
    s = setConversations(s, 'laptop', '/other', [conv('z', { updatedAt: 1_900_000_000_000 })])
    expect(lastActivity(s, 'p1')).toBe(1_800_000_000_000)
  })
})

describe('displayState and labels', () => {
  it('derives done from unread idle only', () => {
    expect(displayState(sess('a', { state: 'idle', unread: true }))).toBe('done')
    expect(displayState(sess('a', { state: 'idle' }))).toBe('idle')
    expect(displayState(sess('a', { state: 'waiting' }))).toBe('idle')
    expect(displayState(sess('a', { state: 'background', unread: true }))).toBe('background')
  })
  it('attention order and count', () => {
    expect(['idle', 'background', 'working', 'done', 'needs_you'].sort((a, b) => ATTENTION[a] - ATTENTION[b])).toEqual(['needs_you', 'done', 'working', 'background', 'idle'])
    expect(attentionCount([sess('a', { state: 'needs_you' }), sess('b', { state: 'idle', unread: true }), sess('c', { state: 'working' }), sess('d')])).toBe(2)
  })
  it('background detail: tasks, wake time, both, past', () => {
    const now = new Date(2026, 0, 5, 10, 0).getTime()
    const bg = (tasks: number, wakeAt: number) => sess('a', { state: 'background', background: { tasks, wakeAt } })
    expect(stateDetail(bg(1, 0), now)).toBe('1 task')
    expect(stateDetail(bg(3, 0), now)).toBe('3 tasks')
    expect(stateDetail(bg(0, new Date(2026, 0, 5, 14, 5).getTime()), now)).toBe('wakes 14:05')
    expect(stateDetail(bg(2, new Date(2026, 0, 5, 9, 0).getTime()), now)).toBe('2 tasks · waking up')
    expect(stateDetail(bg(2, new Date(2026, 0, 5, 14, 30).getTime()), now)).toBe('2 tasks · wakes 14:30')
    expect(stateDetail(sess('a', { state: 'idle', background: { tasks: 2, wakeAt: 0 } }), now)).toBe('')
  })
  it('state text: the detail when present, the label always in the title', () => {
    const now = new Date(2026, 0, 5, 10, 0).getTime()
    expect(stateText(sess('a', { state: 'background', background: { tasks: 2, wakeAt: 0 } }), now)).toEqual({ text: '2 tasks', title: 'Background · 2 tasks' })
    expect(stateText(sess('a', { state: 'needs_you' }), now)).toEqual({ text: 'Needs you', title: 'Needs you' })
    expect(stateText(sess('a', { state: 'idle', unread: true }), now)).toEqual({ text: 'Done · unread', title: 'Done · unread' })
  })
  it('next wake: the earliest future wake-up of a background session, or 0', () => {
    const bg = (wakeAt: number, state = 'background') => sess('a', { state: state as any, background: { tasks: 0, wakeAt } })
    expect(nextWake([bg(500), bg(300), bg(50), bg(200, 'idle')], 100)).toBe(300)
    expect(nextWake([bg(50), bg(0)], 100)).toBe(0)
  })
})
