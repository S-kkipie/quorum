// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { clearDraft, loadDraft, saveDraft, useDraft } from './drafts'

beforeEach(() => { localStorage.clear(); vi.useFakeTimers() })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('drafts storage', () => {
  it('round trips, clears, and removes on empty text', () => {
    saveDraft('a', 'hi')
    expect(loadDraft('a')).toBe('hi')
    expect(localStorage.getItem('quorum.draft.a')).toBe('hi')
    saveDraft('a', '')
    expect(localStorage.getItem('quorum.draft.a')).toBeNull()
    saveDraft('b', 'x')
    clearDraft('b')
    expect(loadDraft('b')).toBe('')
  })
  it('keeps at most 30', () => {
    for (let i = 1; i <= 31; i++) { vi.setSystemTime(i * 1000); saveDraft(`id${i}`, `t${i}`) }
    expect(loadDraft('id1')).toBe('')
    expect(loadDraft('id2')).toBe('t2')
    expect(loadDraft('id31')).toBe('t31')
    expect(JSON.parse(localStorage.getItem('quorum.draft.index')!)).toHaveLength(30)
  })
  it('does not throw when storage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('denied') })
    expect(loadDraft('a')).toBe('')
    expect(() => saveDraft('a', 'x')).not.toThrow()
    expect(() => clearDraft('a')).not.toThrow()
  })
})

describe('useDraft', () => {
  it('debounces saves by 300 ms', () => {
    const { result } = renderHook(() => useDraft('a'))
    act(() => result.current[1]('hey'))
    expect(result.current[0]).toBe('hey')
    act(() => { vi.advanceTimersByTime(299) })
    expect(loadDraft('a')).toBe('')
    act(() => { vi.advanceTimersByTime(1) })
    expect(loadDraft('a')).toBe('hey')
  })
  it('flushes on unmount and restores on remount', () => {
    const h = renderHook(() => useDraft('a'))
    act(() => h.result.current[1]('pending'))
    h.unmount()
    expect(loadDraft('a')).toBe('pending')
    expect(renderHook(() => useDraft('a')).result.current[0]).toBe('pending')
  })
  it('flushes under the old id when id changes', () => {
    const h = renderHook(({ id }) => useDraft(id), { initialProps: { id: 'a' } })
    act(() => h.result.current[1]('for-a'))
    h.rerender({ id: 'b' })
    expect(loadDraft('a')).toBe('for-a')
    expect(loadDraft('b')).toBe('')
    expect(h.result.current[0]).toBe('')
  })
  it('clear removes the draft and cancels a pending save', () => {
    const h = renderHook(() => useDraft('a'))
    act(() => h.result.current[1]('x'))
    act(() => h.result.current[2]())
    act(() => { vi.advanceTimersByTime(500) })
    expect(loadDraft('a')).toBe('')
    expect(h.result.current[0]).toBe('')
    h.unmount()
    expect(loadDraft('a')).toBe('')
  })
})
