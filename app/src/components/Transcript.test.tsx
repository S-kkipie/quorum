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
})
