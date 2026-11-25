// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { LAYOUT_KEY, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, resetLayout, useLayout } from './useLayout'

let width = 1300
const listeners = new Set<() => void>()
const mq = (q: string) => {
  const min = Number(/min-width:\s*(\d+)px/.exec(q)?.[1] ?? 0)
  return { get matches() { return width >= min }, addEventListener: (_: string, h: () => void) => listeners.add(h), removeEventListener: (_: string, h: () => void) => listeners.delete(h) }
}
const resize = (w: number) => act(() => { width = w; listeners.forEach((h) => h()) })
let store: Map<string, string>
const okStorage = () => ({ getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } })

beforeEach(() => {
  width = 1300
  store = new Map()
  vi.stubGlobal('matchMedia', mq)
  vi.stubGlobal('localStorage', okStorage())
  resetLayout()
})
afterEach(() => { vi.unstubAllGlobals(); listeners.clear() })

describe('useLayout', () => {
  it('maps the width to the mode and inspector placement', () => {
    const { result } = renderHook(() => useLayout())
    expect(result.current.mode).toBe('desktop')
    expect(result.current.inspector).toBe('docked')
    resize(1100)
    expect(result.current.mode).toBe('desktop')
    expect(result.current.inspector).toBe('overlay')
    resize(800)
    expect(result.current.mode).toBe('phone')
    expect(result.current.inspector).toBe('sheet')
  })

  it('the inspector is open by default only when docked; only the docked state is shared and persisted', () => {
    const { result } = renderHook(() => useLayout())
    expect(result.current.inspectorOpen).toBe(true)
    resize(1100)
    expect(result.current.inspectorOpen).toBe(false)
    act(() => result.current.toggleInspector())
    expect(result.current.inspectorOpen).toBe(true)
    resize(1300)
    act(() => result.current.toggleInspector())
    expect(result.current.inspectorOpen).toBe(false)
    resize(1100)
    expect(result.current.inspectorOpen).toBe(true)
    expect(JSON.parse(store.get(LAYOUT_KEY)!).inspector).toEqual({ docked: false })
    // a new mount (another session view) starts with the overlay and the sheet closed
    const other = renderHook(() => useLayout())
    expect(other.result.current.inspectorOpen).toBe(false)
    resize(800)
    act(() => result.current.toggleInspector())
    expect(result.current.inspectorOpen).toBe(true)
    expect(other.result.current.inspectorOpen).toBe(false)
    expect(JSON.parse(store.get(LAYOUT_KEY)!).inspector).toEqual({ docked: false })
  })

  it('an old stored overlay or sheet open state is ignored', () => {
    store.set(LAYOUT_KEY, JSON.stringify({ sidebarWidth: 300, sidebarOpen: true, inspector: { docked: false, overlay: true, sheet: true } }))
    resetLayout()
    width = 1100
    const { result } = renderHook(() => useLayout())
    expect(result.current.inspectorOpen).toBe(false)
    resize(800)
    expect(result.current.inspectorOpen).toBe(false)
    resize(1300)
    expect(result.current.inspectorOpen).toBe(false)
  })

  it('the sidebar width is clamped, shared between hooks and persisted', () => {
    const a = renderHook(() => useLayout())
    const b = renderHook(() => useLayout())
    expect(a.result.current.sidebarWidth).toBe(SIDEBAR_DEFAULT)
    act(() => a.result.current.setSidebarWidth(300))
    expect(b.result.current.sidebarWidth).toBe(300)
    act(() => a.result.current.setSidebarWidth(10))
    expect(a.result.current.sidebarWidth).toBe(SIDEBAR_MIN)
    act(() => a.result.current.setSidebarWidth(9999))
    expect(a.result.current.sidebarWidth).toBe(SIDEBAR_MAX)
    act(() => a.result.current.setSidebarWidth(333))
    act(() => a.result.current.toggleSidebar())
    expect(JSON.parse(store.get(LAYOUT_KEY)!)).toMatchObject({ sidebarWidth: 333, sidebarOpen: false })
    // a new run reads it back
    resetLayout()
    const c = renderHook(() => useLayout())
    expect(c.result.current.sidebarWidth).toBe(333)
    expect(c.result.current.sidebarOpen).toBe(false)
  })

  it('a throwing storage gives the defaults and toggles still work in memory', () => {
    const boom = () => { throw new Error('denied') }
    vi.stubGlobal('localStorage', { getItem: boom, setItem: boom, removeItem: boom })
    resetLayout()
    const { result } = renderHook(() => useLayout())
    expect(result.current.sidebarWidth).toBe(SIDEBAR_DEFAULT)
    expect(result.current.sidebarOpen).toBe(true)
    act(() => result.current.toggleSidebar())
    expect(result.current.sidebarOpen).toBe(false)
    act(() => result.current.setSidebarWidth(250))
    expect(result.current.sidebarWidth).toBe(250)
  })

  it('a corrupt stored value gives the defaults', () => {
    store.set(LAYOUT_KEY, '{"sidebarWidth":"wide","sidebarOpen":3,"inspector":null}')
    resetLayout()
    const { result } = renderHook(() => useLayout())
    expect(result.current.sidebarWidth).toBe(SIDEBAR_DEFAULT)
    expect(result.current.sidebarOpen).toBe(true)
    expect(result.current.inspectorOpen).toBe(true)
    store.set(LAYOUT_KEY, 'not json')
    resetLayout()
    expect(renderHook(() => useLayout()).result.current.sidebarWidth).toBe(SIDEBAR_DEFAULT)
  })
})
