import { describe, expect, it } from 'vitest'
import { initialState, type AppState } from './store'
import { sessionMeta, sessionTree } from './tree'
import { proj, sess } from './fixtures.test-util'
import type { SessionInfo } from '../proto.gen'

const ws = (id: string, name: string) => ({ id, name, color: '#123456', whoasProfile: '' })
function build(sessions: SessionInfo[], o: Partial<AppState> = {}): AppState {
  const s = initialState()
  return {
    ...s,
    workspaces: { w1: ws('w1', 'Beta'), w2: ws('w2', 'Alpha') },
    projects: { p1: proj('p1', { name: 'Zed' }), p2: proj('p2', { name: 'Ann' }), p3: proj('p3', { workspaceId: 'w2', name: 'Solo' }) },
    sessions: Object.fromEntries(sessions.map((x) => [x.id, x])),
    order: sessions.map((x) => x.id),
    ...o,
  }
}

describe('sessionTree', () => {
  it('groups jobs (by name), projects (by name) and sessions in ATTENTION order, then by last activity', () => {
    const s = build([
      sess('idle-new', { updatedAt: 50 }),
      sess('work-old', { state: 'working', updatedAt: 10 }),
      sess('done', { state: 'idle', unread: true, updatedAt: 1 }),
      sess('needs', { state: 'needs_you', updatedAt: 2 }),
      sess('bg', { state: 'background', updatedAt: 99 }),
      sess('work-new', { state: 'working', updatedAt: 20 }),
      sess('idle-old', { updatedAt: 5 }),
      sess('gone', { state: 'closed' }),
      sess('in-p3', { projectId: 'p3' }),
    ])
    const t = sessionTree(s)
    expect(t.jobs.map((j) => j.name)).toEqual(['Alpha', 'Beta'])
    expect(t.jobs[1].projects.map((p) => p.name)).toEqual(['Ann', 'Zed'])
    expect(t.jobs[1].projects[1].sessions.map((x) => x.id)).toEqual(['needs', 'done', 'work-new', 'work-old', 'bg', 'idle-new', 'idle-old'])
    expect(t.jobs[1].projects[0].sessions).toEqual([])
    expect(t.jobs[0].projects[0].sessions.map((x) => x.id)).toEqual(['in-p3'])
  })

  it('Needs you holds only needs_you sessions across projects, and is empty otherwise', () => {
    const s = build([sess('a', { state: 'needs_you', updatedAt: 1 }), sess('b', { state: 'needs_you', projectId: 'p3', updatedAt: 9 }), sess('c', { state: 'idle', unread: true })])
    expect(sessionTree(s).needsYou.map((x) => x.id)).toEqual(['b', 'a'])
    expect(sessionTree(build([sess('c', { state: 'working' })])).needsYou).toEqual([])
  })

  it('sessions with no known project and service sessions get their own groups', () => {
    const s = build([sess('loose', { projectId: '' }), sess('svc', { role: 'service' }), sess('x', { projectId: 'nope' })])
    const t = sessionTree(s)
    expect(t.loose.map((x) => x.id)).toEqual(['loose', 'x'])
    expect(t.services.map((x) => x.id)).toEqual(['svc'])
  })

  it('projects without a workspace go under "No workspace"', () => {
    const s = build([], { projects: { p9: proj('p9', { workspaceId: 'zz', name: 'Orphan' }) } })
    const t = sessionTree(s)
    expect(t.jobs.map((j) => j.name)).toEqual(['Alpha', 'Beta', 'No workspace'])
    expect(t.jobs[2].projects.map((p) => p.name)).toEqual(['Orphan'])
  })

  it('search matches name, project and machine, case-insensitively, and drops empty groups', () => {
    const s = build([
      sess('a', { recap: 'Fix the LOGIN page' }),
      sess('b', { projectId: 'p3', machine: 'laptop' }),
      sess('c', { projectId: 'p2', name: 'other' }),
      sess('d', { state: 'needs_you', recap: 'Deploy' }),
    ])
    const ids = (t: ReturnType<typeof sessionTree>) => [...t.needsYou, ...t.jobs.flatMap((j) => j.projects.flatMap((p) => p.sessions)), ...t.loose].map((x) => x.id)
    expect(ids(sessionTree(s, 'login'))).toEqual(['a'])
    expect(ids(sessionTree(s, 'LAPTOP'))).toEqual(['b'])
    expect(ids(sessionTree(s, 'ann'))).toEqual(['c'])
    expect(ids(sessionTree(s, 'deploy'))).toEqual(['d', 'd'])
    const t = sessionTree(s, 'laptop')
    expect(t.jobs.map((j) => j.name)).toEqual(['Alpha'])
    expect(t.jobs[0].projects.map((p) => p.name)).toEqual(['Solo'])
    expect(ids(sessionTree(s, 'nothing matches'))).toEqual([])
    expect(sessionTree(s, 'nothing matches').jobs).toEqual([])
  })

  it('matches CJK and emoji names', () => {
    const s = build([sess('a', { recap: '修复登录页面 🚀 now' })])
    expect(sessionTree(s, '登录').jobs[0].projects[0].sessions.map((x) => x.id)).toEqual(['a'])
    expect(sessionTree(s, '🚀').jobs[0].projects[0].sessions.map((x) => x.id)).toEqual(['a'])
  })
})

describe('sessionMeta', () => {
  const now = 1_700_000_000_000
  it('relative time, or bg for background sessions', () => {
    expect(sessionMeta(sess('a', { updatedAt: now - 10_000 }), now)).toBe('now')
    expect(sessionMeta(sess('a', { updatedAt: now - 7 * 60_000 }), now)).toBe('7m')
    expect(sessionMeta(sess('a', { updatedAt: now - 3 * 3600_000 }), now)).toBe('3h')
    expect(sessionMeta(sess('a', { updatedAt: now - 2 * 86400_000 }), now)).toBe('2d')
    expect(sessionMeta(sess('a', { updatedAt: (now - 7 * 60_000) / 1000 }), now)).toBe('7m')
    expect(sessionMeta(sess('a', { state: 'background', updatedAt: now }), now)).toBe('bg')
    expect(sessionMeta(sess('a', { updatedAt: 0 }), now)).toBe('')
  })
})
