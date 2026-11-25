import { useState, useSyncExternalStore } from 'react'

/** localStorage key of the per-device layout (sidebar width and visibility, docked inspector open). */
export const LAYOUT_KEY = 'quorum.layout'
export const SIDEBAR_MIN = 220
export const SIDEBAR_MAX = 380
export const SIDEBAR_DEFAULT = 270

/** The phone layout applies below 1024 px; the inspector docks from 1280 px and overlays in between. */
const DESKTOP_Q = '(min-width: 1024px)'
const DOCKED_Q = '(min-width: 1280px)'

export type LayoutMode = 'phone' | 'desktop'
export type InspectorMode = 'docked' | 'overlay' | 'sheet'

interface Stored {
  sidebarWidth: number
  sidebarOpen: boolean
  /**
   * Only the docked inspector's open state persists; an overlay or a sheet opens per session view
   * (closed whenever a session is opened).
   */
  inspector: { docked: boolean }
}

const defaults = (): Stored => ({ sidebarWidth: SIDEBAR_DEFAULT, sidebarOpen: true, inspector: { docked: true } })
export const clampWidth = (w: number) => Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w)))

function read(): Stored {
  const d = defaults()
  try {
    const v = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null')
    if (!v || typeof v !== 'object') return d
    const docked = v.inspector && typeof v.inspector === 'object' && typeof v.inspector.docked === 'boolean' ? v.inspector.docked : true
    return {
      sidebarWidth: typeof v.sidebarWidth === 'number' && Number.isFinite(v.sidebarWidth) ? clampWidth(v.sidebarWidth) : d.sidebarWidth,
      sidebarOpen: typeof v.sidebarOpen === 'boolean' ? v.sidebarOpen : d.sidebarOpen,
      inspector: { docked },
    }
  } catch { return d }
}

// One store for every useLayout() caller (the shell and the session's inspector share it).
let stored: Stored | null = null
const listeners = new Set<() => void>()
const current = () => (stored ??= read())
function write(next: Stored) {
  stored = next
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(next)) } catch { /* no storage: kept in memory for this run */ }
  listeners.forEach((l) => l())
}
const subscribeStore = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }

/** Forgets the in-memory copy so the next read comes from storage (tests). */
export function resetLayout() { stored = null }

const query = (q: string) => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(q) : null)
function placement(): InspectorMode {
  if (!query(DESKTOP_Q)?.matches) return 'sheet'
  return query(DOCKED_Q)?.matches ? 'docked' : 'overlay'
}
function subscribeMedia(l: () => void) {
  const ms = [query(DESKTOP_Q), query(DOCKED_Q)].filter((m): m is MediaQueryList => !!m)
  ms.forEach((m) => m.addEventListener('change', l))
  return () => ms.forEach((m) => m.removeEventListener('change', l))
}

const setSidebarWidth = (w: number) => {
  const c = current()
  const width = clampWidth(w)
  if (width !== c.sidebarWidth) write({ ...c, sidebarWidth: width })
}
const toggleSidebar = () => { const c = current(); write({ ...c, sidebarOpen: !c.sidebarOpen }) }
const toggleDocked = () => { const c = current(); write({ ...c, inspector: { docked: !c.inspector.docked } }) }

/**
 * The layout for the current window: breakpoint, sidebar width and visibility, inspector placement and
 * open state. The docked state is shared and persisted; the overlay and sheet state belongs to the
 * calling component (each session view starts with them closed).
 */
export function useLayout(): {
  mode: LayoutMode
  inspector: InspectorMode
  sidebarWidth: number
  setSidebarWidth: (w: number) => void
  sidebarOpen: boolean
  toggleSidebar: () => void
  inspectorOpen: boolean
  toggleInspector: () => void
} {
  const inspector = useSyncExternalStore(subscribeMedia, placement)
  const s = useSyncExternalStore(subscribeStore, current)
  const [floating, setFloating] = useState<Partial<Record<'overlay' | 'sheet', boolean>>>({})
  const docked = inspector === 'docked'
  return {
    mode: inspector === 'sheet' ? 'phone' : 'desktop',
    inspector,
    sidebarWidth: s.sidebarWidth,
    setSidebarWidth,
    sidebarOpen: s.sidebarOpen,
    toggleSidebar,
    inspectorOpen: docked ? s.inspector.docked : !!floating[inspector as 'overlay' | 'sheet'],
    toggleInspector: docked ? toggleDocked : () => setFloating((f) => ({ ...f, [inspector]: !f[inspector as 'overlay' | 'sheet'] })),
  }
}
