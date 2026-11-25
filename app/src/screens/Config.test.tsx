// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Config, { Appearance } from './Config'
import { initialState } from '../lib/store'
import { PALETTE_KEY, THEME_KEY, setTheme } from '../lib/theme'
import { PALETTES, deriveAccent, setPalette } from '../lib/palettes'

beforeEach(() => {
  localStorage.clear()
  document.documentElement.className = ''
  document.documentElement.removeAttribute('style')
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  setTheme('system') // the choice in effect is module state: start every test from System
  setPalette({ id: 'terminal-green' })
})

const { changeHub } = vi.hoisted(() => ({ changeHub: vi.fn(async () => {}) }))
vi.mock('../lib/push', () => ({ changeHub }))

describe('Change hub', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => new Response('[]'))); changeHub.mockClear() })
  afterEach(() => { delete (window as any).Capacitor })

  it('is hidden on the web', async () => {
    render(<Config state={initialState()} />)
    await act(async () => {})
    expect(screen.queryByRole('button', { name: 'Change hub' })).toBeNull()
  })

  it('in the Android app it is a 44 px button that runs the shell reset', async () => {
    ;(window as any).Capacitor = { isNativePlatform: () => true }
    render(<Config state={initialState()} />)
    const b = await screen.findByRole('button', { name: 'Change hub' })
    expect(b.className).toContain('min-h-11')
    fireEvent.click(b)
    await act(async () => {})
    expect(changeHub).toHaveBeenCalledTimes(1)
  })
})

const themeGroup = () => screen.getByRole('radiogroup', { name: 'Theme' })
const themeRadios = () => within(themeGroup()).getAllByRole('radio')
const paletteGroup = () => screen.getByRole('radiogroup', { name: 'Palette' })
/** Renders Appearance and waits for the lazy palette picker. */
const renderAppearance = async () => { render(<Appearance />); await screen.findByRole('radiogroup', { name: 'Palette' }) }
const root = document.documentElement

describe('Appearance', () => {
  it('offers System / Light / Dark, System by default', () => {
    render(<Appearance />)
    const radios = themeRadios()
    expect(radios.map((r) => r.textContent)).toEqual(['System', 'Light', 'Dark'])
    expect(within(themeGroup()).getByRole('radio', { name: 'System' }).getAttribute('aria-checked')).toBe('true')
    for (const r of radios) expect(r.className).toContain('min-h-11')
  })

  it('switches the theme instantly and remembers it', () => {
    render(<Appearance />)
    fireEvent.click(within(themeGroup()).getByRole('radio', { name: 'Dark' }))
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(localStorage.getItem(THEME_KEY)).toBe('dark')
    expect(within(themeGroup()).getByRole('radio', { name: 'Dark' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(within(themeGroup()).getByRole('radio', { name: 'Light' }))
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(localStorage.getItem(THEME_KEY)).toBe('light')
  })

  it('is one tab stop and moves with the arrow keys (roving tabindex)', () => {
    render(<Appearance />)
    const [system, light, dark] = themeRadios()
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
    expect(within(themeGroup()).getByRole('radio', { name: 'Light' }).getAttribute('aria-checked')).toBe('true')
  })

  it('offers a tile per palette, Terminal green by default, with name and swatches', async () => {
    await renderAppearance()
    const tiles = within(paletteGroup()).getAllByRole('radio')
    expect(tiles.map((t) => t.getAttribute('aria-label'))).toEqual(Object.values(PALETTES).map((p) => p.name))
    expect(tiles[0].getAttribute('aria-checked')).toBe('true')
    expect(tiles.map((t) => t.tabIndex)).toEqual([0, -1, -1, -1, -1, -1, -1])
    for (const t of tiles) {
      expect(t.className).toContain('min-h-11')
      expect(t.querySelectorAll('[data-swatch]').length).toBeGreaterThanOrEqual(4)
    }
  })

  it('a tile switches the palette instantly and remembers it', async () => {
    await renderAppearance()
    fireEvent.click(within(paletteGroup()).getByRole('radio', { name: 'Midnight' }))
    expect(root.getAttribute('data-palette')).toBe('midnight')
    expect(JSON.parse(localStorage.getItem(PALETTE_KEY)!)).toEqual({ id: 'midnight' })
    expect(within(paletteGroup()).getByRole('radio', { name: 'Midnight' }).getAttribute('aria-checked')).toBe('true')
    const midnight = within(paletteGroup()).getByRole('radio', { name: 'Midnight' })
    fireEvent.keyDown(midnight, { key: 'ArrowRight' })
    expect(root.getAttribute('data-palette')).toBe('ember')
    expect(document.activeElement).toBe(within(paletteGroup()).getByRole('radio', { name: 'Ember' }))
  })

  it('applies a custom accent on the current palette, and Reset clears it', async () => {
    await renderAppearance()
    fireEvent.click(within(paletteGroup()).getByRole('radio', { name: 'Graphite' }))
    expect(screen.queryByRole('button', { name: 'Reset to palette' })).toBeNull()
    const input = screen.getByLabelText('Custom accent') as HTMLInputElement
    expect(input.value.toUpperCase()).toBe(PALETTES.graphite.light.accent)
    fireEvent.change(input, { target: { value: '#fff59d' } })
    const d = deriveAccent('#FFF59D', 'light', PALETTES.graphite.light)
    expect(root.style.getPropertyValue('--accent')).toBe(d.accent)
    expect(root.getAttribute('data-palette')).toBe('graphite')
    expect(JSON.parse(localStorage.getItem(PALETTE_KEY)!)).toMatchObject({ id: 'graphite', accent: '#FFF59D' })
    expect(screen.getByText(new RegExp(`adjusted to ${d.accent} for contrast`, 'i'))).toBeTruthy()
    const reset = screen.getByRole('button', { name: 'Reset to palette' })
    expect(reset.className).toContain('min-h-11')
    fireEvent.click(reset)
    expect(root.style.getPropertyValue('--accent')).toBe('')
    expect(JSON.parse(localStorage.getItem(PALETTE_KEY)!)).toEqual({ id: 'graphite' })
    expect(screen.queryByRole('button', { name: 'Reset to palette' })).toBeNull()
  })

  it('picking another tile drops the custom accent', async () => {
    await renderAppearance()
    fireEvent.change(screen.getByLabelText('Custom accent'), { target: { value: '#ff0000' } })
    expect(root.style.getPropertyValue('--accent')).not.toBe('')
    fireEvent.click(within(paletteGroup()).getByRole('radio', { name: 'Violet' }))
    expect(root.style.getPropertyValue('--accent')).toBe('')
  })
})

describe('Settings → Meetings', () => {
  it('has a Meetings section that loads with Settings (provider, inbox) and opens a meeting from the inbox', async () => {
    const row = { id: 'm9', projectId: '', title: 'Hallway chat', startedAt: 0, durationS: 60, language: '', status: 'ready', progress: 100, error: '', provider: '', createdAt: 1, updatedAt: 1, hasAudio: true, audioBytes: 1, channels: '', speakerCount: 0 }
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (String(u).endsWith('/api/settings/meetings')) return new Response(JSON.stringify({ provider: 'local', model: '', baseUrl: '', language: 'es', aliases: [], hasKey: false }))
      if (String(u).endsWith('/api/meetings/disk')) return new Response(JSON.stringify({ audioBytes: 0, freeBytes: 1e10 }))
      if (String(u).includes('/api/meetings?unassigned=1')) return new Response(JSON.stringify([row]))
      return new Response('[]')
    }))
    const onOpenMeeting = vi.fn()
    render(<Config state={initialState()} onOpenMeeting={onOpenMeeting} />)
    expect(screen.getByRole('heading', { name: 'Meetings' })).toBeTruthy()
    expect(await screen.findByLabelText('Summary provider')).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: /Hallway chat/ }))
    expect(onOpenMeeting).toHaveBeenCalledWith('m9')
  })
})
