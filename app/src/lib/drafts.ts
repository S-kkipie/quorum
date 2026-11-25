import { useCallback, useEffect, useRef, useState } from 'react'

const PREFIX = 'quorum.draft.'
const INDEX = 'quorum.draft.index'
const MAX = 30
const DEBOUNCE_MS = 300

interface Entry { id: string; at: number }

function readIndex(): Entry[] {
  try {
    const v = JSON.parse(localStorage.getItem(INDEX) ?? '[]')
    return Array.isArray(v) ? v.filter((e) => e && typeof e.id === 'string') : []
  } catch { return [] }
}

function writeIndex(list: Entry[]) {
  try { localStorage.setItem(INDEX, JSON.stringify(list)) } catch { /* ignore */ }
}

/**
 * Text typed but not yet saved (inside the debounce). A composer that mounts while another one for
 * the same id is still pending (the session view remounts when the layout crosses a breakpoint, and
 * the old composer only flushes when it unmounts, after the new one has rendered) reads it from here.
 */
const unsaved = new Map<string, string>()

export function loadDraft(id: string): string {
  const u = unsaved.get(id)
  if (u !== undefined) return u
  try { return localStorage.getItem(PREFIX + id) ?? '' } catch { return '' }
}

export function clearDraft(id: string): void {
  unsaved.delete(id)
  try { localStorage.removeItem(PREFIX + id) } catch { /* ignore */ }
  writeIndex(readIndex().filter((e) => e.id !== id))
}

export function saveDraft(id: string, text: string): void {
  unsaved.delete(id)
  if (!text) { clearDraft(id); return }
  try { localStorage.setItem(PREFIX + id, text) } catch { return }
  const list = readIndex().filter((e) => e.id !== id)
  list.push({ id, at: Date.now() })
  list.sort((a, b) => a.at - b.at)
  while (list.length > MAX) {
    const old = list.shift()!
    try { localStorage.removeItem(PREFIX + old.id) } catch { /* ignore */ }
  }
  writeIndex(list)
}

// Text state backed by a debounced localStorage draft keyed by id.
export function useDraft(id: string): [string, (t: string) => void, () => void] {
  const [state, setState] = useState(() => ({ id, text: loadDraft(id) }))
  const pending = useRef<{ id: string; text: string } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const flush = useCallback(() => {
    clearTimeout(timer.current)
    timer.current = undefined
    const p = pending.current
    pending.current = null
    if (p) saveDraft(p.id, p.text)
  }, [])

  // id changed: flush the old id's text under the old id, then load the new one.
  if (state.id !== id) setState({ id, text: loadDraft(id) })
  const prevId = useRef(id)
  useEffect(() => {
    if (prevId.current !== id) { flush(); prevId.current = id; setState({ id, text: loadDraft(id) }) }
  }, [id, flush])
  useEffect(() => flush, [flush])

  const set = useCallback((t: string) => {
    setState((s) => ({ ...s, text: t }))
    pending.current = { id, text: t }
    unsaved.set(id, t)
    clearTimeout(timer.current)
    timer.current = setTimeout(flush, DEBOUNCE_MS)
  }, [id, flush])

  const clear = useCallback(() => {
    clearTimeout(timer.current)
    timer.current = undefined
    pending.current = null
    clearDraft(id)
    setState((s) => ({ ...s, text: '' }))
  }, [id])

  return [state.id === id ? state.text : loadDraft(id), set, clear]
}
