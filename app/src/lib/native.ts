/** Native notification; default web implementation (Tauri will replace it). */
export async function notify(title: string, body: string): Promise<void> {
  if (typeof Notification === 'undefined') return
  try {
    if (Notification.permission === 'default') await Notification.requestPermission()
    if (Notification.permission === 'granted') new Notification(title, { body })
  } catch { /* no permission or not supported */ }
}
