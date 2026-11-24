// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import ProjectCard from './ProjectCard'
import { proj, sess } from '../lib/fixtures.test-util'

afterEach(cleanup)

describe('ProjectCard', () => {
  it('shows summary, sync error, proposals and live sessions', () => {
    const onOpen = vi.fn()
    const onOpenSession = vi.fn()
    render(<ProjectCard project={proj('p1', { summary: 'Going well; blocked by the login', syncError: 'invalid token (HTTP 401)' })}
      sessions={[sess('s1', { recap: 'Fixing the login', state: 'needs_you' })]} pending={2} onOpen={onOpen} onOpenSession={onOpenSession} />)
    expect(screen.queryByRole('progressbar')).toBeNull()
    const summary = screen.getByText('Going well; blocked by the login')
    expect(summary.className).toContain('line-clamp-2')
    expect(summary.className).not.toMatch(/(^|\s)block(\s|$)/)
    expect(screen.getByRole('alert').textContent).toContain('Sync error: invalid token (HTTP 401)')
    expect(screen.getByText('2 proposals')).toBeTruthy()
    expect(screen.getByText('Needs you')).toBeTruthy()
    fireEvent.click(screen.getByText('Fixing the login'))
    expect(onOpenSession).toHaveBeenCalledWith('s1')
    fireEvent.click(screen.getByText('Project p1'))
    expect(onOpen).toHaveBeenCalledWith('p1')
  })
  it('never mentions ticket sources', () => {
    render(<ProjectCard project={proj('p1', { connector: { kind: 'none', settings: {}, hasToken: false, intervalMin: 0 } })} sessions={[]} pending={0} />)
    expect(screen.queryByText('No ticket source.')).toBeNull()
    expect(screen.queryByRole('progressbar')).toBeNull()
  })
  it('without an error it shows no alert; one proposal is singular', () => {
    render(<ProjectCard project={proj('p1')} sessions={[]} pending={1} />)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('1 proposal')).toBeTruthy()
  })
  it('shows up to 3 sessions and a "+N more" line', () => {
    const list = [1, 2, 3, 4, 5].map((i) => sess('s' + i, { recap: 'Task ' + i }))
    render(<ProjectCard project={proj('p1')} sessions={list} pending={0} />)
    expect(screen.getAllByText(/^Task /)).toHaveLength(3)
    expect(screen.getByText('+2 more')).toBeTruthy()
  })
  it('shows the last activity line only when known', () => {
    const { rerender } = render(<ProjectCard project={proj('p1')} sessions={[]} pending={0} lastActivity={Date.now() - 5 * 60000} />)
    expect(screen.getByText('Last activity 5 min ago')).toBeTruthy()
    rerender(<ProjectCard project={proj('p1')} sessions={[]} pending={0} lastActivity={0} />)
    expect(screen.queryByText(/Last activity/)).toBeNull()
  })
  it('orders by attention and marks unread done', () => {
    render(<ProjectCard project={proj('p1')} pending={0} sessions={[
      sess('b', { recap: 'Bg one', state: 'background', background: { tasks: 1, wakeAt: 0 } }),
      sess('d', { recap: 'Done one', unread: true }), sess('n', { recap: 'Need one', state: 'needs_you' }),
    ]} />)
    const rows = screen.getAllByRole('listitem').map((x) => x.textContent)
    expect(rows[0]).toContain('Need one')
    expect(rows[1]).toContain('Done one')
    expect(rows[2]).toContain('Bg one')
    expect(rows[2]).toContain('1 task')
    expect(rows[2]).not.toContain('Background')
    expect(screen.getByTitle('Background · 1 task').className).toMatch(/min-w-0 truncate/)
    expect(screen.getByRole('img', { name: 'Unread sessions' })).toBeTruthy()
  })
  it('a wake-up label turns into "waking up" when its time passes', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(2026, 0, 5, 10, 0, 30))
      render(<ProjectCard project={proj('p1')} pending={0} sessions={[
        sess('b', { recap: 'Bg', state: 'background', background: { tasks: 0, wakeAt: new Date(2026, 0, 5, 10, 2).getTime() } })]} />)
      expect(screen.getByText('wakes 10:02')).toBeTruthy()
      await act(() => vi.advanceTimersByTimeAsync(60_000))
      expect(screen.getByText('wakes 10:02')).toBeTruthy()
      await act(() => vi.advanceTimersByTimeAsync(31_000))
      expect(screen.getByText('waking up')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })
  it('no unread marker without a done session', () => {
    render(<ProjectCard project={proj('p1')} pending={0} sessions={[sess('i')]} />)
    expect(screen.queryByRole('img', { name: 'Unread sessions' })).toBeNull()
  })
})
