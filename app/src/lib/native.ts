/** True inside the Capacitor shell (the Android app); the plain web build never has `window.Capacitor`. */
export function isNative(): boolean {
  try {
    return !!(window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.()
  } catch { return false }
}

/**
 * Native notification: the system one in the Android shell (on the "sessions" channel MainActivity
 * creates, carrying the session id so a tap can open it), the browser one on the web.
 */
export async function notify(title: string, body: string, opts: { session?: string } = {}): Promise<void> {
  if (isNative()) {
    try {
      const { LocalNotifications } = await import('@capacitor/local-notifications')
      if ((await LocalNotifications.checkPermissions()).display !== 'granted') {
        if ((await LocalNotifications.requestPermissions()).display !== 'granted') return
      }
      await LocalNotifications.schedule({ notifications: [{
        id: Math.floor(Date.now() % 2147483647), title, body, channelId: 'sessions',
        ...(opts.session ? { extra: { session: opts.session } } : {}),
      }] })
    } catch { /* no permission or not supported */ }
    return
  }
  if (typeof Notification === 'undefined') return
  try {
    if (Notification.permission === 'default') await Notification.requestPermission()
    if (Notification.permission === 'granted') new Notification(title, { body })
  } catch { /* no permission or not supported */ }
}
