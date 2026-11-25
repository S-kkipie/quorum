import { afterEach, describe, expect, it } from 'vitest'
import { BRIEFING_PROMPT_MAX, briefingPrompt, emptyBriefing, isOverdue, latestSession, statusText, ticketWhen } from './briefing'
import type { Briefing } from './api'
import type { SessionInfo, Ticket } from '../proto.gen'

const ticket = (id: string, o: Partial<Ticket> = {}): Ticket => ({
  id, projectId: 'p1', externalId: id, title: 'Ticket ' + id, status: 'todo', rawStatus: 'por_hacer', assignee: 'Ana',
  url: '', body: '', comments: [], updatedAt: 1, ...o,
})
const at = (iso: string) => new Date(iso).getTime()

const TZ = process.env.TZ
afterEach(() => { process.env.TZ = TZ })

describe('isOverdue', () => {
  it('compares the planned end by calendar day, not by time', () => {
    const now = new Date(2026, 10, 24, 9, 0).getTime() // 24 Nov, 09:00 local
    expect(isOverdue(ticket('a', { plannedEnd: new Date(2026, 10, 24, 0, 1).getTime() }), now)).toBe(false) // earlier today
    expect(isOverdue(ticket('a', { plannedEnd: new Date(2026, 10, 23, 23, 59).getTime() }), now)).toBe(true) // yesterday, a minute before midnight
    expect(isOverdue(ticket('a', { plannedEnd: new Date(2026, 10, 25, 12).getTime() }), now)).toBe(false)
  })
  it('done tickets and tickets without a planned end are never overdue; parked ones can be', () => {
    const now = new Date(2026, 10, 24, 9).getTime()
    const past = new Date(2026, 10, 20, 12).getTime()
    expect(isOverdue(ticket('a', { plannedEnd: past, status: 'done' }), now)).toBe(false)
    expect(isOverdue(ticket('a'), now)).toBe(false)
    expect(isOverdue(ticket('a', { plannedEnd: past, status: 'blocked', rawStatus: 'aparcado' }), now)).toBe(true)
  })
  it('uses the device time zone at a day edge', () => {
    const end = at('2026-11-24T03:00:00Z') // 23 Nov 22:00 in Lima (UTC-5), 24 Nov in UTC
    const lateEvening = at('2026-11-24T04:30:00Z') // 23 Nov 23:30 in Lima
    const afterMidnight = at('2026-11-24T05:30:00Z') // 24 Nov 00:30 in Lima
    process.env.TZ = 'America/Lima'
    expect(isOverdue(ticket('a', { plannedEnd: end }), lateEvening)).toBe(false)
    expect(isOverdue(ticket('a', { plannedEnd: end }), afterMidnight)).toBe(true)
    process.env.TZ = 'UTC'
    expect(isOverdue(ticket('a', { plannedEnd: end }), afterMidnight)).toBe(false) // both on 24 Nov
  })
})

describe('ticket text', () => {
  it('shows Due <date> with the overdue flag, Starts, or No date', () => {
    const now = new Date(2026, 10, 24, 9).getTime()
    const due = ticketWhen(ticket('a', { plannedEnd: new Date(2026, 10, 20, 12).getTime() }), now)
    expect(due.overdue).toBe(true)
    expect(due.text).toMatch(/^Due /)
    expect(ticketWhen(ticket('a', { plannedEnd: new Date(2026, 10, 28, 12).getTime() }), now)).toMatchObject({ overdue: false, text: expect.stringMatching(/^Due /) })
    expect(ticketWhen(ticket('a', { plannedStart: new Date(2026, 11, 1, 12).getTime() }), now).text).toMatch(/^Starts /)
    expect(ticketWhen(ticket('a'), now).text).toBe('No date')
  })
  it('labels parked tickets as Parked', () => {
    expect(statusText(ticket('a', { status: 'blocked', rawStatus: 'aparcado' }))).toBe('Parked')
    expect(statusText(ticket('a', { status: 'in_progress', rawStatus: 'en_curso' }))).toBe('In progress')
  })
})

const session = (id: string, o: Partial<SessionInfo> = {}): SessionInfo => ({ id, machine: 'm1', root: '/work/' + id, cwd: '/work/' + id, updatedAt: 1, ...o } as SessionInfo)

describe('briefingPrompt', () => {
  const full = (): Briefing => ({
    ...emptyBriefing(),
    whereLeftOff: { text: 'You were finishing the importer for Acme.', at: 1, sessions: 3 },
    newSince: [{ kind: 'ticket', title: 'Ticket moved to In progress: Acme export', detail: 'To do → In progress', at: 1, ref: 't9' }],
    myTickets: [ticket('1', { title: 'Acme · import CSV' }), ticket('2', { title: 'Acme · export PDF', status: 'in_progress', rawStatus: 'en_curso' })],
    meetings: {
      decisions: [{ text: 'Ship on Monday', noteTitle: 'Weekly', date: '2026-11-20' }],
      openPoints: [{ text: 'Who owns the backups?', noteTitle: 'Weekly', date: '2026-11-20' }],
      actions: [{ text: 'Ana: send the report', noteTitle: 'Weekly', date: '2026-11-20' }],
    },
    pinned: [{ id: 'n1', text: 'Staging is on vps-1', at: 1 }],
  })
  it('has English headings and copies the data verbatim', () => {
    const p = briefingPrompt(full())
    for (const s of ['Where I left off', 'My open tickets', 'From meetings', 'Pinned notes', 'You were finishing the importer for Acme.', 'Acme · import CSV', 'Acme · export PDF', 'Ship on Monday', 'Who owns the backups?', 'Ana: send the report', 'Staging is on vps-1', 'To do → In progress']) {
      expect(p).toContain(s)
    }
  })
  it('stays within 1,500 characters and keeps the open tickets when the rest is huge', () => {
    const b = full()
    b.newSince = Array.from({ length: 20 }, (_, i) => ({ kind: 'session', title: 'Session finished: ' + 'x'.repeat(150) + i, detail: 'y'.repeat(100), at: 1, ref: 's' + i }))
    b.meetings.decisions = Array.from({ length: 30 }, (_, i) => ({ text: 'Decision ' + 'z'.repeat(120) + i, noteTitle: 'N', date: '2026-11-20' }))
    b.pinned = Array.from({ length: 20 }, (_, i) => ({ id: 'n' + i, text: 'w'.repeat(500), at: 1 }))
    b.whereLeftOff = { text: 'v'.repeat(900), at: 1, sessions: 3 }
    const p = briefingPrompt(b)
    expect(p.length).toBeLessThanOrEqual(BRIEFING_PROMPT_MAX)
    expect(BRIEFING_PROMPT_MAX).toBe(1500)
    expect(p).toContain('Acme · import CSV')
    expect(p).toContain('Acme · export PDF')
  })
  it('stays within the limit even with many long tickets', () => {
    const b = full()
    b.myTickets = Array.from({ length: 60 }, (_, i) => ticket(String(i), { title: 'T'.repeat(200) + i }))
    expect(briefingPrompt(b).length).toBeLessThanOrEqual(1500)
  })
  it('omits empty sections', () => {
    const p = briefingPrompt({ ...emptyBriefing(), myTickets: [ticket('1')] })
    expect(p).toContain('Ticket 1')
    expect(p).not.toContain('Where I left off')
    expect(p).not.toContain('Pinned notes')
  })
})

describe('latestSession', () => {
  it('is the session with the latest activity', () => {
    const b = { ...emptyBriefing(), sessions: [session('a', { updatedAt: 5 }), session('b', { updatedAt: 9 }), session('c', { updatedAt: 2 })] }
    expect(latestSession(b)?.id).toBe('b')
    expect(latestSession(emptyBriefing())).toBeUndefined()
  })
})
