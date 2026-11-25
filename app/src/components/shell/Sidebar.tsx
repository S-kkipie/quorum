import { useEffect, useMemo, useState, type Ref } from 'react'
import { PanelLeftClose, Settings } from 'lucide-react'
import { Logo } from '../Logo'
import { Button } from '../ui/button'
import type { AppState } from '../../lib/store'
import { sessionTree } from '../../lib/tree'
import SessionTree, { SessionItem } from './SessionTree'

/** "Now", refreshed every minute so the rows' relative times ("7m") stay current. */
function useMinuteClock(): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])
  return now
}

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

/** The desktop session sidebar: brand, search, pinned Needs you, the job → project → session tree, footer. */
export default function Sidebar({ state, selected, connected, width, searchRef, onOpenSession, onOpenProject, onLaunch, onSettings, onHide }: {
  state: AppState
  /** The session in the centre (aria-current). */
  selected: string | null
  connected: boolean
  width: number
  searchRef?: Ref<HTMLInputElement>
  onOpenSession: (id: string) => void
  onOpenProject: (id: string) => void
  onLaunch: (scope: { projectId?: string; workspaceId?: string }) => void
  onSettings: () => void
  onHide: () => void
}) {
  const [q, setQ] = useState('')
  const tree = useMemo(() => sessionTree(state, q), [state, q])
  const filtering = q.trim() !== ''
  const now = useMinuteClock()
  const empty = filtering && tree.needsYou.length === 0 && tree.jobs.length === 0 && tree.loose.length === 0 && tree.services.length === 0
  return (
    <aside style={{ width }} className="flex h-full min-w-0 shrink-0 flex-col bg-sidebar">
      <div className="flex items-center gap-1 px-3 pb-2 pt-3">
        <span className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold text-ink">
          <Logo size={20} className="shrink-0 text-accent" />
          Quorum
        </span>
        <Button variant="ghost" size="icon" onClick={onSettings} aria-label="Settings" title="Settings" className="size-9 text-muted-foreground hover:text-ink pointer-coarse:size-11">
          <Settings size={16} aria-hidden />
        </Button>
        <Button variant="ghost" size="icon" onClick={onHide} aria-label="Hide sidebar" title={`Hide sidebar (${isMac() ? '⌘' : 'Ctrl+'}B)`} className="size-9 text-muted-foreground hover:text-ink pointer-coarse:size-11">
          <PanelLeftClose size={16} aria-hidden />
        </Button>
      </div>
      <div className="px-3 pb-2">
        <input ref={searchRef} type="search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search sessions"
          placeholder={`Search sessions  ${isMac() ? '⌘K' : 'Ctrl K'}`}
          onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.preventDefault(); setQ('') } }}
          className="min-h-9 w-full rounded-lg border border-line bg-surface px-2.5 text-[13px] text-ink placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11" />
      </div>
      <nav aria-label="Sessions" className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 pb-2">
        {tree.needsYou.length > 0 && (
          <section aria-label="Needs you" className="min-w-0">
            <h2 className="flex justify-between px-2 pb-1 pt-1 text-xs text-muted-foreground"><span>Needs you</span><span>{tree.needsYou.length}</span></h2>
            <ul className="min-w-0">
              {tree.needsYou.map((s) => (
                <SessionItem key={s.id} s={s} active={s.id === selected} pinned now={now} onOpen={onOpenSession}
                  project={state.projects[s.projectId]?.name || s.machine} />
              ))}
            </ul>
          </section>
        )}
        <SessionTree tree={tree} selected={selected} filtering={filtering} now={now} onOpenSession={onOpenSession} onOpenProject={onOpenProject} onLaunch={onLaunch} />
        {empty && <p className="px-2 pt-3 text-[12.5px] text-muted-foreground">No matching sessions.</p>}
      </nav>
      <div className="flex items-center gap-2 border-t border-line px-3 py-2.5 text-xs text-muted-foreground">
        <Button onClick={() => onLaunch({})} className="min-h-9 flex-1 text-[12.5px] font-semibold pointer-coarse:min-h-11">New session</Button>
        <span className={`h-2 w-2 shrink-0 rounded-full ${connected ? 'bg-success' : 'bg-warning'}`} aria-hidden />
        <span className={connected ? 'text-success' : 'text-warning'}>{connected ? 'connected' : 'reconnecting…'}</span>
      </div>
    </aside>
  )
}
