// @vitest-environment jsdom
import { lazy } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import LazyBoundary from './LazyBoundary'

afterEach(cleanup)

describe('LazyBoundary', () => {
  it('a failed chunk shows a message and a Reload button instead of unmounting', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const reload = vi.fn()
    vi.stubGlobal('location', { ...window.location, reload })
    const Broken = lazy(() => Promise.reject(new Error('Failed to fetch dynamically imported module')))
    render(<div><p>shell</p><LazyBoundary><Broken /></LazyBoundary></div>)
    expect(await screen.findByText('This view could not load.')).toBeTruthy()
    expect(screen.getByText('shell')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(reload).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
  it('renders the lazy view when it loads', async () => {
    const Ok = lazy(async () => ({ default: () => <p>loaded</p> }))
    render(<LazyBoundary><Ok /></LazyBoundary>)
    expect(await screen.findByText('loaded')).toBeTruthy()
  })
})
