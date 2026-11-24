// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import BackgroundSheet from './BackgroundSheet'
import type { BackgroundInfo } from '../proto.gen'

afterEach(() => { cleanup(); vi.useRealTimers() })
const NOW = Date.now()
const bg = (o: Partial<BackgroundInfo> = {}): BackgroundInfo => ({ tasks: 0, wakeAt: 0, ...o })
const open = (b: BackgroundInfo | undefined) => render(<BackgroundSheet open onOpenChange={vi.fn()} background={b} />)

describe('BackgroundSheet', () => {
  it('lists every kind with its label and a relative start; loops and crons show the next wake', async () => {
    open(bg({ tasks: 5, items: [
      { id: '1', kind: 'command', label: 'npm test', startedAt: NOW - 4 * 60_000 },
      { id: '2', kind: 'monitor', label: 'watch logs', startedAt: NOW - 10_000 },
      { id: '3', kind: 'subagent', label: 'audit callers', startedAt: NOW - 2 * 3_600_000 },
      { id: '4', kind: 'loop', label: 'check CI', startedAt: NOW - 60_000, nextWake: NOW + 20 * 60_000 },
      { id: '5', kind: 'cron', label: 'summarise PRs', startedAt: NOW - 60_000, nextWake: NOW + 3_600_000 },
    ] }))
    expect(await screen.findByText('Background')).toBeTruthy()
    for (const l of ['npm test', 'watch logs', 'audit callers', 'check CI', 'summarise PRs']) expect(screen.getByText(l)).toBeTruthy()
    expect(screen.getByText('started 4 min ago')).toBeTruthy()
    expect(screen.getByText('started just now')).toBeTruthy()
    expect(screen.getByText('started 2 h ago')).toBeTruthy()
    expect(screen.getAllByText(/next wake \d\d:\d\d/)).toHaveLength(2)
    for (const k of ['command', 'monitor', 'subagent', 'loop', 'cron']) expect(screen.getByLabelText(k)).toBeTruthy()
  })
  it('long labels clamp to 2 lines, wrap anywhere and keep the full text in the title', async () => {
    const label = 'y'.repeat(400)
    open(bg({ tasks: 1, items: [{ id: '1', kind: 'command', label, startedAt: NOW }] }))
    const el = await screen.findByTitle(label)
    expect(el.className).toContain('line-clamp-2')
    expect(el.className).toContain('overflow-wrap:anywhere')
  })
  it('empty list: nothing is running', async () => {
    open(bg({ items: [] }))
    expect(await screen.findByText('Nothing is running in the background.')).toBeTruthy()
  })
  it('older mod (counts only): N background tasks and the update hint', async () => {
    open(bg({ tasks: 3 }))
    expect(await screen.findByText('3 background tasks')).toBeTruthy()
    expect(screen.getByText('Update the Quorum plugin to see details')).toBeTruthy()
  })
  it('refreshes the relative time every minute while open', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    const t0 = Date.now()
    open(bg({ tasks: 1, items: [{ id: '1', kind: 'command', label: 'x', startedAt: t0 }] }))
    expect(screen.getByText('started just now')).toBeTruthy()
    await act(async () => { vi.advanceTimersByTime(3 * 60_000) })
    expect(screen.getByText('started 3 min ago')).toBeTruthy()
  })
})
