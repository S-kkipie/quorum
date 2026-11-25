// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Meeting } from '../../proto.gen'

const api = vi.hoisted(() => ({
  getMeeting: vi.fn(), patchMeeting: vi.fn(), retryMeeting: vi.fn(), reprocessMeeting: vi.fn(), nameSpeakers: vi.fn(),
  createMeetingIssue: vi.fn(), deleteMeeting: vi.fn(), meetingAudioURL: vi.fn(),
}))
const pend = vi.hoisted(() => ({ addMeetingPending: vi.fn() }))
vi.mock('../../lib/pendingsApi', async (orig) => ({ ...(await orig<typeof import('../../lib/pendingsApi')>()), ...pend }))
vi.mock('../../lib/meetingsApi', async (orig) => ({ ...(await orig<typeof import('../../lib/meetingsApi')>()), ...api }))
import MeetingPage from './MeetingPage'
import { initialState, reduce, type AppState } from '../../lib/store'
import { proj } from '../../lib/fixtures.test-util'
import { ApiError } from '../../lib/api'
import type { Envelope } from '../../proto.gen'

export const meeting = (o: Partial<Meeting> = {}): Meeting => ({
  id: 'm1', projectId: 'p1', title: 'Weekly sync', startedAt: Date.UTC(2026, 10, 20, 10), durationS: 1800, language: 'en', status: 'ready', progress: 100, error: '',
  provider: 'local', createdAt: 1, updatedAt: 1, hasAudio: true, audioBytes: 1000, channels: '', speakerCount: 0, ...o,
})
const ready = (): Meeting => meeting({
  summary: {
    title: 'Weekly sync', summary: 'The team reviewed the export.', topics: ['Export', 'Backups'],
    decisions: [{ text: 'Ship the export on Monday', tsMs: 65_000 }], openPoints: [{ text: 'Who owns the backups?' }], attendees: ['Ana', 'Ben'],
  },
  actions: [
    { id: 'a1', text: 'Write the release notes', owner: 'Ben', due: '', mine: false },
    { id: 'a2', text: 'Send the report', owner: 'Ana', due: 'Friday', mine: true, tsMs: 120_000 },
    { id: 'a3', text: 'Book the room', owner: '', due: '', mine: false },
  ],
  segments: [
    { startMs: 0, endMs: 4000, speaker: 'Speaker 1', label: 'Speaker 1', text: 'Good morning, shall we start with the export?' },
    { startMs: 65_000, endMs: 70_000, speaker: 'Speaker 2', label: 'Speaker 2', text: 'The export ships on Monday.' },
    { startMs: 120_000, endMs: 125_000, speaker: 'Speaker 1', label: 'Speaker 1', text: 'I will send the report by Friday.' },
  ],
})

const state = (kind = 'github', repo = 'acme/app'): AppState => ({
  ...initialState(),
  projects: { p1: proj('p1', { name: 'Acme', connector: { kind, settings: kind === 'github' ? { repo } : {}, hasToken: false, intervalMin: 5 } }) },
})

beforeEach(() => {
  api.meetingAudioURL.mockResolvedValue('http://h/api/meeting-audio/tok')
  vi.stubGlobal('localStorage', { getItem: () => 'tok', setItem() {}, removeItem() {} })
})
afterEach(() => { for (const f of [...Object.values(api), ...Object.values(pend)]) f.mockReset() })

const regions = () => screen.queryAllByRole('region').map((r) => r.getAttribute('aria-label'))

describe('MeetingPage while processing', () => {
  it('shows the status and the live progress; the people count and language are editable', async () => {
    api.getMeeting.mockResolvedValue(meeting({ status: 'transcribing', progress: 10, summary: undefined }))
    api.patchMeeting.mockResolvedValue(meeting({ status: 'transcribing', progress: 10, speakerCount: 4 }))
    let s = state()
    s = reduce(s, { type: 'meeting_changed', payload: { id: 'm1', projectId: 'p1', status: 'transcribing', progress: 10, stage: 'transcribing' } } as unknown as Envelope)
    const { rerender } = render(<MeetingPage state={s} id="m1" />)
    await screen.findByText('Transcribing 10%')
    s = reduce(s, { type: 'meeting_changed', payload: { id: 'm1', projectId: 'p1', status: 'transcribing', progress: 40, stage: 'diarizing' } } as unknown as Envelope)
    rerender(<MeetingPage state={s} id="m1" />)
    expect(screen.getByText('Transcribing 40%')).toBeTruthy()
    expect(screen.getByText(/telling the voices apart/)).toBeTruthy()
    expect(screen.getByRole('progressbar')).toBeTruthy()
    // progress only: no refetch
    expect(api.getMeeting).toHaveBeenCalledTimes(1)
    fireEvent.change(screen.getByLabelText('How many people?'), { target: { value: '4' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.patchMeeting).toHaveBeenCalledWith('m1', { speakers: 4 }))
    expect(regions()).not.toContain('Summary')
  })

  it('refetches when a meeting_changed brings another status', async () => {
    api.getMeeting.mockResolvedValueOnce(meeting({ status: 'summarising', progress: 0 })).mockResolvedValueOnce(ready())
    let s = state()
    const { rerender } = render(<MeetingPage state={s} id="m1" />)
    await screen.findByText('Summarising')
    s = reduce(s, { type: 'meeting_changed', payload: { id: 'm1', projectId: 'p1', status: 'ready' } } as unknown as Envelope)
    rerender(<MeetingPage state={s} id="m1" />)
    await screen.findByRole('region', { name: 'Summary' })
    expect(api.getMeeting).toHaveBeenCalledTimes(2)
  })

  it('a failed meeting shows its error and Retry', async () => {
    api.getMeeting.mockResolvedValue(meeting({ status: 'failed', error: 'CUDA out of memory on the laptop.' }))
    api.retryMeeting.mockResolvedValue(meeting({ status: 'queued' }))
    render(<MeetingPage state={state()} id="m1" />)
    expect((await screen.findByText('CUDA out of memory on the laptop.')).getAttribute('role')).toBe('alert')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText('Waiting for a machine')
    expect(api.retryMeeting).toHaveBeenCalledWith('m1')
    // nobody can transcribe: say so
    expect(screen.getByText(/No machine can transcribe right now/)).toBeTruthy()
  })
})

describe('MeetingPage waiting for a local summary', () => {
  const machine = (name: string, online: boolean, transcribe: boolean) =>
    ({ name, os: 'linux', env: 'wsl', version: '', online, lastSeen: 0, caps: { herdr: false, terminal: false, root: false, transcribe, meetingWorker: transcribe ? 'ready' : '' } })
  const summarising = () => meeting({ status: 'summarising', progress: 0, provider: 'local', segments: ready().segments, summary: undefined })

  it('names the machine it waits for', async () => {
    api.getMeeting.mockResolvedValue(summarising())
    render(<MeetingPage state={{ ...state(), machines: { gpu: machine('gpu', true, true), vps: machine('vps', true, false) } }} id="m1" />)
    expect(await screen.findByText('Waiting for gpu to summarise.')).toBeTruthy()
  })

  it('an offline machine is asked to be turned on; none at all says so', async () => {
    api.getMeeting.mockResolvedValue(summarising())
    const { unmount } = render(<MeetingPage state={{ ...state(), machines: { gpu: machine('gpu', false, true) } }} id="m1" />)
    expect(await screen.findByText(/Waiting for gpu to summarise: turn it on/)).toBeTruthy()
    unmount()
    render(<MeetingPage state={{ ...state(), machines: { vps: machine('vps', true, false) } }} id="m1" />)
    expect(await screen.findByText(/No machine can summarise locally/)).toBeTruthy()
  })

  it('says nothing once the summary runs or for a hub provider', async () => {
    api.getMeeting.mockResolvedValue(meeting({ ...summarising(), provider: 'ccapi' }))
    render(<MeetingPage state={{ ...state(), machines: {} }} id="m1" />)
    await screen.findByText('Summarising')
    expect(screen.queryByText(/summarise locally|to summarise/)).toBeNull()
  })
})

describe('MeetingPage when ready', () => {
  it('shows the sections in order and the owner\'s actions first', async () => {
    api.getMeeting.mockResolvedValue(ready())
    render(<MeetingPage state={state()} id="m1" />)
    await screen.findByRole('region', { name: 'Summary' })
    expect(regions()).toEqual(['Summary', 'Decisions', 'Open points', 'Actions', 'Attendees', 'Transcript'])
    const rows = within(screen.getByRole('region', { name: 'Actions' })).getAllByRole('listitem')
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining('Send the report'), expect.stringContaining('Write the release notes'), expect.stringContaining('Book the room')])
    expect(rows[0].textContent).toContain('Mine')
    expect(rows[2].textContent).toContain('Unassigned')
    expect(screen.getByText('Ana, Ben')).toBeTruthy()
  })

  it('"Create issue" only for GitHub projects; once it exists the button opens it', async () => {
    api.getMeeting.mockResolvedValue(ready())
    api.createMeetingIssue.mockResolvedValue({ url: 'https://github.com/acme/app/issues/7', created: true })
    render(<MeetingPage state={state()} id="m1" />)
    const actions = await screen.findByRole('region', { name: 'Actions' })
    expect(within(actions).getAllByRole('button', { name: 'Create issue' })).toHaveLength(3)
    fireEvent.click(within(actions).getAllByRole('button', { name: 'Create issue' })[0])
    const link = await within(actions).findByRole('link', { name: 'Open issue' })
    expect(link.getAttribute('href')).toBe('https://github.com/acme/app/issues/7')
    expect(api.createMeetingIssue).toHaveBeenCalledWith('m1', 'a2')
    expect(within(actions).getAllByRole('button', { name: 'Create issue' })).toHaveLength(2)
  })

  it('an issue created but not linked opens it and is never created twice', async () => {
    api.getMeeting.mockResolvedValue(ready())
    api.createMeetingIssue.mockRejectedValueOnce(new ApiError('the issue was created but could not be recorded', 500, { url: 'https://github.com/acme/app/issues/8' }))
      .mockRejectedValueOnce(new ApiError('the issue was created, but its action changed meanwhile', 409, { url: 'https://github.com/acme/app/issues/9' }))
    let s = state()
    const { rerender } = render(<MeetingPage state={s} id="m1" />)
    let actions = await screen.findByRole('region', { name: 'Actions' })
    fireEvent.click(within(actions).getAllByRole('button', { name: 'Create issue' })[0])
    expect((await within(actions).findByRole('alert')).textContent).toContain('could not be recorded')
    expect(within(actions).getByRole('link', { name: 'Open issue' }).getAttribute('href')).toBe('https://github.com/acme/app/issues/8')
    fireEvent.click(within(actions).getAllByRole('button', { name: 'Create issue' })[0])
    await waitFor(() => expect(within(actions).getAllByRole('link', { name: 'Open issue' })).toHaveLength(2))
    // a refetch (the hub still has no link) keeps the links: no second create for those actions
    s = reduce(s, { type: 'meeting_changed', payload: { id: 'm1', projectId: 'p1', status: 'ready' } } as unknown as Envelope)
    rerender(<MeetingPage state={s} id="m1" />)
    await waitFor(() => expect(api.getMeeting).toHaveBeenCalledTimes(2))
    actions = screen.getByRole('region', { name: 'Actions' })
    expect(within(actions).getAllByRole('link', { name: 'Open issue' })).toHaveLength(2)
    expect(within(actions).getAllByRole('button', { name: 'Create issue' })).toHaveLength(1)
    expect(api.createMeetingIssue).toHaveBeenCalledTimes(2)
  })

  it('an action that already has an issue opens it; other connectors get Copy', async () => {
    const m = ready()
    m.actions![0].issueUrl = 'https://github.com/acme/app/issues/3'
    api.getMeeting.mockResolvedValue(m)
    const { unmount } = render(<MeetingPage state={state()} id="m1" />)
    expect((await screen.findByRole('link', { name: 'Open issue' })).getAttribute('href')).toBe('https://github.com/acme/app/issues/3')
    unmount()
    render(<MeetingPage state={state('paperclip')} id="m1" />)
    const actions = await screen.findByRole('region', { name: 'Actions' })
    expect(within(actions).queryByRole('button', { name: 'Create issue' })).toBeNull()
    expect(within(actions).queryByRole('link', { name: 'Open issue' })).toBeNull()
    expect(within(actions).getAllByRole('button', { name: 'Copy' })).toHaveLength(3)
  })

  it('a GitHub project without a repo shows no Create issue', async () => {
    api.getMeeting.mockResolvedValue(ready())
    render(<MeetingPage state={state('github', ' ')} id="m1" />)
    const actions = await screen.findByRole('region', { name: 'Actions' })
    expect(within(actions).queryByRole('button', { name: 'Create issue' })).toBeNull()
  })
})

describe('Speakers', () => {
  it('a label is renamed inline, all its segments follow, and "Re-summarise with names" is offered', async () => {
    api.getMeeting.mockResolvedValue(ready())
    const renamed = ready()
    renamed.segments = renamed.segments!.map((s) => (s.label === 'Speaker 1' ? { ...s, speaker: 'Bruno' } : s))
    api.nameSpeakers.mockResolvedValue(renamed)
    api.reprocessMeeting.mockResolvedValue(meeting({ status: 'summarising', progress: 0 }))
    render(<MeetingPage state={state()} id="m1" />)
    const transcript = await screen.findByRole('region', { name: 'Transcript' })
    expect(within(transcript).queryByRole('button', { name: 'Re-summarise with names' })).toBeNull()
    expect(within(transcript).getAllByText('Speaker 1')).toHaveLength(3) // the chip and two segments
    fireEvent.click(within(transcript).getByRole('button', { name: 'Rename Speaker 1' }))
    fireEvent.change(within(transcript).getByLabelText('Name of Speaker 1'), { target: { value: 'Bruno' } })
    fireEvent.click(within(transcript).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.nameSpeakers).toHaveBeenCalledWith('m1', { 'Speaker 1': 'Bruno' }))
    await within(transcript).findByRole('button', { name: 'Re-summarise with names' })
    expect(within(transcript).queryAllByText('Speaker 1')).toHaveLength(0)
    expect(within(transcript).getByText('(Speaker 1)')).toBeTruthy()
    expect(within(transcript).getAllByText('Bruno')).toHaveLength(3)
    expect(within(transcript).getAllByText('Speaker 2')).toHaveLength(2)
    fireEvent.click(within(transcript).getByRole('button', { name: 'Re-summarise with names' }))
    await waitFor(() => expect(api.reprocessMeeting).toHaveBeenCalledWith('m1', 'local'))
    await screen.findByText('Summarising')
  })

  it('a failed rename puts the names back and says why', async () => {
    api.getMeeting.mockResolvedValue(ready())
    api.nameSpeakers.mockRejectedValue(new Error('the name is too long'))
    render(<MeetingPage state={state()} id="m1" />)
    const transcript = await screen.findByRole('region', { name: 'Transcript' })
    fireEvent.click(within(transcript).getByRole('button', { name: 'Rename Speaker 2' }))
    fireEvent.change(within(transcript).getByLabelText('Name of Speaker 2'), { target: { value: 'Wenna' } })
    fireEvent.click(within(transcript).getByRole('button', { name: 'Save' }))
    expect((await within(transcript).findByRole('alert')).textContent).toBe('the name is too long')
    expect(within(transcript).queryByText('Wenna')).toBeNull()
    expect(within(transcript).queryByRole('button', { name: 'Re-summarise with names' })).toBeNull()
  })
})

describe('Transcript', () => {
  it('search highlights the matches and keeps only the matching segments', async () => {
    api.getMeeting.mockResolvedValue(ready())
    render(<MeetingPage state={state()} id="m1" />)
    const transcript = await screen.findByRole('region', { name: 'Transcript' })
    fireEvent.change(within(transcript).getByLabelText('Search the transcript'), { target: { value: 'EXPORT' } })
    const marks = transcript.querySelectorAll('mark')
    expect([...marks].map((m) => m.textContent)).toEqual(['export', 'export'])
    expect(within(transcript).getByText('2 segments match')).toBeTruthy()
    expect(within(transcript).queryByText(/send the report/)).toBeNull()
  })

  it('a click on a time seeks the audio there', async () => {
    api.getMeeting.mockResolvedValue(ready())
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    render(<MeetingPage state={state()} id="m1" />)
    const transcript = await screen.findByRole('region', { name: 'Transcript' })
    const audio = await waitFor(() => { const a = transcript.querySelector('audio'); expect(a).toBeTruthy(); return a! })
    expect(audio.getAttribute('src')).toBe('http://h/api/meeting-audio/tok')
    fireEvent.click(within(transcript).getByRole('button', { name: 'Play from 1:05' }))
    expect(audio.currentTime).toBe(65)
    expect(play).toHaveBeenCalled()
    // a decision's citation seeks too
    fireEvent.click(within(screen.getByRole('region', { name: 'Decisions' })).getByRole('button', { name: 'at 1:05' }))
    expect(audio.currentTime).toBe(65)
    play.mockRestore()
  })
})

describe('MeetingPage header', () => {
  it('moves the meeting to another project and edits the title', async () => {
    api.getMeeting.mockResolvedValue(ready())
    api.patchMeeting.mockImplementation(async (_id: string, b: Partial<Meeting>) => meeting({ ...b }))
    render(<MeetingPage state={state()} id="m1" />)
    await screen.findByRole('region', { name: 'Summary' })
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: '' } })
    await waitFor(() => expect(api.patchMeeting).toHaveBeenCalledWith('m1', { projectId: '' }))
    // the PATCH answer has no detail: the summary stays
    expect(screen.getByRole('region', { name: 'Summary' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Edit title' }))
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Planning' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.patchMeeting).toHaveBeenCalledWith('m1', { title: 'Planning' }))
    await screen.findByRole('heading', { name: 'Planning' })
  })

  it('a deleted meeting says so', async () => {
    api.getMeeting.mockResolvedValue(ready())
    let s = state()
    const { rerender } = render(<MeetingPage state={s} id="m1" />)
    await screen.findByRole('region', { name: 'Summary' })
    s = reduce(s, { type: 'meeting_changed', payload: { id: 'm1', projectId: 'p1', status: 'deleted' } } as unknown as Envelope)
    await act(async () => rerender(<MeetingPage state={s} id="m1" />))
    expect(screen.getByText('This meeting was deleted.')).toBeTruthy()
  })

  it('fits 320 px: long text wraps and nothing has a fixed wide width', async () => {
    const m = ready()
    m.title = 'T'.repeat(300)
    m.summary!.summary = 'x'.repeat(600)
    m.actions![0].text = 'https://example.com/' + 'y'.repeat(300)
    m.segments![0].text = 'z'.repeat(500)
    api.getMeeting.mockResolvedValue(m)
    const { container } = render(<MeetingPage state={state()} id="m1" />)
    await screen.findByRole('region', { name: 'Summary' })
    expect(container.innerHTML).not.toMatch(/\b(min-)?w-\[\d{3,}px\]/)
    expect(container.innerHTML).not.toMatch(/\bw-(80|96|\[\d+rem\])\b/)
    expect(screen.getByText('x'.repeat(600)).className).toContain('[overflow-wrap:anywhere]')
    expect(screen.getByText(/^https:\/\/example.com/).className).toContain('[overflow-wrap:anywhere]')
    expect(screen.getByText('z'.repeat(500)).className).toContain('[overflow-wrap:anywhere]')
    expect(screen.getByRole('heading', { level: 2 }).className).toContain('truncate')
    for (const r of screen.getAllByRole('region')) expect(r.className).toContain('min-w-0')
    for (const b of screen.getAllByRole('button')) expect(b.className).toMatch(/min-h-11|size-11|h-11/)
  })
})

describe('MeetingPage add as pending', () => {
  it('add as pending calls the API and shows Added', async () => {
    api.getMeeting.mockResolvedValue(ready())
    pend.addMeetingPending.mockResolvedValue({ id: 'x1', added: true })
    render(<MeetingPage state={state()} id="m1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add as pending' }))
    await screen.findByRole('button', { name: 'Added' })
    expect(pend.addMeetingPending).toHaveBeenCalledWith('m1', 'Who owns the backups?')
    expect((screen.getByRole('button', { name: 'Added' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('a 409 also shows Added', async () => {
    api.getMeeting.mockResolvedValue(ready())
    pend.addMeetingPending.mockResolvedValue({ id: 'x1', added: false })
    render(<MeetingPage state={state()} id="m1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add as pending' }))
    await screen.findByRole('button', { name: 'Added' })
  })
  it('shows the error and allows a retry', async () => {
    api.getMeeting.mockResolvedValue(ready())
    pend.addMeetingPending.mockRejectedValue(new Error('hub down'))
    render(<MeetingPage state={state()} id="m1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add as pending' }))
    await screen.findByText('hub down')
    expect((screen.getByRole('button', { name: 'Add as pending' }) as HTMLButtonElement).disabled).toBe(false)
  })
  it('no button when the meeting has no project', async () => {
    api.getMeeting.mockResolvedValue({ ...ready(), projectId: '' })
    render(<MeetingPage state={state()} id="m1" />)
    await screen.findByText('Who owns the backups?')
    expect(screen.queryByRole('button', { name: 'Add as pending' })).toBeNull()
  })
  it('decisions have no button', async () => {
    api.getMeeting.mockResolvedValue(ready())
    render(<MeetingPage state={state()} id="m1" />)
    await screen.findByText('Ship the export on Monday')
    expect(screen.getAllByRole('button', { name: 'Add as pending' })).toHaveLength(1)
  })
})
