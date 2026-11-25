// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import BottomNav from './BottomNav'

afterEach(cleanup)

describe('BottomNav', () => {
  it('has Sessions, Projects and Settings with 44 px targets, on the safe area', () => {
    render(<BottomNav active="sessions" onNav={vi.fn()} />)
    const nav = screen.getByRole('navigation', { name: 'Main' })
    expect(nav.className).toContain('safe-area-inset-bottom')
    const buttons = screen.getAllByRole('button')
    expect(buttons.map((b) => b.textContent)).toEqual(['Sessions', 'Projects', 'Settings'])
    for (const b of buttons) expect(b.className).toMatch(/min-h-1[1-9]/)
    expect(screen.getByRole('button', { name: 'Sessions' }).getAttribute('aria-current')).toBe('page')
  })
  it('navigates and shows the attention count', () => {
    const onNav = vi.fn()
    render(<BottomNav active="projects" attention={3} onNav={onNav} />)
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(onNav).toHaveBeenCalledWith('settings')
    expect(screen.getByRole('button', { name: 'Sessions, 3 need attention' })).toBeTruthy()
  })
})
