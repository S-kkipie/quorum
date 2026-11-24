// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import UsageStrip from './UsageStrip'
import type { AccountUsage } from '../proto.gen'

afterEach(cleanup)
const NOW = Date.parse('2026-01-01T00:00:00Z')
const iso = (ms: number) => new Date(NOW + ms).toISOString()
const u = (key: string, alias: string, five: number, week: number, at = NOW): AccountUsage => ({
  key, alias, fiveHour: { pct: five, resetsAt: iso(130 * 60_000) }, sevenDay: { pct: week, resetsAt: iso(3 * 86_400_000 + 3_600_000) }, at,
})
const text = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim()

describe('UsageStrip', () => {
  it('renders nothing without accounts', () => {
    const { container } = render(<UsageStrip usage={{}} now={NOW} />)
    expect(container.firstChild).toBeNull()
  })
  it('one entry per account, highest pct first, with reset times', () => {
    render(<UsageStrip now={NOW} usage={{ a: u('a', 'personal-test', 10, 30), b: u('b', 'work', 58, 22) }} />)
    const items = screen.getAllByTestId('usage-account')
    expect(items.map(text)).toEqual(['work 5h 58% · 2h 10m week 22% · 3d', 'personal-test 5h 10% · 2h 10m week 30% · 3d'])
  })
  it('stale entries are marked and tones follow the thresholds', () => {
    render(<UsageStrip now={NOW} usage={{ a: u('a', 'work', 96, 80, NOW - 2 * 3_600_000), b: u('b', 'x', 10, 10) }} />)
    const [stale, fresh] = screen.getAllByTestId('usage-account')
    expect(stale.hasAttribute('data-stale')).toBe(true)
    expect(fresh.hasAttribute('data-stale')).toBe(false)
    expect(screen.getByText('5h 96%').getAttribute('data-tone')).toBe('danger')
    expect(screen.getByText('week 80%').getAttribute('data-tone')).toBe('warn')
  })
})
