import { describe, expect, it } from 'vitest'
import { initialState, reduce, setCheckouts, setProjectsData, setTicketDetail, setTickets, type AppState } from './store'
import { pendingByProject, projectCheckouts, projectSessions, ticketLine } from './projects'
import type { Envelope, Proposal, SessionInfo, Ticket } from '../proto.gen'

import { proj, sess, tk } from './fixtures.test-util'
const prop = (id: string, o: Partial<Proposal> = {}): Proposal => ({ id, ticketId: 't1', kind: 'comment', body: 'hello', status: 'pending', error: '', createdAt: 1, ...o })
const env = (type: string, payload: any): Envelope => ({ type, machine: '', session: '', payload })
const run = (envs: Envelope[], s: AppState = initialState()) => envs.reduce(reduce, s)

describe('projects reducer', () => {
  it('workspace/project upsert y gone', () => {
    let s = run([env('workspace_upsert', { id: 'w1', name: 'ACME', color: '#f00', whoasProfile: '' }), env('project_upsert', proj('p1'))])
    expect(s.workspaces.w1.name).toBe('ACME')
    expect(s.projects.p1.name).toBe('Project p1')
    s = run([env('tickets', { projectId: 'p1', tickets: [tk('t1')] })], s)
    expect(s.tickets.p1.map((t) => t.id)).toEqual(['t1'])
    s = run([env('project_gone', { id: 'p1' }), env('workspace_gone', { id: 'w1' })], s)
    expect(s.projects.p1).toBeUndefined()
    expect(s.tickets.p1).toBeUndefined()
    expect(s.workspaces.w1).toBeUndefined()
  })
  it('session_ticket: suggest, confirm (demotes the others) and remove', () => {
    let s = run([env('session_ticket', { sessionId: 's1', ticketId: 't1', confirmed: false })])
    expect(s.links.t1).toEqual({ s1: false })
    s = run([env('session_ticket', { sessionId: 's1', ticketId: 't1', confirmed: true })], s)
    expect(s.links.t1.s1).toBe(true)
    s = run([env('session_ticket', { sessionId: 's1', ticketId: 't2', confirmed: true })], s)
    expect(s.links.t1.s1).toBe(false)
    expect(s.links.t2.s1).toBe(true)
    s = run([env('session_ticket', { sessionId: 's1', ticketId: 't2', confirmed: false, removed: true })], s)
    expect(s.links.t2).toEqual({})
  })
  it('proposal_upsert and pending count per project', () => {
    let s = setTickets(initialState(), 'p1', [{ ...tk('t1'), sessions: [{ sessionId: 's1', confirmed: true }] }])
    expect(s.links.t1).toEqual({ s1: true })
    s = run([env('proposal_upsert', prop('x1')), env('proposal_upsert', prop('x2', { status: 'approved' })), env('proposal_upsert', prop('x3', { ticketId: 'other' }))], s)
    expect(pendingByProject(s)).toEqual({ p1: 1 })
    s = run([env('proposal_upsert', prop('x1', { status: 'rejected' }))], s)
    expect(pendingByProject(s)).toEqual({})
  })
  it('setProjectsData: seed does not overwrite the WS; replace does and removes what is gone', () => {
    let s = run([env('project_upsert', proj('p1', { name: 'from ws' }))])
    s = setProjectsData(s, { workspaces: [], projects: [proj('p1', { name: 'from rest' }), proj('p2')] })
    expect(s.projects.p1.name).toBe('from ws')
    expect(s.projects.p2).toBeDefined()
    s = setTickets(s, 'p2', [{ ...tk('t9', { projectId: 'p2' }), sessions: [] }])
    s = setProjectsData(s, { workspaces: [], projects: [proj('p1', { name: 'from rest' })] }, true)
    expect(s.projects.p1.name).toBe('from rest')
    expect(s.projects.p2).toBeUndefined()
    expect(s.tickets.p2).toBeUndefined()
  })
  it('setTicketDetail merges ticket, links and proposals', () => {
    let s = setTickets(initialState(), 'p1', [{ ...tk('t1'), sessions: [] }])
    s = setTicketDetail(s, { ...tk('t1', { title: 'new' }), sessions: [{ sessionId: 's9', confirmed: false }], proposals: [prop('x1')] })
    expect(s.tickets.p1[0].title).toBe('new')
    expect(s.links.t1).toEqual({ s9: false })
    expect(s.proposals.x1.body).toBe('hello')
  })
  it('sessions and checkouts of the project', () => {
    const s = run([
      env('session_upsert', sess('a', { state: 'working', branch: 'feat/1' })),
      env('session_upsert', sess('b', { state: 'closed', machine: 'mac', root: '/m' })),
      env('session_upsert', sess('c', { projectId: 'other' })),
    ])
    expect(projectSessions(s, 'p1').map((x) => x.id)).toEqual(['a'])
    expect(projectCheckouts(s, 'p1')).toEqual([{ machine: 'mac', root: '/m', branch: '' }, { machine: 'vps-2', root: '/r', branch: 'feat/1' }])
  })
})

describe('project_gone and checkouts', () => {
  it('project_gone removes links, proposals and checkouts of its tickets', () => {
    let s = setTickets(initialState(), 'p1', [{ ...tk('t1'), sessions: [{ sessionId: 's1', confirmed: true }] }])
    s = setTickets(s, 'p2', [{ ...tk('t2', { projectId: 'p2' }), sessions: [{ sessionId: 's2', confirmed: false }] }])
    s = setCheckouts(s, 'p1', [{ id: 'c1', projectId: 'p1', machine: 'm', root: '/r', repoUrl: '', branch: '', updatedAt: 1 }])
    s = run([env('proposal_upsert', prop('x1')), env('proposal_upsert', prop('x2', { ticketId: 't2' })), env('project_gone', { id: 'p1' })], s)
    expect(s.links.t1).toBeUndefined()
    expect(s.links.t2).toEqual({ s2: false })
    expect(Object.keys(s.proposals)).toEqual(['x2'])
    expect(s.checkouts.p1).toBeUndefined()
  })
  it('projectCheckouts merges the saved ones with those from sessions', () => {
    let s = setCheckouts(initialState(), 'p1', [
      { id: 'c1', projectId: 'p1', machine: 'mac', root: '/saved', repoUrl: '', branch: 'main', updatedAt: 1 },
      { id: 'c2', projectId: 'p1', machine: 'vps-2', root: '/r', repoUrl: '', branch: 'old', updatedAt: 1 },
    ])
    s = run([env('session_upsert', sess('a', { branch: 'feat/2' }))], s)
    expect(projectCheckouts(s, 'p1')).toEqual([
      { machine: 'mac', root: '/saved', branch: 'main' },
      { machine: 'vps-2', root: '/r', branch: 'feat/2' },
    ])
  })
})

describe('ticketLine (combined state)', () => {
  const now = 1_700_000_000_000
  const base = (st: Partial<SessionInfo>, t: Partial<Ticket> = {}) => {
    let s = run([env('session_upsert', sess('s1', st)), env('session_ticket', { sessionId: 's1', ticketId: 't1', confirmed: true })])
    return { s, t: tk('t1', t) }
  }
  it('working', () => {
    const { s, t } = base({ state: 'working', updatedAt: now - 12 * 60000 }, { status: 'in_progress' })
    expect(ticketLine(s, t, now).text).toBe('in progress · vps-2 · working 12 min ago')
  })
  it('needs you', () => {
    const { s, t } = base({ state: 'needs_you' })
    expect(ticketLine(s, t, now)).toEqual({ text: 'needs you · vps-2', tone: 'amber' })
  })
  it('in_review in the ticket source', () => {
    const { s, t } = base({ state: 'closed' }, { status: 'in_review' })
    expect(ticketLine(s, t, now).text).toBe('done, waiting for your review')
  })
  it('the session finished its turn after working', () => {
    let { s, t } = base({ state: 'working' }, { status: 'in_progress' })
    s = run([env('session_upsert', sess('s1', { state: 'idle' }))], s)
    expect(ticketLine(s, t, now).text).toBe('done, waiting for your review · vps-2')
  })
  it('a suggested session does not count; without a session, the ticket source\'s status', () => {
    let s = run([env('session_upsert', sess('s1', { state: 'working' })), env('session_ticket', { sessionId: 's1', ticketId: 't1', confirmed: false })])
    expect(ticketLine(s, tk('t1', { status: 'blocked' }), now)).toEqual({ text: 'blocked', tone: 'red' })
  })
})
