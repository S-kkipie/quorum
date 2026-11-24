import { describe, expect, it } from 'vitest'
import { contextTone, formatTokens, resetIn, usageTone } from './meters'

describe('meters', () => {
  it('formatTokens', () => {
    expect([0, 999, 1000, 1234, 12_000, 12_345, 999_999, 1_200_000].map(formatTokens)).toEqual(['0', '999', '1k', '1.2k', '12k', '12k', '1M', '1.2M'])
  })
  it('usageTone boundaries', () => {
    expect([79, 80, 94, 95].map(usageTone)).toEqual(['ok', 'warn', 'warn', 'danger'])
  })
  it('contextTone boundaries', () => {
    expect([49, 50, 74, 75].map(contextTone)).toEqual(['ok', 'warn', 'warn', 'danger'])
  })
  it('resetIn', () => {
    const now = Date.parse('2026-01-01T00:00:00Z')
    const at = (ms: number) => new Date(now + ms).toISOString()
    expect(resetIn(at(130 * 60_000), now)).toBe('2h 10m')
    expect(resetIn(at(45 * 60_000), now)).toBe('45m')
    expect(resetIn(at(3 * 86_400_000 + 5 * 3_600_000), now)).toBe('3d')
    expect(resetIn(at(-1000), now)).toBe('')
    expect(resetIn('', now)).toBe('')
    expect(resetIn('garbage', now)).toBe('')
  })
})
