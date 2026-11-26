// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

const local = { checkPermissions: vi.fn(async () => ({ display: 'granted' })), requestPermissions: vi.fn(async () => ({ display: 'granted' })), schedule: vi.fn(async () => ({})) }
vi.mock('@capacitor/local-notifications', () => ({ LocalNotifications: local }))
import { isNative, notify, openExternalAsync } from './native'

afterEach(() => { delete (window as any).Capacitor; vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('native', () => {
  it('isNative is false on the web and true inside the Capacitor shell', () => {
    expect(isNative()).toBe(false)
    ;(window as any).Capacitor = { isNativePlatform: () => false }
    expect(isNative()).toBe(false)
    ;(window as any).Capacitor = { isNativePlatform: () => true }
    expect(isNative()).toBe(true)
  })

  it('notify uses the system notification in the shell', async () => {
    ;(window as any).Capacitor = { isNativePlatform: () => true }
    await notify('Fix · vps-1', 'Finished')
    expect(local.schedule).toHaveBeenCalledTimes(1)
    const n = (local.schedule.mock.calls[0] as any)[0].notifications[0]
    expect(n).toMatchObject({ title: 'Fix · vps-1', body: 'Finished', channelId: 'sessions' })
    expect(n.extra).toBeUndefined()
  })

  it('notify carries the session id for a tap', async () => {
    ;(window as any).Capacitor = { isNativePlatform: () => true }
    await notify('Fix · vps-1', 'Finished', { session: 's1' })
    const n = (local.schedule.mock.calls[0] as any)[0].notifications[0]
    expect(n).toMatchObject({ channelId: 'sessions', extra: { session: 's1' } })
  })

  it('notify on the web uses Notification and never touches Capacitor', async () => {
    const ctor = vi.fn()
    vi.stubGlobal('Notification', Object.assign(ctor, { permission: 'granted' }))
    await notify('a', 'b')
    expect(ctor).toHaveBeenCalledWith('a', { body: 'b' })
    expect(local.schedule).not.toHaveBeenCalled()
  })
})

describe('openExternal', () => {
  it('opens the tab before the url resolves (web) and points it at the url', async () => {
    const tab: any = { location: { href: '' }, opener: 'x', close: vi.fn() }
    const open = vi.fn(() => tab)
    vi.stubGlobal('open', open)
    let resolve!: (u: string) => void
    const p = openExternalAsync(() => new Promise<string>((r) => { resolve = r }))
    expect(open).toHaveBeenCalledWith('', '_blank')
    expect(tab.location.href).toBe('')
    resolve('https://hub.example/v/ab/x.html')
    await p
    expect(tab.location.href).toBe('https://hub.example/v/ab/x.html')
    expect(tab.opener).toBeNull()
  })

  it('closes the tab and rethrows when the url fails', async () => {
    const tab: any = { location: { href: '' }, close: vi.fn() }
    vi.stubGlobal('open', vi.fn(() => tab))
    await expect(openExternalAsync(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(tab.close).toHaveBeenCalled()
  })

  it('falls back to a noopener window when the tab is blocked', async () => {
    const open = vi.fn(() => null)
    vi.stubGlobal('open', open)
    await openExternalAsync(async () => 'https://hub.example/v/ab/x.html')
    expect(open).toHaveBeenLastCalledWith('https://hub.example/v/ab/x.html', '_blank', 'noopener')
  })

  it('calls the desktop binding with the full url', async () => {
    const q = vi.fn(async () => {})
    ;(window as any).quorumOpenExternal = q
    try {
      await openExternalAsync(async () => 'http://hub:7420/v/ab/x.html')
      expect(q).toHaveBeenCalledWith('http://hub:7420/v/ab/x.html')
    } finally { delete (window as any).quorumOpenExternal }
  })

  it('calls the HubShell plugin in the Android shell', async () => {
    const nativePromise = vi.fn(async () => ({}))
    ;(window as any).Capacitor = { isNativePlatform: () => true, nativePromise }
    await openExternalAsync(async () => 'https://hub.example/v/ab/x.html')
    expect(nativePromise).toHaveBeenCalledWith('HubShell', 'openExternal', { url: 'https://hub.example/v/ab/x.html' })
  })

  it('refuses a javascript: url without opening anything', async () => {
    const tab: any = { location: { href: '' }, close: vi.fn() }
    const open = vi.fn(() => tab)
    vi.stubGlobal('open', open)
    const q = vi.fn(async () => {})
    await expect(openExternalAsync(async () => 'javascript:alert(1)')).rejects.toThrow()
    expect(tab.close).toHaveBeenCalled()
    expect(tab.location.href).toBe('')
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).not.toHaveBeenCalledWith('javascript:alert(1)', expect.anything(), expect.anything())
    ;(window as any).quorumOpenExternal = q
    ;(window as any).Capacitor = { isNativePlatform: () => true, nativePromise: vi.fn(async () => ({})) }
    try {
      await expect(openExternalAsync(async () => 'javascript:alert(1)')).rejects.toThrow()
      expect(q).not.toHaveBeenCalled()
      expect((window as any).Capacitor.nativePromise).not.toHaveBeenCalled()
    } finally { delete (window as any).quorumOpenExternal }
  })
})
