// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { useMarkSeen } from './useMarkSeen'
import * as api from './api'

vi.mock('./api', () => ({ seen: vi.fn() }))
const seen = vi.mocked(api.seen)
let visibility = 'visible'
beforeEach(() => {
  vi.useFakeTimers()
  seen.mockResolvedValue(undefined as never)
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
})
afterEach(() => { cleanup(); vi.useRealTimers(); seen.mockReset() })

describe('useMarkSeen', () => {
  it('marks seen on mount, then debounces new events to one call within 2 s', async () => {
    const onSeen = vi.fn()
    const { rerender } = renderHook((p: { seq: number }) => useMarkSeen('a', p.seq, true, onSeen), { initialProps: { seq: 5 } })
    expect(seen).toHaveBeenCalledWith('a', 5)
    await vi.advanceTimersByTimeAsync(0)
    expect(onSeen).toHaveBeenCalledWith('a')
    rerender({ seq: 6 }); rerender({ seq: 7 })
    expect(seen).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2000)
    expect(seen).toHaveBeenCalledTimes(2)
    expect(seen).toHaveBeenLastCalledWith('a', 7)
  })
  it('never calls while hidden, then calls when the page becomes visible', () => {
    visibility = 'hidden'
    const { rerender } = renderHook((p: { seq: number }) => useMarkSeen('a', p.seq, true), { initialProps: { seq: 5 } })
    rerender({ seq: 6 })
    vi.advanceTimersByTime(5000)
    expect(seen).not.toHaveBeenCalled()
    visibility = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    expect(seen).toHaveBeenCalledWith('a', 6)
  })
  it('does nothing without events or when inactive', () => {
    renderHook(() => useMarkSeen('a', 0, true))
    renderHook(() => useMarkSeen('b', 4, false))
    expect(seen).not.toHaveBeenCalled()
  })
  it('does not repeat the same seq', () => {
    const { rerender } = renderHook((p: { seq: number }) => useMarkSeen('a', p.seq, true), { initialProps: { seq: 5 } })
    rerender({ seq: 5 })
    document.dispatchEvent(new Event('visibilitychange'))
    vi.advanceTimersByTime(3000)
    expect(seen).toHaveBeenCalledTimes(1)
  })
  it('calls onSeen only after the hub accepted, and retries a failure once 2 s later', async () => {
    const onSeen = vi.fn()
    seen.mockRejectedValueOnce(new Error('offline'))
    renderHook(() => useMarkSeen('a', 5, true, onSeen))
    expect(seen).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(onSeen).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2000)
    expect(seen).toHaveBeenCalledTimes(2)
    expect(seen).toHaveBeenLastCalledWith('a', 5)
    expect(onSeen).toHaveBeenCalledWith('a')
    await vi.advanceTimersByTimeAsync(5000)
    expect(seen).toHaveBeenCalledTimes(2)
  })
  it('does not retry after unmount', async () => {
    seen.mockRejectedValueOnce(new Error('offline'))
    const { unmount } = renderHook(() => useMarkSeen('a', 5, true))
    unmount()
    await vi.advanceTimersByTimeAsync(5000)
    expect(seen).toHaveBeenCalledTimes(1)
  })
})
