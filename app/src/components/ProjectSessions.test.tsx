// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ProjectSessions from './ProjectSessions'
import { initialState, setCheckouts, setConversations, type AppState } from '../lib/store'
import { proj, sess } from '../lib/fixtures.test-util'
import * as api from '../lib/api'

vi.mock('../lib/api', () => ({ listConversations: vi.fn() }))
const list = vi.mocked(api.listConversations)
afterEach(() => { cleanup(); list.mockReset() })

const conv = (i: number, o: Record<string, unknown> = {}) => ({ id: 'c' + i, title: 'Conv ' + i, firstPrompt: '', messages: i, updatedAt: Date.now() - i * 60000, open: false, ...o })
const caps = { herdr: false, terminal: false, root: false }
const mach = (name: string, o: Record<string, unknown> = {}) => ({ name, os: 'linux', env: 'linux', version: '', online: true, lastSeen: 0, caps, ...o })

function base(machines: Record<string, any> = { 'vps-1': mach('vps-1'), laptop: mach('laptop') }): AppState {
  let s = setCheckouts(initialState(), 'p1', [
    { id: 'k1', projectId: 'p1', machine: 'vps-1', root: '/r', repoUrl: '', branch: '', updatedAt: 1 },
    { id: 'k2', projectId: 'p1', machine: 'laptop', root: '/l', repoUrl: '', branch: '', updatedAt: 1 },
  ])
  s = { ...s, projects: { p1: proj('p1') }, machines }
  return s
}

function Harness({ initial, busy = false, onResume = vi.fn(), onOpen = vi.fn() }: { initial: AppState; busy?: boolean; onResume?: (r: any) => void; onOpen?: (id: string) => void }) {
  const [s, setS] = useState(initial)
  return <ProjectSessions state={s} projectId="p1" busy={busy} onOpen={onOpen} onResume={onResume} onConversations={(m, r, l) => setS((x) => setConversations(x, m, r, l))} />
}

describe('ProjectSessions', () => {
  it('live rows come first, then closed rows from every checkout', async () => {
    list.mockImplementation(async (m) => (m === 'vps-1' ? [conv(1)] : [conv(2)]) as any)
    const s = { ...base(), sessions: { a: sess('a', { name: 'live-a', machine: 'vps-1' }) }, order: ['a'] }
    render(<Harness initial={s} />)
    await screen.findByText('Conv 2')
    const items = screen.getAllByRole('listitem').map((li) => li.textContent ?? '')
    expect(items[0]).toContain('live-a')
    expect(items[1]).toContain('Conv 1')
    expect(items[2]).toContain('Conv 2')
    expect(list).toHaveBeenCalledWith('vps-1', '/r')
    expect(list).toHaveBeenCalledWith('laptop', '/l')
  })
  it('one failing checkout shows its error and keeps the other rows', async () => {
    list.mockImplementation(async (m) => { if (m === 'laptop') throw new Error('boom'); return [conv(1)] as any })
    render(<Harness initial={base()} />)
    expect(await screen.findByText('laptop: could not list conversations')).toBeTruthy()
    expect(screen.getByText('Conv 1')).toBeTruthy()
  })
  it('machine without caps asks to update quorumd and is not queried', async () => {
    list.mockResolvedValue([conv(1)] as any)
    render(<Harness initial={base({ 'vps-1': mach('vps-1'), laptop: mach('laptop', { caps: undefined }) })} />)
    expect(await screen.findByText('Update quorumd on laptop to see its conversations')).toBeTruthy()
    await screen.findByText('Conv 1')
    expect(list).not.toHaveBeenCalledWith('laptop', '/l')
  })
  it('shows 8 closed rows of 10; See all expands with a search box', async () => {
    list.mockImplementation(async (m) => (m === 'vps-1' ? Array.from({ length: 10 }, (_, i) => conv(i + 1)) : []) as any)
    render(<Harness initial={base()} />)
    await screen.findByText('Conv 1')
    expect(screen.getAllByRole('listitem')).toHaveLength(8)
    fireEvent.click(screen.getByText('See all (10)'))
    expect(screen.getAllByRole('listitem')).toHaveLength(10)
    fireEvent.change(screen.getByLabelText('Search by title'), { target: { value: 'conv 10' } })
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
  })
  it('See all pages the closed rows by 100; search renders at most 100 matches', async () => {
    list.mockImplementation(async (m) => (m === 'vps-1' ? Array.from({ length: 250 }, (_, i) => conv(i + 1)) : []) as any)
    render(<Harness initial={base()} />)
    await screen.findByText('Conv 1')
    fireEvent.click(screen.getByText('See all (250)'))
    expect(screen.getAllByRole('listitem')).toHaveLength(100)
    fireEvent.click(screen.getByText('Show more (150 left)'))
    expect(screen.getAllByRole('listitem')).toHaveLength(200)
    fireEvent.click(screen.getByText('Show more (50 left)'))
    expect(screen.getAllByRole('listitem')).toHaveLength(250)
    expect(screen.queryByText(/Show more/)).toBeNull()
    fireEvent.change(screen.getByLabelText('Search by title'), { target: { value: 'conv' } })
    expect(screen.getAllByRole('listitem')).toHaveLength(100)
    expect(screen.getByText('Show more (150 left)')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Search by title'), { target: { value: 'conv 25' } })
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.queryByText(/Show more/)).toBeNull()
  })
  it('empty state', async () => {
    list.mockResolvedValue([] as any)
    render(<Harness initial={base()} />)
    expect(await screen.findByText('No sessions yet. Start one above.')).toBeTruthy()
  })
  it('closed row click resumes with its own machine, root and id', async () => {
    list.mockImplementation(async (m) => (m === 'laptop' ? [conv(7)] : []) as any)
    const onResume = vi.fn()
    render(<Harness initial={base()} onResume={onResume} />)
    fireEvent.click(await screen.findByText('Conv 7'))
    await waitFor(() => expect(onResume).toHaveBeenCalledTimes(1))
    expect(onResume.mock.calls[0][0]).toMatchObject({ kind: 'closed', machine: 'laptop', root: '/l', id: 'c7' })
    expect(screen.getByText(/· 7 messages/)).toBeTruthy()
  })
  it('busy disables closed rows; a resume error shows inline', async () => {
    list.mockResolvedValue([conv(3)] as any)
    const { unmount } = render(<Harness initial={base()} busy />)
    const btn = (await screen.findByText('Conv 3')).closest('button')!
    expect(btn.disabled).toBe(true)
    unmount()
    render(<Harness initial={base()} onResume={() => { throw new Error('no launch') }} />)
    fireEvent.click(await screen.findByText('Conv 3'))
    expect(await screen.findByText('no launch')).toBeTruthy()
  })
  it('a session closed while the screen is open stays as a closed row', async () => {
    list.mockResolvedValue([] as any)
    const s = { ...base(), sessions: { a: sess('a', { name: 'just-closed', machine: 'vps-1', state: 'closed' as any }) }, order: ['a'] }
    render(<Harness initial={s} />)
    expect(await screen.findByText('just-closed')).toBeTruthy()
    expect(screen.queryByText(/No sessions yet/)).toBeNull()
  })
  it('does not claim "No sessions yet" when a checkout failed to list', async () => {
    list.mockRejectedValue(new Error('boom'))
    render(<Harness initial={base()} />)
    await screen.findByText('vps-1: could not list conversations')
    expect(screen.queryByText(/No sessions yet/)).toBeNull()
  })
})
