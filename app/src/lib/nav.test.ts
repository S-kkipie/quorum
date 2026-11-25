import { describe, expect, it } from 'vitest'
import { centreNav, centreOf, meetingLink, type Centre } from './nav'

describe('centre and history entries', () => {
  const all: Centre[] = [
    { kind: 'projects' },
    { kind: 'session', id: 'a' },
    { kind: 'project', id: 'p1' },
    { kind: 'tickets', projectId: 'p1' },
    { kind: 'tickets', projectId: 'p1', ticket: 't1' },
    { kind: 'settings' },
    { kind: 'settings', project: 'p1' },
    { kind: 'terminal', terminal: { machine: 'vps-1', pane: 'w1:p1' } },
    { kind: 'starting' },
  ]
  it('every centre maps onto a history entry and back', () => {
    for (const c of all) expect(centreOf(centreNav(c))).toEqual(c)
  })
  it('an empty entry is the projects board', () => {
    expect(centreOf({})).toEqual({ kind: 'projects' })
  })
  it('a page opened over another wins (terminal from a project, tickets over its project)', () => {
    expect(centreOf({ project: 'p1', terminal: { machine: 'm', pane: 'x' } }).kind).toBe('terminal')
    expect(centreOf({ project: 'p1', projectTickets: 'p1' }).kind).toBe('tickets')
    expect(centreOf({ session: 'a', config: '' }).kind).toBe('settings')
  })
})

describe('meetings', () => {
  it('a meeting maps onto a history entry and back, and wins over Settings', () => {
    expect(centreOf(centreNav({ kind: 'meeting', id: 'm1' }))).toEqual({ kind: 'meeting', id: 'm1' })
    expect(centreOf({ config: '', meeting: 'm1' })).toEqual({ kind: 'meeting', id: 'm1' })
    expect(centreOf({ project: 'p1', meeting: 'm1' }).kind).toBe('meeting')
  })
  it('reads the ?meeting=<id> deep link', () => {
    expect(meetingLink('?meeting=abc-12')).toBe('abc-12')
    expect(meetingLink('?x=1')).toBeNull()
    expect(meetingLink('?meeting=')).toBeNull()
    expect(meetingLink('?meeting=../x')).toBeNull()
  })
})
