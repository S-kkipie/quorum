/** A tiny in-app signal: something outside a plugin section changed that plugin's state (e.g. the composer queued with /after). */
export type PluginBusName = 'after' | 'time-machine'
type Listener = (sessionId: string, plugin: PluginBusName) => void

const listeners = new Set<Listener>()

export function pluginStateChanged(sessionId: string, plugin: PluginBusName): void {
  for (const l of [...listeners]) l(sessionId, plugin)
}

/** Subscribes; returns the unsubscribe. */
export function onPluginStateChanged(l: Listener): () => void {
  listeners.add(l)
  return () => { listeners.delete(l) }
}
