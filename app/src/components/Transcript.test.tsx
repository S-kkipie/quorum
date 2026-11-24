// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import Transcript from './Transcript'
import type { Event } from '../proto.gen'

const ev = (seq: number, kind: string, data: any): Event => ({ seq, session: 's', ts: 0, kind, data })
const evs = [
  ev(1, 'user', { text: 'hello' }),
  ev(2, 'tool_start', { id: 't1', name: 'Bash', summary: 'ls -la' }),
  ev(3, 'tool_start', { id: 't2', name: 'Read', summary: 'a.go' }),
  ev(4, 'tool_end', { id: 't1', ok: true, ms: 12, output: 'OUTPUT-ONE' }),
]
afterEach(cleanup)

describe('Transcript', () => {
  it('renders tool titles from the timeline model, without end-of-turn rows', () => {
    render(<Transcript events={[...evs, ev(5, 'turn_end', { reason: 'end', outputTokens: 9 })]} />)
    expect(screen.getByText('ls -la')).toBeTruthy()
    expect(screen.getByText('Read a.go')).toBeTruthy()
    expect(screen.queryByText(/end of turn/)).toBeNull()
  })
  it('an artifact outside the base says so', () => {
    render(<Transcript base="/p" events={[ev(1, 'tool_start', { id: 'w', name: 'Write', summary: '', input: { file_path: '/tmp/r.html' } }), ev(2, 'tool_end', { id: 'w', ok: true, ms: 1, output: '' })]} />)
    expect(screen.getByText('r.html')).toBeTruthy()
    expect(screen.getByText('outside the project folder')).toBeTruthy()
  })
  it('detail expands on tap', () => {
    render(<Transcript events={evs} />)
    expect(screen.queryByText('OUTPUT-ONE')).toBeNull()
    fireEvent.click(screen.getByText('ls -la'))
    expect(screen.getByText('OUTPUT-ONE')).toBeTruthy()
  })
  it('streaming text at the end and subagent with status', () => {
    render(<Transcript events={[ev(1, 'agent_start', { id: 'a', type: 'Explore', description: 'searches' })]} live="typing" />)
    expect(screen.getByLabelText('running')).toBeTruthy()
    expect(screen.getByText(/typing/)).toBeTruthy()
  })
  it('assistant text renders markdown heading', () => {
    render(<Transcript events={[ev(1, 'assistant', { text: '# Title\n\nbody' })]} />)
    expect(screen.getByRole('heading', { name: 'Title' })).toBeTruthy()
  })
  it('artifact Open calls onOpenFile', () => {
    const onOpenFile = vi.fn()
    render(<Transcript base="/p" onOpenFile={onOpenFile} events={[ev(1, 'tool_start', { id: 'w', name: 'Write', summary: '', input: { file_path: '/p/r.html' } }), ev(2, 'tool_end', { id: 'w', ok: true, ms: 1, output: '' })]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(onOpenFile).toHaveBeenCalledWith('/p/r.html')
  })
  it('user and assistant turns render inside message containers', () => {
    render(<Transcript events={[ev(1, 'user', { text: 'hello' }), ev(2, 'assistant', { text: 'hi there' }), ev(3, 'info', { text: 'compacted' })]} />)
    expect(screen.getByRole('log')).toBeTruthy()
    expect(screen.getByRole('article', { name: 'You' }).textContent).toContain('hello')
    expect(screen.getByRole('article', { name: 'Claude' }).textContent).toContain('hi there')
    expect(screen.getByRole('note').textContent).toBe('compacted')
  })
  it('a tool row is a collapsed disclosure that expands on click', () => {
    render(<Transcript events={evs} />)
    const row = screen.getByRole('button', { name: /ls -la/ })
    expect(row.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('OUTPUT-ONE')).toBeTruthy()
  })
  it('a remote image in assistant text never renders an img', () => {
    const { container } = render(<Transcript events={[ev(1, 'assistant', { text: '![x](https://example.com/a.png)' })]} />)
    expect(container.querySelector('img')).toBeNull()
    const a = container.querySelector('a[href="https://example.com/a.png"]')!
    expect(a.textContent).toBe('[image: x]')
    expect(a.getAttribute('rel')).toBe('noopener noreferrer')
  })
  it('working without streamed text shows the working indicator', () => {
    const { rerender } = render(<Transcript events={evs} />)
    expect(screen.queryByRole('status')).toBeNull()
    rerender(<Transcript events={evs} working />)
    expect(screen.getByRole('status').textContent).toBe('Working…')
    rerender(<Transcript events={[...evs, ev(5, 'thinking', {})]} working />)
    expect(screen.getByRole('status').textContent).toBe('Thinking…')
    rerender(<Transcript events={evs} working live="typing" />)
    expect(screen.queryByRole('status')).toBeNull()
  })
  it('scrolling near the top loads earlier events, unless autoLoad is off', () => {
    const onLoadMore = vi.fn()
    const { rerender } = render(<Transcript events={evs} hasMore onLoadMore={onLoadMore} />)
    const scroller = screen.getByRole('log').firstElementChild as HTMLElement
    scroller.scrollTop = 0
    fireEvent.scroll(scroller)
    expect(onLoadMore).toHaveBeenCalledTimes(1)
    rerender(<Transcript events={evs} hasMore autoLoad={false} onLoadMore={onLoadMore} />)
    fireEvent.scroll(scroller)
    expect(onLoadMore).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier' }))
    expect(onLoadMore).toHaveBeenCalledTimes(2)
  })
})
