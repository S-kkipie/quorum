// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { listeners, push, local, localRemove, prefs, api, native } = vi.hoisted(() => {
  const listeners: Record<string, (e: any) => void> = {}
  const localRemove = vi.fn(async () => {})
  return {
    listeners,
    localRemove,
    local: {
      addListener: vi.fn(async (name: string, fn: (e: any) => void) => { listeners[name] = fn; return { remove: localRemove } }),
    },
    push: {
      checkPermissions: vi.fn(async () => ({ receive: 'prompt' })),
      requestPermissions: vi.fn(async () => ({ receive: 'granted' })),
      register: vi.fn(async () => {}),
      removeAllListeners: vi.fn(async () => {}),
      addListener: vi.fn(async (name: string, fn: (e: any) => void) => { listeners[name] = fn; return { remove: async () => {} } }),
    },
    prefs: { remove: vi.fn(async (_: { key: string }) => {}), get: vi.fn(async (_: { key: string }) => ({ value: null as string | null })) },
    api: { registerPush: vi.fn(async (_: string) => {}), unregisterPush: vi.fn(async (_: string) => {}) },
    native: { notify: vi.fn(async (_t: string, _b: string) => {}) },
  }
})
vi.mock('@capacitor/push-notifications', () => ({ PushNotifications: push }))
vi.mock('@capacitor/local-notifications', () => ({ LocalNotifications: local }))
vi.mock('@capacitor/preferences', () => ({ Preferences: prefs }))
vi.mock('./api', () => api)
vi.mock('./native', () => native)

import { changeHub, startPush, stopPush } from './push'

beforeEach(() => {
  stopPush() // drops the previous test's listeners before the counts are cleared
  vi.clearAllMocks()
  for (const k of Object.keys(listeners)) delete listeners[k]
  push.checkPermissions.mockResolvedValue({ receive: 'prompt' })
  push.requestPermissions.mockResolvedValue({ receive: 'granted' })
  prefs.get.mockResolvedValue({ value: null })
  stopPush()
})

describe('push', () => {
  it('asks permission, registers and sends the token to the hub (again when it changes)', async () => {
    await startPush(() => {})
    expect(push.requestPermissions).toHaveBeenCalled()
    expect(push.register).toHaveBeenCalled()
    listeners.registration({ value: 'tok-1' })
    expect(api.registerPush).toHaveBeenCalledWith('tok-1')
    listeners.registration({ value: 'tok-2' })
    expect(api.registerPush).toHaveBeenLastCalledWith('tok-2')
  })

  it('never registers in an APK built without Firebase (the shell sets pushAvailable=false)', async () => {
    prefs.get.mockResolvedValue({ value: 'false' })
    await startPush(() => {})
    expect(prefs.get).toHaveBeenCalledWith({ key: 'pushAvailable' })
    expect(push.requestPermissions).not.toHaveBeenCalled()
    expect(push.register).not.toHaveBeenCalled()
  })

  it('does not ask again when permission is already granted', async () => {
    push.checkPermissions.mockResolvedValue({ receive: 'granted' })
    await startPush(() => {})
    expect(push.requestPermissions).not.toHaveBeenCalled()
    expect(push.register).toHaveBeenCalled()
  })

  it('does not register when permission is denied', async () => {
    push.requestPermissions.mockResolvedValue({ receive: 'denied' })
    await startPush(() => {})
    expect(push.register).not.toHaveBeenCalled()
  })

  it('starting twice registers once', async () => {
    await startPush(() => {})
    await startPush(() => {})
    expect(push.register).toHaveBeenCalledTimes(1)
  })

  it('a tap on a notification opens its session', async () => {
    const open = vi.fn()
    await startPush(open)
    listeners.pushNotificationActionPerformed({ notification: { data: { session: 's1', kind: 'done' } } })
    expect(open).toHaveBeenCalledWith('s1')
    listeners.pushNotificationActionPerformed({ notification: { data: {} } })
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('a foreground push shows a local notification through notify(), with its session', async () => {
    await startPush(() => {})
    listeners.pushNotificationReceived({ title: 'Fix · vps-1', body: 'Finished', data: { session: 's1' } })
    expect(native.notify).toHaveBeenCalledWith('Fix · vps-1', 'Finished', { session: 's1' })
    listeners.pushNotificationReceived({ data: {} })
    expect(native.notify).toHaveBeenLastCalledWith('Quorum', '', { session: '' })
  })

  it('a tap on the local notification of a foreground push opens its session', async () => {
    const open = vi.fn()
    await startPush(open)
    expect(local.addListener).toHaveBeenCalledWith('localNotificationActionPerformed', expect.any(Function))
    listeners.localNotificationActionPerformed({ actionId: 'tap', notification: { id: 1, extra: { session: 's1' } } })
    expect(open).toHaveBeenCalledWith('s1')
    listeners.localNotificationActionPerformed({ actionId: 'tap', notification: { id: 2 } })
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('stopPush removes the local notification listener', async () => {
    await startPush(() => {})
    stopPush()
    expect(push.removeAllListeners).toHaveBeenCalled()
    expect(localRemove).toHaveBeenCalledTimes(1)
    stopPush()
    expect(localRemove).toHaveBeenCalledTimes(1)
  })

  it('change hub unregisters the token, forgets the hub and reloads', async () => {
    const reload = vi.fn()
    vi.stubGlobal('location', { ...window.location, reload })
    await startPush(() => {})
    listeners.registration({ value: 'tok-1' })
    await changeHub()
    expect(api.unregisterPush).toHaveBeenCalledWith('tok-1')
    expect(prefs.remove).toHaveBeenCalledWith({ key: 'hubUrl' })
    expect(api.unregisterPush.mock.invocationCallOrder[0]).toBeLessThan(prefs.remove.mock.invocationCallOrder[0])
    expect(reload).toHaveBeenCalled()
  })

  it('change hub still goes on when the hub is unreachable', async () => {
    const reload = vi.fn()
    vi.stubGlobal('location', { ...window.location, reload })
    api.unregisterPush.mockRejectedValueOnce(new Error('offline'))
    await startPush(() => {})
    listeners.registration({ value: 'tok-1' })
    await changeHub()
    expect(prefs.remove).toHaveBeenCalledWith({ key: 'hubUrl' })
    expect(reload).toHaveBeenCalled()
  })
})
