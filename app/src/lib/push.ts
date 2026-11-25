// Android push layer. Loaded lazily, and only inside the Capacitor shell: the Capacitor packages are
// reachable only from here (and from native.ts's own dynamic import), so the web build never pays for them.
import type { PluginListenerHandle } from '@capacitor/core'
import { LocalNotifications } from '@capacitor/local-notifications'
import { PushNotifications } from '@capacitor/push-notifications'
import { Preferences } from '@capacitor/preferences'
import { registerPush, unregisterPush } from './api'
import { notify } from './native'

let started = false
let token = ''
let localTap: PluginListenerHandle | null = null

function sessionOf(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/**
 * Asks for the notification permission, registers with FCM and keeps the hub's copy of the token current.
 * A tap on a notification calls `open` with its session id; a push that arrives in the foreground is shown
 * as a local system notification (the owner wants to be told always) that carries the session id, so a tap
 * on it opens the session too. Safe to call more than once.
 */
export async function startPush(open: (session: string) => void): Promise<void> {
  if (started) return
  started = true
  try {
    let perm = (await PushNotifications.checkPermissions()).receive
    if (perm !== 'granted') perm = (await PushNotifications.requestPermissions()).receive
    if (perm !== 'granted') { started = false; return }
    await PushNotifications.addListener('registration', (t) => {
      token = t.value
      registerPush(t.value).catch(() => { /* the hub is unreachable: the next registration sends it again */ })
    })
    await PushNotifications.addListener('registrationError', () => { /* no Play services: no push */ })
    await PushNotifications.addListener('pushNotificationActionPerformed', (a) => {
      const session = sessionOf(a.notification.data?.session)
      if (session) open(session)
    })
    await PushNotifications.addListener('pushNotificationReceived', (n) => {
      void notify(n.title ?? 'Quorum', n.body ?? '', { session: sessionOf(n.data?.session) })
    })
    localTap = await LocalNotifications.addListener('localNotificationActionPerformed', (a) => {
      const session = sessionOf(a.notification.extra?.session)
      if (session) open(session)
    })
    await PushNotifications.register()
  } catch { started = false /* the plugin is missing or failed: try again next time */ }
}

/** Drops the listeners and the token (the phone was unpaired); a later pairing registers again. */
export function stopPush(): void {
  started = false
  token = ''
  PushNotifications.removeAllListeners().catch(() => { /* nothing to remove */ })
  localTap?.remove().catch(() => { /* already gone */ })
  localTap = null
}

/** "Change hub": removes this phone's token from the hub, forgets the hub URL (shell) and reloads into the first-run page. */
export async function changeHub(): Promise<void> {
  if (token) await unregisterPush(token).catch(() => { /* offline or already unpaired: the hub drops dead tokens itself */ })
  await Preferences.remove({ key: 'hubUrl' })
  location.reload()
}
