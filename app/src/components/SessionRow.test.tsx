// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import SessionRowView from './SessionRow'
import { sess } from '../lib/fixtures.test-util'
import * as api from '../lib/api'

vi.mock('../lib/api', () => ({ closeSession: vi.fn() }))
const close = vi.mocked(api.closeSession)
beforeEach(() => close.mockResolvedValue(undefined as never))
afterEach(() => { cleanup(); close.mockReset() })

const live = (o = {}) => ({ kind: 'live' as const, id: 's1', session: sess('s1', o) })
const openMenu = () => fireEvent.keyDown(screen.getByRole('button', { name: 'Session actions' }), { key: 'Enter' })

describe('SessionRowView close action', () => {
  it('confirm dialog, then closes once', async () => {
    render(<ul><SessionRowView row={live()} /></ul>)
    openMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Close session' }))
    expect(await screen.findByText('Close this session? Claude stops in its terminal.')).toBeTruthy()
    expect(close).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1))
    expect(close).toHaveBeenCalledWith('s1')
  })
  it('body pointer-events are restored after the menu-opened dialog closes', async () => {
    render(<ul><SessionRowView row={live()} /></ul>)
    openMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Close session' }))
    await screen.findByText('Close this session? Claude stops in its terminal.')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(document.body.style.pointerEvents).not.toBe('none'))
  })
  it('Cancel does not close', async () => {
    render(<ul><SessionRowView row={live()} /></ul>)
    openMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Close session' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(close).not.toHaveBeenCalled()
  })
  it('errors show inline on the row', async () => {
    close.mockRejectedValue(new Error('boom'))
    render(<ul><SessionRowView row={live()} /></ul>)
    openMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Close session' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }))
    expect((await screen.findByRole('alert')).textContent).toContain('boom')
  })
  it('service and closed rows have no action', () => {
    render(<ul><SessionRowView row={live({ role: 'service' })} /></ul>)
    expect(screen.queryByRole('button', { name: 'Session actions' })).toBeNull()
    cleanup()
    render(<ul><SessionRowView row={{ kind: 'closed', id: 'c1', machine: 'vps-1', root: '/r', title: 'Old', updatedAt: 1, messages: 2 }} /></ul>)
    expect(screen.queryByRole('button', { name: 'Session actions' })).toBeNull()
  })
})

describe('SessionRowView closed row', () => {
  const closed = (messages: number) => ({ kind: 'closed' as const, id: 'c1', machine: 'm', root: '/r', title: 'Old chat', updatedAt: Date.now(), messages })
  it('pluralizes the message count', () => {
    const { unmount } = render(<ul><SessionRowView row={closed(1)} /></ul>)
    expect(screen.getByText(/· 1 message$/)).toBeTruthy()
    unmount()
    render(<ul><SessionRowView row={closed(5)} /></ul>)
    expect(screen.getByText(/· 5 messages$/)).toBeTruthy()
  })
  it('omits the count when unknown', () => {
    render(<ul><SessionRowView row={closed(0)} /></ul>)
    expect(screen.queryByText(/message/)).toBeNull()
  })
})

describe('SessionRowView state', () => {
  it('shows Done · unread with a green unread dot', () => {
    render(<ul><SessionRowView row={live({ state: 'idle', unread: true })} /></ul>)
    expect(screen.getByText('Done · unread')).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Unread' }).className).toContain('bg-emerald-500')
  })
  it('no unread dot for a seen idle session', () => {
    render(<ul><SessionRowView row={live({ state: 'idle' })} /></ul>)
    expect(screen.getByText('Idle')).toBeTruthy()
    expect(screen.queryByRole('img', { name: 'Unread' })).toBeNull()
  })
  it('background shows its detail', () => {
    render(<ul><SessionRowView row={live({ state: 'background', background: { tasks: 2, wakeAt: 0 } })} /></ul>)
    expect(screen.getByText('Background')).toBeTruthy()
    expect(screen.getByText('2 tasks')).toBeTruthy()
  })
})
