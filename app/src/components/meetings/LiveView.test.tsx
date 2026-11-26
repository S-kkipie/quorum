// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { Meeting, MeetingLiveState, MeetingSegment } from '../../proto.gen'

const api = vi.hoisted(() => ({ stopLiveMeeting: vi.fn() }))
const rec = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('../../lib/meetingsApi', async (orig) => ({ ...(await orig<typeof import('../../lib/meetingsApi')>()), ...api }))
vi.mock('../../lib/liveRecorder', () => ({ currentRecording: () => rec.current }))
import LiveView from './LiveView'
import { initialState, type AppState } from '../../lib/store'

const m = { id: 'm1', projectId: '', title: 'Standup', startedAt: Date.now() - 65_000, status: 'live' } as Meeting
const seg = (startMs: number, text: string): MeetingSegment => ({ startMs, endMs: startMs + 1000, speaker: '', text })
const live = (o: Partial<MeetingLiveState> = {}): MeetingLiveState => ({ slices: 1, bytes: 10, throughMs: 0, lastSliceAt: 1, waiting: false, ...o })
const withText = (segments: MeetingSegment[], l: MeetingLiveState): AppState => ({ ...initialState(), meetingText: { m1: { segments, live: l } } })

afterEach(() => { api.stopLiveMeeting.mockReset(); rec.current = null })

describe('LiveView', () => {
  it('renders the segments', () => {
    render(<LiveView state={withText([seg(0, 'hello there'), seg(5000, 'second line')], live())} m={m} onStopped={() => {}} />)
    expect(screen.getByText('hello there')).toBeTruthy()
    expect(screen.getByText('second line')).toBeTruthy()
  })
  it('says which machine the transcription waits for, offline ones included', () => {
    const s = withText([], live({ waiting: true }))
    s.machines = { laptop: { name: 'laptop', online: false, caps: { transcribe: true } }, nas: { name: 'nas', online: true, caps: {} } } as unknown as AppState['machines']
    render(<LiveView state={s} m={m} onStopped={() => {}} />)
    expect(screen.getByText('Transcription waiting for laptop')).toBeTruthy()
  })
  it('without a recording here, Stop and process forces the stop', async () => {
    const stopped = { ...m, status: 'queued' }
    api.stopLiveMeeting.mockResolvedValue(stopped)
    const onStopped = vi.fn()
    render(<LiveView state={withText([], live())} m={m} onStopped={onStopped} />)
    expect(screen.getByText('Recording on another device, or interrupted. Stop it to process what arrived.')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stop and process' })) })
    expect(api.stopLiveMeeting).toHaveBeenCalledWith('m1', { slices: 0, force: true })
    expect(onStopped).toHaveBeenCalledWith(stopped)
  })
  it('on the recording device, Stop calls the recorder', async () => {
    const stop = vi.fn().mockResolvedValue({ ...m, status: 'queued' })
    rec.current = { meetingId: 'm1', startedAt: 1, state: 'recording', error: '', pending: 0, lastError: 'disk full', subscribe: () => () => {}, stop }
    render(<LiveView state={withText([], live())} m={m} onStopped={() => {}} />)
    expect(screen.getByText('Upload retrying: disk full')).toBeTruthy()
    expect(screen.queryByText('Stop and process')).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stop' })) })
    expect(stop).toHaveBeenCalled()
    expect(api.stopLiveMeeting).not.toHaveBeenCalled()
  })
  it('shows the pending uploads while stopping', () => {
    rec.current = { meetingId: 'm1', startedAt: 1, state: 'stopping', error: '', pending: 3, lastError: '', subscribe: () => () => {}, stop: vi.fn() }
    render(<LiveView state={withText([], live())} m={m} onStopped={() => {}} />)
    expect(screen.getByText(/Finishing the upload… \(3 left\)/)).toBeTruthy()
  })
  it('scrolls down on a new segment only when the view was at the bottom', () => {
    const { container, rerender } = render(<LiveView state={withText([seg(0, 'one')], live())} m={m} onStopped={() => {}} />)
    const box = container.querySelector('[data-testid="live-transcript"]') as HTMLElement
    Object.defineProperty(box, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(box, 'clientHeight', { configurable: true, value: 200 })
    box.scrollTop = 800
    fireEvent.scroll(box)
    rerender(<LiveView state={withText([seg(0, 'one'), seg(2000, 'two')], live())} m={m} onStopped={() => {}} />)
    expect(box.scrollTop).toBe(1000)
    box.scrollTop = 100
    fireEvent.scroll(box)
    rerender(<LiveView state={withText([seg(0, 'one'), seg(2000, 'two'), seg(4000, 'three')], live())} m={m} onStopped={() => {}} />)
    expect(box.scrollTop).toBe(100)
  })
})
