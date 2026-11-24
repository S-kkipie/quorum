// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Appearance } from './Config'
import { THEME_KEY, setTheme } from '../lib/theme'

beforeEach(() => {
  localStorage.clear()
  document.documentElement.className = ''
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  setTheme('system') // the choice in effect is module state: start every test from System
})

describe('Appearance', () => {
  it('offers System / Light / Dark, System by default', () => {
    render(<Appearance />)
    const radios = screen.getAllByRole('radio')
    expect(radios.map((r) => r.textContent)).toEqual(['System', 'Light', 'Dark'])
    expect(screen.getByRole('radio', { name: 'System' }).getAttribute('aria-checked')).toBe('true')
    for (const r of radios) expect(r.className).toContain('min-h-11')
  })

  it('switches the theme instantly and remembers it', () => {
    render(<Appearance />)
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }))
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(localStorage.getItem(THEME_KEY)).toBe('dark')
    expect(screen.getByRole('radio', { name: 'Dark' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('radio', { name: 'Light' }))
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(localStorage.getItem(THEME_KEY)).toBe('light')
  })

  it('is one tab stop and moves with the arrow keys (roving tabindex)', () => {
    render(<Appearance />)
    const [system, light, dark] = screen.getAllByRole('radio')
    expect([system, light, dark].map((r) => r.tabIndex)).toEqual([0, -1, -1])
    fireEvent.keyDown(system, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(light)
    expect(light.getAttribute('aria-checked')).toBe('true')
    expect([system, light, dark].map((r) => r.tabIndex)).toEqual([-1, 0, -1])
    fireEvent.keyDown(light, { key: 'End' })
    expect(document.activeElement).toBe(dark)
    expect(localStorage.getItem(THEME_KEY)).toBe('dark')
    fireEvent.keyDown(dark, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(system)
    fireEvent.keyDown(system, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(dark)
    fireEvent.keyDown(dark, { key: 'Home' })
    expect(system.getAttribute('aria-checked')).toBe('true')
  })

  it('shows a choice made in another tab', () => {
    render(<Appearance />)
    localStorage.setItem(THEME_KEY, 'light')
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: THEME_KEY, newValue: 'light' })) })
    expect(screen.getByRole('radio', { name: 'Light' }).getAttribute('aria-checked')).toBe('true')
  })
})
