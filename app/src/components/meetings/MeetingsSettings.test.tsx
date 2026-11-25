// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const api = vi.hoisted(() => ({ getMeetingSettings: vi.fn(), putMeetingSettings: vi.fn(), meetingDisk: vi.fn(), listMeetings: vi.fn() }))
vi.mock('../../lib/meetingsApi', async (orig) => ({ ...(await orig<typeof import('../../lib/meetingsApi')>()), ...api }))
import MeetingsSettings, { workerState } from './MeetingsSettings'
import { initialState, reduce, type AppState } from '../../lib/store'
import type { Envelope } from '../../proto.gen'

const settings = { provider: 'openai-compatible', model: 'some-model', baseUrl: 'https://llm.example.com/v1', language: 'es', aliases: ['Alex', 'Al'], hasKey: true }
const machine = (name: string, online: boolean, meetingWorker: string, transcribe = false) =>
  ({ name, os: 'linux', env: 'wsl', version: '', online, lastSeen: 0, caps: { herdr: false, terminal: false, root: false, transcribe, meetingWorker } })
const state = (): AppState => ({ ...initialState(), machines: { laptop: machine('laptop', true, 'ready', true), vps: machine('vps', true, ''), old: machine('old', false, 'no_gpu') } })

beforeEach(() => {
  api.getMeetingSettings.mockResolvedValue(settings)
  api.meetingDisk.mockResolvedValue({ audioBytes: 1.5 * 1024 ** 3, freeBytes: 40 * 1024 ** 3 })
  api.listMeetings.mockResolvedValue([])
})
afterEach(() => { for (const f of Object.values(api)) f.mockReset() })

describe('Settings → Meetings', () => {
  it('the API key is write-only: never shown, sent only when typed, cleared after saving', async () => {
    const SECRET = 'sk-test-0123456789'
    api.putMeetingSettings.mockImplementation(async (b) => ({ ...settings, ...b, key: undefined, hasKey: true }))
    render(<MeetingsSettings state={state()} />)
    const key = await screen.findByLabelText(/API key/) as HTMLInputElement
    expect(key.type).toBe('password')
    expect(key.value).toBe('')
    expect(key.placeholder).toBe('Saved')
    // a save without typing a key keeps the stored one
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.putMeetingSettings).toHaveBeenCalledTimes(1))
    expect(api.putMeetingSettings.mock.calls[0][0]).not.toHaveProperty('key')
    expect(api.putMeetingSettings.mock.calls[0][0]).toMatchObject({ provider: 'openai-compatible', model: 'some-model', baseUrl: 'https://llm.example.com/v1', language: 'es', aliases: ['Alex', 'Al'] })
    fireEvent.change(key, { target: { value: SECRET } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.putMeetingSettings).toHaveBeenCalledTimes(2))
    expect(api.putMeetingSettings.mock.calls[1][0]).toMatchObject({ key: SECRET })
    await waitFor(() => expect((screen.getByLabelText(/API key/) as HTMLInputElement).value).toBe(''))
    expect(document.body.innerHTML).not.toContain(SECRET)
    // Remove key sends ""
    fireEvent.click(screen.getByRole('button', { name: 'Remove key' }))
    await waitFor(() => expect(api.putMeetingSettings).toHaveBeenCalledTimes(3))
    expect(api.putMeetingSettings.mock.calls[2][0]).toEqual({ key: '' })
  })

  it('the base URL and key only show for the OpenAI-compatible provider; names are split on commas', async () => {
    api.getMeetingSettings.mockResolvedValue({ ...settings, provider: 'local', hasKey: false })
    api.putMeetingSettings.mockImplementation(async (b) => ({ ...settings, ...b }))
    render(<MeetingsSettings state={state()} />)
    await waitFor(() => expect((screen.getByLabelText('Summary provider') as HTMLSelectElement).value).toBe('local'))
    expect(screen.queryByLabelText(/API key/)).toBeNull()
    expect(screen.queryByLabelText('Base URL')).toBeNull()
    fireEvent.change(screen.getByLabelText(/Names I go by/), { target: { value: ' Alex ,, Al, Alejandro ' } })
    fireEvent.change(screen.getByLabelText('Default language'), { target: { value: 'auto' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.putMeetingSettings).toHaveBeenCalled())
    expect(api.putMeetingSettings.mock.calls[0][0]).toMatchObject({ provider: 'local', language: 'auto', aliases: ['Alex', 'Al', 'Alejandro'] })
    expect(await screen.findByRole('status')).toBeTruthy()
  })

  it('shows each machine\'s worker, the hub disk and the unassigned inbox', async () => {
    api.listMeetings.mockResolvedValue([{ id: 'm9', projectId: '', title: 'Hallway chat', startedAt: 0, durationS: 600, language: '', status: 'ready', progress: 100, error: '', provider: '', createdAt: 1, updatedAt: 1, hasAudio: true, audioBytes: 1, channels: '', speakerCount: 0 }])
    const onOpen = vi.fn()
    let s = state()
    const { rerender } = render(<MeetingsSettings state={s} onOpenMeeting={onOpen} />)
    const workers = screen.getByRole('list', { name: 'Transcription workers' })
    expect(within(workers).getByText('laptop').parentElement!.textContent).toContain('Ready')
    expect(within(workers).getByText('vps').parentElement!.textContent).toContain('Not set up')
    expect(within(workers).getByText('old').parentElement!.textContent).toContain('no CUDA GPU')
    expect(await screen.findByText(/Meeting audio uses 1.5 GB; 40.0 GB free/)).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: /Hallway chat/ }))
    expect(onOpen).toHaveBeenCalledWith('m9')
    expect(api.listMeetings).toHaveBeenCalledWith({ unassigned: true, projectId: undefined })
    // a meeting_changed refetches the inbox
    s = reduce(s, { type: 'meeting_changed', payload: { id: 'm9', projectId: 'p1', status: 'ready' } } as unknown as Envelope)
    rerender(<MeetingsSettings state={s} onOpenMeeting={onOpen} />)
    await waitFor(() => expect(api.listMeetings).toHaveBeenCalledTimes(2))
  })

  it('workerState reads the caps', () => {
    expect(workerState(undefined).ok).toBe(false)
    expect(workerState({ meetingWorker: 'ready', transcribe: true }).ok).toBe(true)
    expect(workerState({ meetingWorker: 'incomplete' }).text).toMatch(/did not finish/)
  })
})
