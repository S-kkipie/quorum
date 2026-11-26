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

type Bridge = { quorumOpenExternal?: (url: string) => Promise<unknown> }

const httpUrl = (url: string): boolean => /^https?:\/\//i.test(url)

/** Hands an http(s) URL to the device: the default browser (desktop app), an ACTION_VIEW intent (Android shell) or a new tab. */
async function openDevice(url: string): Promise<boolean> {
  if (!httpUrl(url)) throw new Error('Only http(s) links can be opened')
  const w = window as unknown as Bridge & { Capacitor?: { nativePromise?: (p: string, m: string, o: object) => Promise<unknown> } }
  if (typeof w.quorumOpenExternal === 'function') { await w.quorumOpenExternal(url); return true }
  if (isNative() && w.Capacitor?.nativePromise) { await w.Capacitor.nativePromise('HubShell', 'openExternal', { url }); return true }
  return false
}

/** Opens an http(s) URL outside Quorum. Call it straight from a click. */
export function openExternal(url: string): void {
  if (!httpUrl(url)) throw new Error('Only http(s) links can be opened')
  void openDevice(url).then((done) => { if (!done) window.open(url, '_blank', 'noopener') }).catch(() => {})
}

/**
 * Opens the URL `get` resolves to outside Quorum. On the web the tab is opened synchronously (before the await,
 * so popup blockers see the click), then pointed at the URL; it closes if `get` fails.
 */
export async function openExternalAsync(get: () => Promise<string>): Promise<void> {
  const w = window as unknown as Bridge
  if (typeof w.quorumOpenExternal === 'function' || isNative()) {
    const url = await get()
    if (await openDevice(url)) return
    window.open(url, '_blank', 'noopener')
    return
  }
  const tab = window.open('', '_blank')
  let url: string
  try {
    url = await get()
    if (!httpUrl(url)) throw new Error('Only http(s) links can be opened')
  } catch (e) {
    try { tab?.close() } catch { /* already closed */ }
    throw e
  }
  if (tab) { tab.opener = null; tab.location.href = url } else window.open(url, '_blank', 'noopener')
}
