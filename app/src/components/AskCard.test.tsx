// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import AskCard from './AskCard'
import type { Ask } from '../proto.gen'

const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) => new Response('{}', { status: 200 }))
vi.stubGlobal('fetch', fetchMock)
beforeEach(() => localStorage.clear())
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
  it('permission renders as a confirmation and the first choice wins', async () => {
    render(<AskCard session="s1" ask={perm} />)
    const card = screen.getByRole('group', { name: 'Permission request' })
    expect(card.getAttribute('data-slot')).toBe('alert')
    expect(card.textContent).toContain('ls -la /')
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    await screen.findByText('Denied')
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(body()).toEqual({ askId: 'a1', decision: 'deny' })
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
  it('free text persists across remount under ask.<askId> and clears on submit', async () => {
    const ask: Ask = { ...perm, kind: 'question', tool: 'AskUserQuestion', questions: [{ question: 'Free', options: [{ label: 'X' }] }] as any }
    const a = render(<AskCard session="s1" ask={ask} />)
    fireEvent.change(screen.getByLabelText('Other: Free'), { target: { value: 'draft text' } })
    a.unmount()
    expect(localStorage.getItem('quorum.draft.ask.a1')).toContain('draft text')
    render(<AskCard session="s1" ask={ask} />)
    expect((screen.getByLabelText('Other: Free') as HTMLInputElement).value).toBe('draft text')
    fireEvent.click(screen.getByRole('button', { name: 'Send answers' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await waitFor(() => expect(localStorage.getItem('quorum.draft.ask.a1')).toBeNull())
  })
  it('keeps the free text when submit fails', async () => {
    fetchMock.mockImplementation(async () => new Response('{"error":"boom"}', { status: 500 }))
    const ask: Ask = { ...perm, kind: 'question', tool: 'AskUserQuestion', questions: [{ question: 'Free', options: [{ label: 'X' }] }] as any }
    const a = render(<AskCard session="s1" ask={ask} />)
    fireEvent.change(screen.getByLabelText('Other: Free'), { target: { value: 'keep me' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send answers' }))
    await screen.findByRole('alert')
    a.unmount()
    expect(localStorage.getItem('quorum.draft.ask.a1')).toContain('keep me')
  })
  describe('long text clamp', () => {
    const long = Array.from({ length: 20 }, (_, i) => `echo line ${i}`).join('\n')
    it('long command is clamped with Show all, toggle expands', () => {
      render(<AskCard session="s1" ask={{ ...perm, detail: long }} />)
      const pre = screen.getByText(/echo line 0/)
      expect(pre.className).toContain('line-clamp-8')
      fireEvent.click(screen.getByRole('button', { name: 'Show all' }))
      expect(pre.className).not.toContain('line-clamp-8')
      expect(pre.className).toContain('max-h-[50dvh]')
      fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
      expect(pre.className).toContain('line-clamp-8')
    })
    it('long single-line text (over 600 chars) gets a toggle', () => {
      render(<AskCard session="s1" ask={{ ...perm, detail: 'x'.repeat(700) }} />)
      expect(screen.getByRole('button', { name: 'Show all' })).toBeTruthy()
    })
    it('short command has no toggle', () => {
      render(<AskCard session="s1" ask={perm} />)
      expect(screen.queryByRole('button', { name: 'Show all' })).toBeNull()
    })
    it('actions are sticky and decide fires exactly once', async () => {
      render(<AskCard session="s1" ask={{ ...perm, detail: long }} />)
      const allow = screen.getByRole('button', { name: 'Allow' })
      expect(allow.parentElement!.className).toContain('sticky')
      expect(allow.parentElement!.className).toContain('bottom-0')
      fireEvent.click(allow)
      fireEvent.click(allow)
      await screen.findByText('Allowed')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
    it('question prompt is clamped when long', () => {
      const ask: Ask = { ...perm, kind: 'question', tool: 'AskUserQuestion', questions: [{ question: long, options: [{ label: 'A' }] }] as any }
      render(<AskCard session="s1" ask={ask} />)
      expect(screen.getByRole('button', { name: 'Show all' })).toBeTruthy()
    })
  })
})
