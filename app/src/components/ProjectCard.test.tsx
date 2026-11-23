// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ProjectCard from './ProjectCard'
import { proj, sess } from '../lib/fixtures.test-util'

afterEach(cleanup)

describe('ProjectCard', () => {
  it('shows progress, summary, sync error, proposals and live sessions', () => {
    const onOpen = vi.fn()
    const onOpenSession = vi.fn()
    render(<ProjectCard project={proj('p1', { summary: 'Going well; blocked by the login', syncError: 'invalid token (HTTP 401)', progress: { done: 3, total: 8 } })}
      sessions={[sess('s1', { recap: 'Fixing the login', state: 'needs_you' })]} pending={2} onOpen={onOpen} onOpenSession={onOpenSession} />)
    expect(screen.getByText('3/8')).toBeTruthy()
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('3')
    expect(bar.getAttribute('aria-valuemin')).toBe('0')
    expect(bar.getAttribute('aria-valuemax')).toBe('8')
    expect(screen.getByText('Going well; blocked by the login')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('Sync error: invalid token (HTTP 401)')
    expect(screen.getByText('2 proposals')).toBeTruthy()
    expect(screen.getByText('needs you')).toBeTruthy()
    fireEvent.click(screen.getByText('Fixing the login'))
    expect(onOpenSession).toHaveBeenCalledWith('s1')
    fireEvent.click(screen.getByText('Project p1'))
    expect(onOpen).toHaveBeenCalledWith('p1')
  })
  it('without an error it shows no alert', () => {
    render(<ProjectCard project={proj('p1')} sessions={[]} pending={0} />)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(/proposal/)).toBeNull()
  })
})
