// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import Composer from './Composer'
import type { SessionInfo } from '../proto.gen'

const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) => new Response('{}', { status: 202 }))
vi.stubGlobal('fetch', fetchMock)

const sess = (o: Partial<SessionInfo>): SessionInfo => ({
  id: 's1', recap: '', previousId: '', machine: 'm', name: 'n', cwd: '/x', root: '/x', model: '', role: 'work' as any,
  state: 'idle' as any, contextPct: 0, startedAt: 0, updatedAt: 0, transcriptPath: '', repoUrl: '', branch: '', projectId: '', launchReq: '', herdrPane: '', herdrWorkspace: '', ...o,
})

async function send(s: SessionInfo, label: string) {
  render(<Composer session={s} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } })
  fireEvent.click(screen.getByRole('button', { name: label }))
  await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  const [url, init] = fetchMock.mock.calls[0]
  return { url, body: JSON.parse(String(init?.body)) }
}

beforeEach(() => localStorage.clear())
afterEach(() => { cleanup(); fetchMock.mockClear() })

describe('Composer', () => {
  it('working: Send uses mode now', async () => {
    const r = await send(sess({ state: 'working' as any }), 'Send')
    expect(r.url).toContain('/api/sessions/s1/prompt')
    expect(r.body).toEqual({ text: 'hello', mode: 'now' })
  })
  it('idle: Send uses mode queue', async () => {
    expect((await send(sess({ state: 'idle' as any }), 'Send')).body.mode).toBe('queue')
  })
  it('Queue and Interrupt', async () => {
    expect((await send(sess({ state: 'working' as any }), 'Queue')).body.mode).toBe('queue')
    cleanup(); fetchMock.mockClear()
    expect((await send(sess({ state: 'working' as any }), 'Interrupt and send')).body.mode).toBe('interrupt')
  })
  it('renders through PromptInput', () => {
    const { container } = render(<Composer session={sess({})} />)
    expect(container.querySelector('form [data-slot=input-group] textarea')).toBeTruthy()
  })
  it('buttons are off without text and while blocked', () => {
    render(<Composer session={sess({ state: 'working' as any })} />)
    const names = ['Send', 'Queue', 'Interrupt and send']
    const off = () => names.map((n) => (screen.getByRole('button', { name: n }) as HTMLButtonElement).disabled)
    expect(off()).toEqual([true, true, true])
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hi' } })
    expect(off()).toEqual([false, false, false])
    cleanup()
    render(<Composer session={sess({ state: 'closed' as any })} />)
    expect(off()).toEqual([true, true, true])
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true)
  })
  it('Enter adds a new line; Ctrl+Enter sends', async () => {
    render(<Composer session={sess({ state: 'working' as any })} />)
    const box = screen.getByRole('textbox')
    fireEvent.change(box, { target: { value: 'hello' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await new Promise((r) => setTimeout(r, 10))
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ text: 'hello', mode: 'now' })
  })
  it('service: disabled', () => {
    render(<Composer session={sess({ role: 'service' as any })} />)
    expect(screen.getByText('Service session')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('closed', () => {
    render(<Composer session={sess({ state: 'closed' as any })} />)
    expect(screen.getByText('Session closed')).toBeTruthy()
  })
  it('keeps the draft across remount', () => {
    const s = sess({})
    const a = render(<Composer session={s} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } })
    a.unmount()
    render(<Composer session={s} />)
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('hello')
  })
  it.each(['Send', 'Queue', 'Interrupt and send'])('%s clears the draft on success', async (label) => {
    const s = sess({ state: 'working' as any })
    const a = render(<Composer session={s} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: label }))
    await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(''))
    a.unmount()
    render(<Composer session={s} />)
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('')
  })
  it('keeps the draft when sending fails', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('{"error":"boom"}', { status: 500 }))
    const s = sess({ state: 'working' as any })
    const a = render(<Composer session={s} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByRole('alert')
    a.unmount()
    render(<Composer session={s} />)
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('hello')
  })
  it('a replaced session with no draft of its own inherits the previous id draft', () => {
    localStorage.setItem('quorum.draft.old', 'carry me')
    render(<Composer session={sess({ id: 'new', previousId: 'old' })} />)
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('carry me')
    expect(localStorage.getItem('quorum.draft.new')).toBe('carry me')
    expect(localStorage.getItem('quorum.draft.old')).toBeNull()
  })
  it('its own draft is not overwritten by the previous one', () => {
    localStorage.setItem('quorum.draft.old', 'old text')
    localStorage.setItem('quorum.draft.new', 'mine')
    render(<Composer session={sess({ id: 'new', previousId: 'old' })} />)
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('mine')
  })
})
