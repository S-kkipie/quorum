// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

const local = { checkPermissions: vi.fn(async () => ({ display: 'granted' })), requestPermissions: vi.fn(async () => ({ display: 'granted' })), schedule: vi.fn(async () => ({})) }
vi.mock('@capacitor/local-notifications', () => ({ LocalNotifications: local }))
import { isNative, notify } from './native'

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
