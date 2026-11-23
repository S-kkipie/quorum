// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import AskCard from './AskCard'
import type { Ask } from '../proto.gen'

const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) => new Response('{}', { status: 200 }))
vi.stubGlobal('fetch', fetchMock)
afterEach(() => { cleanup(); fetchMock.mockReset(); fetchMock.mockImplementation(async () => new Response('{}')) })

const perm: Ask = { askId: 'a1', kind: 'permission', tool: 'Bash', summary: 'ls -la', detail: 'ls -la /', questions: null as any }
const body = () => JSON.parse(String(fetchMock.mock.calls[0][1]?.body))

describe('AskCard', () => {
  it('permission: Allow and Deny', async () => {
    render(<AskCard session="s1" ask={perm} />)
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(fetchMock.mock.calls[0][0]).toContain('/api/sessions/s1/decide')
    expect(body()).toEqual({ askId: 'a1', decision: 'allow' })
  })
  it('question: sends answers (multi with comma, and Other)', async () => {
    const ask: Ask = { ...perm, kind: 'question', tool: 'AskUserQuestion', questions: [
      { question: 'Color', options: [{ label: 'Red' }, { label: 'Blue' }] },
      { question: 'Extras', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] },
      { question: 'Free', options: [{ label: 'X' }] },
    ] as any }
    render(<AskCard session="s1" ask={ask} />)
    fireEvent.click(screen.getByLabelText('Blue'))
    fireEvent.click(screen.getByLabelText('A'))
    fireEvent.click(screen.getByLabelText('B'))
    fireEvent.change(screen.getByLabelText('Other: Free'), { target: { value: 'something else' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send answers' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(body()).toEqual({ askId: 'a1', decision: 'allow', answers: { Color: 'Blue', Extras: 'A, B', Free: 'something else' } })
  })
  it('409 shows "already answered" and closes', async () => {
    fetchMock.mockImplementation(async () => new Response('{"error":"already answered"}', { status: 409 }))
    const done = vi.fn()
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    render(<AskCard session="s1" ask={perm} onDone={done} />)
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    await vi.waitFor(() => expect(screen.getByText('already answered')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull()
    vi.advanceTimersByTime(2100)
    expect(done).toHaveBeenCalled()
    vi.useRealTimers()
  })
})
