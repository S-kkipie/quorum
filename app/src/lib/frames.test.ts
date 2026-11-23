import { describe, expect, it, vi } from 'vitest'
import { frames } from './frames'

const f = (ansi: string) => ({ pane: 'p', cols: 80, rows: 24, ansi, closed: false })
describe('frames', () => {
  it('keeps only latest', () => {
    frames.set('m', 'p', f('a'))
    frames.set('m', 'p', f('b'))
    expect(frames.get('m', 'p')?.ansi).toBe('b')
  })
  it('notifies subscribers and can be unsubscribed', () => {
    const fn = vi.fn()
    const un = frames.subscribe(frames.key('m', 'q'), fn)
    frames.set('m', 'q', f('x'))
    expect(fn).toHaveBeenCalledTimes(1)
    un()
    frames.set('m', 'q', f('y'))
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
