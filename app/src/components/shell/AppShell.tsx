import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { PanelLeftOpen } from 'lucide-react'
import { Logo } from '../Logo'
import { Button } from '../ui/button'
import type { Centre } from '../../lib/nav'
import type { AppState } from '../../lib/store'
import { SIDEBAR_MAX, SIDEBAR_MIN, clampWidth, useLayout } from '../../lib/useLayout'
import { shortcutBlocked } from '../../lib/shortcuts'
import Sidebar from './Sidebar'

const STEP = 10

/** Ctrl on Windows/Linux, ⌘ on macOS, never with Alt (AltGr types characters on some layouts). */
const mod = (e: globalThis.KeyboardEvent) => (e.ctrlKey || e.metaKey) && !e.altKey

/**
 * Desktop layout A: the persistent session sidebar (resizable, hideable) and the centre pane.
 * Ctrl/⌘+K focuses the search, Ctrl/⌘+B hides or shows the sidebar (neither while a modal dialog is open).
 */
export default function AppShell({ state, centre, connected, onOpenSession, onOpenProject, onLaunch, onSettings, children }: {
  state: AppState
  centre: Centre
  connected: boolean
  onOpenSession: (id: string) => void
  onOpenProject: (id: string) => void
  onLaunch: (scope: { projectId?: string; workspaceId?: string }) => void
  onSettings: () => void
  children: ReactNode
}) {
  const { sidebarOpen, toggleSidebar, sidebarWidth, setSidebarWidth } = useLayout()
  const search = useRef<HTMLInputElement>(null)
  // Ctrl+K with the sidebar hidden shows it first, then focuses the search once it is drawn
  const focusSearch = useRef(false)
  const open = useRef(sidebarOpen)
  open.current = sidebarOpen

  useEffect(() => {
    const h = (e: globalThis.KeyboardEvent) => {
      if (!mod(e) || e.shiftKey || shortcutBlocked(e)) return
      const k = e.key.toLowerCase()
      if (k === 'k') {
        e.preventDefault()
        if (open.current) search.current?.focus()
        else { focusSearch.current = true; toggleSidebar() }
      } else if (k === 'b') {
        e.preventDefault()
        toggleSidebar()
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [toggleSidebar])
  useEffect(() => {
    if (sidebarOpen && focusSearch.current) { focusSearch.current = false; search.current?.focus() }
  }, [sidebarOpen])

  // drag: the width follows the pointer from where the drag started; it stays local while dragging
  // and is stored (and shared) once, on release
  const drag = useRef<{ x: number; w: number } | null>(null)
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const dragged = useRef<number | null>(null)
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!drag.current) return
      dragged.current = clampWidth(drag.current.w + e.clientX - drag.current.x)
      setDragWidth(dragged.current)
    }
    const up = () => {
      if (!drag.current) return
      drag.current = null
      document.body.style.removeProperty('cursor')
      if (dragged.current !== null) setSidebarWidth(dragged.current)
      dragged.current = null
      setDragWidth(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [setSidebarWidth])
  const width = dragWidth ?? sidebarWidth
  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    drag.current = { x: e.clientX, w: sidebarWidth }
    document.body.style.cursor = 'col-resize'
  }
  const onKey = (e: KeyboardEvent) => {
    const to = e.key === 'ArrowLeft' ? sidebarWidth - STEP : e.key === 'ArrowRight' ? sidebarWidth + STEP
      : e.key === 'Home' ? SIDEBAR_MIN : e.key === 'End' ? SIDEBAR_MAX : null
    if (to === null) return
    e.preventDefault()
    setSidebarWidth(to)
  }

  const selected = centre.kind === 'session' ? centre.id : null
  return (
    <div className="app-shell flex bg-background">
      {sidebarOpen ? (
        <>
          <Sidebar state={state} selected={selected} connected={connected} width={width} searchRef={search}
            onOpenSession={onOpenSession} onOpenProject={onOpenProject} onLaunch={onLaunch} onSettings={onSettings} onHide={toggleSidebar} />
          <div role="separator" aria-orientation="vertical" aria-label="Resize sidebar" tabIndex={0}
            aria-valuenow={width} aria-valuemin={SIDEBAR_MIN} aria-valuemax={SIDEBAR_MAX}
            onPointerDown={onPointerDown} onKeyDown={onKey}
            className="relative z-10 -mx-1 w-2 shrink-0 cursor-col-resize touch-none outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:bg-line hover:after:w-0.5 hover:after:bg-accent focus-visible:after:w-0.5 focus-visible:after:bg-ring" />
        </>
      ) : (
        <div className="flex shrink-0 flex-col items-center gap-1 border-r border-line bg-sidebar px-1 py-3">
          <Logo size={20} className="text-accent" title="Quorum" />
          <Button variant="ghost" size="icon" onClick={toggleSidebar} aria-label="Show sidebar" title="Show sidebar" className="size-11 text-muted-foreground hover:text-ink">
            <PanelLeftOpen size={16} aria-hidden />
          </Button>
        </div>
      )}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</main>
    </div>
  )
}
