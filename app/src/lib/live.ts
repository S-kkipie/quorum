import type { Envelope } from '../proto.gen'
import { apiFetch, getToken, hubUrl } from './api'

export interface Live {
  close(): void
}

export function liveUrl(): string {
  const base = hubUrl() || (typeof location !== 'undefined' ? location.origin : '')
  return base.replace(/^http/i, 'ws') + '/api/live?token=' + encodeURIComponent(getToken())
}

/** Conecta al feed en vivo con reconexión (1 s → 15 s, duplicando). */
export function connectLive(onEnvelope: (e: Envelope) => void, onStatus?: (connected: boolean) => void): Live {
  let ws: WebSocket | null = null
  let delay = 1000
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let fails = 0

  const open = () => {
    if (stopped) return
    const sock = new WebSocket(liveUrl())
    ws = sock
    sock.onopen = () => {
      delay = 1000
      fails = 0
      onStatus?.(true)
    }
    sock.onmessage = (m) => {
      try { onEnvelope(JSON.parse(m.data)) } catch { /* mensaje inválido */ }
    }
    sock.onclose = () => {
      if (stopped || ws !== sock) return
      onStatus?.(false)
      // Token revocado: tras 3 fallos seguidos, un REST autenticado dispara el flujo 401.
      if (++fails === 3) apiFetch('/api/machines').catch(() => {})
      timer = setTimeout(open, delay)
      delay = Math.min(delay * 2, 15000)
    }
    sock.onerror = () => sock.close()
  }
  open()

  return {
    close() {
      stopped = true
      clearTimeout(timer)
      ws?.close()
    },
  }
}
