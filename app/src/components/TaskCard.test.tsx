// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import TaskCard from './TaskCard'
import Transcript from './Transcript'
import type { TaskEndItem } from '../lib/timeline'

afterEach(cleanup)
const item = (o: Partial<TaskEndItem> = {}): TaskEndItem => ({ t: 'task_end', seq: 1, taskId: 'b1', kind: 'command', summary: 'npm test', status: 'completed', ...o })

describe('TaskCard', () => {
  it('finished: title, summary and exit code', () => {
    render(<TaskCard item={item({ exitCode: 0 })} />)
    expect(screen.getByRole('note').textContent).toBe('Background task finished · exit 0npm test')
    expect(screen.getByText('npm test').getAttribute('title')).toBe('npm test')
  })
  it('failed and killed use the error tone; stopped is muted', () => {
    const { container, rerender } = render(<TaskCard item={item({ status: 'failed', exitCode: 2 })} />)
    expect(screen.getByRole('note', { name: 'Background task failed' }).className).toContain('border-danger')
    rerender(<TaskCard item={item({ status: 'killed' })} />)
    expect(screen.getByRole('note', { name: 'Background task was killed' })).toBeTruthy()
    rerender(<TaskCard item={item({ status: 'stopped' })} />)
    expect(screen.getByRole('note', { name: 'Background task stopped' }).className).not.toContain('border-danger')
    expect(container.querySelector('.text-muted-foreground')).toBeTruthy()
  })
  it('a short output tail shows in full; a long one collapses to the last 6 lines', () => {
    const tail = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
    const { container, rerender } = render(<TaskCard item={item({ outputTail: 'a\nb' })} />)
    expect(screen.queryByRole('button')).toBeNull()
    rerender(<TaskCard item={item({ outputTail: tail })} />)
    const pre = container.querySelector('pre')!
    expect(pre.textContent?.split('\n')).toHaveLength(6)
    expect(pre.textContent).toContain('line 20')
    expect(pre.textContent).not.toContain('line 1\n')
    fireEvent.click(screen.getByRole('button', { name: /Show all 20 lines/ }))
    expect(pre.textContent?.split('\n')).toHaveLength(20)
    expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe('true')
  })
  it('long unbreakable summaries clamp and wrap anywhere', () => {
    render(<TaskCard item={item({ summary: 'x'.repeat(500) })} />)
    const s = screen.getByTitle('x'.repeat(500))
    expect(s.className).toContain('line-clamp-2')
    expect(s.className).toContain('overflow-wrap:anywhere')
  })
  it('the timeline renders task_end as a card, not a user bubble', () => {
    render(<Transcript events={[{ seq: 1, session: 's', ts: 1, kind: 'task_end', data: { taskId: 'b1', kind: 'command', summary: 'npm test', status: 'completed', exitCode: 0 } }]} />)
    expect(screen.getByRole('note', { name: 'Background task finished' })).toBeTruthy()
  })
})
