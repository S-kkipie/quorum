// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ToolItem from './ToolItem'
import ArtifactCard from './ArtifactCard'
import StatePill from '../StatePill'
import type { AgentItem, ArtifactItem, ToolItem as Tool } from '../../lib/timeline'

afterEach(cleanup)

const EMOJI = /[\p{Extended_Pictographic}\u2600-\u27BF]/u
const tool = (o: Partial<Tool> = {}): Tool => ({ t: 'tool', seq: 1, id: 't', name: 'Bash', kind: 'bash', title: 'List files', state: 'ok', output: 'OUT-1', ...o })

describe('ToolItem', () => {
  it('tool row is collapsed by default and expands on tap', () => {
    render(<ToolItem item={tool()} />)
    const row = screen.getByRole('button', { name: /List files/ })
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('OUT-1')).toBeNull()
    fireEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('OUT-1')).toBeTruthy()
  })
  it('edit row shows -/+ lines when expanded', () => {
    render(<ToolItem item={tool({ name: 'Edit', kind: 'edit', title: 'Edited a.go', file: '/p/a.go', input: { file_path: '/p/a.go', old_string: 'same\nold line', new_string: 'same\nnew line' } })} />)
    fireEvent.click(screen.getByRole('button', { name: /Edited a\.go/ }))
    // the sign is its own coloured span: match each diff line by its whole text
    const line = (t: string) => screen.queryByText((_, el) => el?.tagName === 'DIV' && el.textContent === t)
    expect(line('- old line')).toBeTruthy()
    expect(line('+ new line')).toBeTruthy()
    expect(line('- same')).toBeNull()
  })
  it('running tool shows spinner icon, no emoji', () => {
    const { container } = render(<ToolItem item={tool({ state: 'running', output: undefined })} />)
    expect(screen.getByLabelText('running')).toBeTruthy()
    expect(container.querySelector('svg.animate-spin')).toBeTruthy()
    expect(EMOJI.test(container.textContent ?? '')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /List files/ }))
    expect(EMOJI.test(container.textContent ?? '')).toBe(false)
  })
  it('failed and denied rows carry their state icon', () => {
    render(<><ToolItem item={tool({ state: 'error', title: 'A' })} /><ToolItem item={tool({ state: 'denied', title: 'B' })} /></>)
    expect(screen.getByLabelText('failed')).toBeTruthy()
    expect(screen.getByLabelText('denied')).toBeTruthy()
  })
  it('todo row lists each task with its status', () => {
    render(<ToolItem item={tool({ name: 'TodoWrite', kind: 'todo', title: 'Updated the plan', input: { todos: [{ content: 'one', status: 'completed' }, { content: 'two', status: 'pending' }] } })} />)
    fireEvent.click(screen.getByRole('button', { name: /Updated the plan/ }))
    expect(screen.getByText('one')).toBeTruthy()
    expect(screen.getByLabelText('completed')).toBeTruthy()
    expect(screen.getByLabelText('pending')).toBeTruthy()
  })
  it('mcp row shows the input as JSON and the output', () => {
    render(<ToolItem item={tool({ name: 'mcp__x__y', kind: 'mcp', title: 'Used y (x)', input: { q: 'zz' }, output: 'RES' })} />)
    fireEvent.click(screen.getByRole('button', { name: /Used y/ }))
    expect(screen.getByText(/"q": "zz"/)).toBeTruthy()
    expect(screen.getByText('RES')).toBeTruthy()
  })
  it('an edit of a .md inside the base offers Open', () => {
    const onOpenFile = vi.fn()
    render(<ToolItem base="/p" onOpenFile={onOpenFile} item={tool({ name: 'Edit', kind: 'edit', title: 'Edited r.md', file: '/p/r.md', input: { file_path: '/p/r.md', old_string: 'a', new_string: 'b' } })} />)
    fireEvent.click(screen.getByRole('button', { name: /Edited r\.md/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(onOpenFile).toHaveBeenCalledWith('/p/r.md')
  })
  it('Open on a relative edited file passes the absolute path', () => {
    const onOpenFile = vi.fn()
    render(<ToolItem base="/p" onOpenFile={onOpenFile} item={tool({ name: 'Edit', kind: 'edit', title: 'Edited r.md', file: 'docs/./r.md', input: { file_path: 'docs/./r.md', old_string: 'a', new_string: 'b' } })} />)
    fireEvent.click(screen.getByRole('button', { name: /Edited r\.md/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(onOpenFile).toHaveBeenCalledWith('/p/docs/r.md')
  })
  it('subagent row shows its answer, or the live text while running', () => {
    const a: AgentItem = { t: 'agent', seq: 1, id: 'a', type: 'Explore', description: 'searches', status: 'running' }
    render(<ToolItem item={a} live="LIVE" />)
    expect(screen.getByLabelText('running')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /searches/ }))
    expect(screen.getByText('LIVE')).toBeTruthy()
  })
})

describe('ArtifactCard', () => {
  const art = (o: Partial<ArtifactItem> = {}): ArtifactItem => ({ t: 'artifact', seq: 1, path: '/p/docs/r.html', name: 'r.html', inBase: true, ...o })
  it('shows name, machine and folder, and Open calls onOpen', () => {
    const onOpen = vi.fn()
    render(<ArtifactCard item={art()} machine="m1" base="/p" onOpen={onOpen} />)
    expect(screen.getByText('r.html')).toBeTruthy()
    expect(screen.getByText('m1 · docs')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(onOpen).toHaveBeenCalledWith('/p/docs/r.html')
  })
  it('artifact card outside base has no Open', () => {
    render(<ArtifactCard item={art({ path: '/tmp/r.html', inBase: false })} machine="m1" base="/p" onOpen={vi.fn()} />)
    expect(screen.getByText('outside the project folder')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull()
  })
})

describe('ToolItem: background', () => {
  it('shows Running in background with a state-background spinner until the task ends', () => {
    const { container } = render(<ToolItem item={tool({ bg: { taskId: 'b1' } })} />)
    expect(screen.getByText('Running in background').className).toContain('text-state-background')
    expect(screen.getByLabelText('running in background').getAttribute('class')).toContain('animate-spin')
    expect(container.querySelector('.text-success')).toBeNull()
  })
  it('turns done, failed or stopped by the task status', () => {
    const { rerender } = render(<ToolItem item={tool({ bg: { taskId: 'b1', status: 'completed' } })} />)
    expect(screen.queryByText('Running in background')).toBeNull()
    expect(screen.getByLabelText('done')).toBeTruthy()
    rerender(<ToolItem item={tool({ bg: { taskId: 'b1', status: 'killed' } })} />)
    expect(screen.getByLabelText('failed').getAttribute('class')).toContain('text-danger')
    rerender(<ToolItem item={tool({ bg: { taskId: 'b1', status: 'stopped' } })} />)
    expect(screen.getByText('Stopped').className).toContain('text-muted-foreground')
    expect(screen.getByLabelText('stopped')).toBeTruthy()
  })
})

describe('ToolItem: background rows without a task_end', () => {
  const listed = new Set(['b1'])
  const rule = (items: Set<string> | undefined, state: string) => (id: string) => state === 'closed' || (items !== undefined && state !== 'working' && !items.has(id))
  it('idle session, task no longer listed: settled as Ended, not spinning', () => {
    const { container } = render(<ToolItem item={tool({ bg: { taskId: 'b1' } })} bgEnded={rule(new Set(), 'idle')} />)
    expect(screen.getByText('Ended').className).toContain('text-muted-foreground')
    expect(screen.queryByText('Running in background')).toBeNull()
    expect(container.querySelector('.animate-spin')).toBeNull()
  })
  it('still listed: running; working session: running; older mod (no items): running', () => {
    const { rerender } = render(<ToolItem item={tool({ bg: { taskId: 'b1' } })} bgEnded={rule(listed, 'background')} />)
    expect(screen.getByText('Running in background')).toBeTruthy()
    rerender(<ToolItem item={tool({ bg: { taskId: 'b1' } })} bgEnded={rule(new Set(), 'working')} />)
    expect(screen.getByText('Running in background')).toBeTruthy()
    rerender(<ToolItem item={tool({ bg: { taskId: 'b1' } })} bgEnded={rule(undefined, 'idle')} />)
    expect(screen.getByText('Running in background')).toBeTruthy()
  })
  it('closed session: settled even when listed', () => {
    render(<ToolItem item={tool({ bg: { taskId: 'b1' } })} bgEnded={rule(listed, 'closed')} />)
    expect(screen.getByText('Ended')).toBeTruthy()
  })
  it('background subagent row: running in background, then Ended', () => {
    const a: AgentItem = { t: 'agent', seq: 1, id: 'ag', type: 'general-purpose', description: 'Audit', status: 'running', bg: { taskId: 'ag' } }
    const { rerender } = render(<ToolItem item={a} bgEnded={() => false} />)
    expect(screen.getByText('Running in background')).toBeTruthy()
    rerender(<ToolItem item={a} bgEnded={() => true} />)
    expect(screen.getByText('Ended')).toBeTruthy()
    rerender(<ToolItem item={{ ...a, bg: { taskId: 'ag', status: 'completed' }, status: 'running' }} bgEnded={() => false} />)
    expect(screen.queryByText('Running in background')).toBeNull()
  })
})

describe('StatePill', () => {
  it('labels each state', () => {
    const label = (state: string, o = {}) => { const { container } = render(<StatePill session={{ state, unread: false, background: { tasks: 0, wakeAt: 0 }, ...o }} />); const t = container.textContent; cleanup(); return t }
    expect(label('working')).toBe('Working')
    expect(label('needs_you')).toBe('Needs you')
    expect(label('waiting')).toBe('Idle')
    expect(label('idle')).toBe('Idle')
    expect(label('idle', { unread: true })).toBe('Done · unread')
    expect(label('background', { background: { tasks: 2, wakeAt: 0 } })).toBe('2 tasks')
    expect(label('closed')).toBe('Closed')
    expect(label('background')).toBe('Background')
    const { container } = render(<StatePill session={{ state: 'background', unread: false, background: { tasks: 2, wakeAt: 0 } }} />)
    const pill = container.firstElementChild as HTMLElement
    expect(pill.getAttribute('title')).toBe('Background · 2 tasks')
    expect(pill.getAttribute('aria-label')).toBe('Background · 2 tasks')
  })
})
