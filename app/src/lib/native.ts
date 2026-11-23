/** Notificación nativa; implementación web por defecto (Tauri la reemplazará). */
export async function notify(title: string, body: string): Promise<void> {
  if (typeof Notification === 'undefined') return
  try {
    if (Notification.permission === 'default') await Notification.requestPermission()
    if (Notification.permission === 'granted') new Notification(title, { body })
  } catch { /* sin permiso o no soportado */ }
}
