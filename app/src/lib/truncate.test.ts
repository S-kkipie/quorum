import { describe, expect, it } from 'vitest'
import { middleTruncate } from './truncate'

describe('middleTruncate', () => {
  it('leaves short names alone', () => {
    expect(middleTruncate('report.html', 20)).toBe('report.html')
  })
  it('keeps the start, the stem tail and the extension', () => {
    const out = middleTruncate('quarterly-financial-report-final-v12.html', 24)
    expect(out.length).toBeLessThanOrEqual(24)
    expect(out.startsWith('quarterly')).toBe(true)
    expect(out.endsWith('-final-v12.html'.slice(-13))).toBe(true)
    expect(out).toContain('…')
  })
  it('tells apart names that differ only at the end', () => {
    const a = middleTruncate('analysis-of-everything-in-the-world-v1.md', 22)
    const b = middleTruncate('analysis-of-everything-in-the-world-v2.md', 22)
    expect(a).not.toBe(b)
  })
  it('handles names without extension and tiny limits', () => {
    expect(middleTruncate('a-very-long-file-name-without-extension', 16).length).toBeLessThanOrEqual(16)
    expect(middleTruncate('abcdefghijklmnop.txt', 6)).toContain('…')
  })
})
