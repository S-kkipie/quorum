import { useState } from 'react'
import { ChevronRight, Plus } from 'lucide-react'
import SessionCloseMenu from '../SessionCloseMenu'
import { stateStyle } from '../../lib/projects'
import { displayState } from '../../lib/sessions'
import { sessionTitle } from '../../lib/title'
import { sessionMeta, type Tree, type TreeProject } from '../../lib/tree'
import type { SessionInfo } from '../../proto.gen'

const COLLAPSED_KEY = 'quorum.sidebar.collapsed'

function loadCollapsed(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [])
  } catch { return new Set() }
}
function saveCollapsed(s: Set<string>) {
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...s])) } catch { /* kept in memory for this run */ }
}

// Rows are 36 px with a mouse and 44 px on touch screens (a tablet in landscape gets the desktop layout).
const ROW = 'flex min-h-9 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-[13px] pointer-coarse:min-h-11'

/** One session: state dot, the name on one line (full name in the tooltip) and the short meta. */
export function SessionItem({ s, active, pinned, indent, project, now, onOpen }: {
  s: SessionInfo
  active: boolean
  /** The pinned Needs-you copy of a row that is also in the tree: highlighted, but not aria-current. */
  pinned?: boolean
  indent?: boolean
  /** The project name under the title (lists that mix projects). */
  project?: string
  now: number
  onOpen: (id: string) => void
}) {
  const [error, setError] = useState('')
  const display = displayState(s)
  const st = stateStyle(display)
  const title = sessionTitle(s).title
  const meta = sessionMeta(s, now)
  return (
    <li className="group/row min-w-0">
      <div className="flex min-w-0 items-center">
        <button type="button" data-session={s.id} title={title} aria-current={active && !pinned ? 'page' : undefined} onClick={() => onOpen(s.id)}
          className={`${ROW} flex-1 ${indent ? 'pl-7' : ''} ${active ? 'bg-surface text-ink ring-1 ring-line' : 'text-ink hover:bg-chip'}`}>
          <span role="img" aria-label={display === 'done' ? 'Unread' : st.label} className={`h-2 w-2 shrink-0 rounded-full ${st.dot}`} />
          <span className="min-w-0 flex-1">
            <span data-name className="block truncate">{title}</span>
            {project && <span className="block truncate text-xs text-muted-foreground">{project}</span>}
          </span>
          {meta && <span className="shrink-0 text-xs text-muted-foreground">{meta}</span>}
        </button>
        {s.role !== 'service' && (
          // a mouse sees it on hover or focus; a touch screen always (and it keeps its 44 px)
          <SessionCloseMenu id={s.id} onError={setError} className="size-9 pointer-fine:opacity-0 pointer-fine:group-hover/row:opacity-100 pointer-fine:group-focus-within/row:opacity-100 data-[state=open]:opacity-100 pointer-coarse:size-11" />
        )}
      </div>
      {error && <p role="alert" className="px-2 pb-1 text-xs text-danger">{error}</p>}
    </li>
  )
}

/** The job → project → session tree. Projects expand and collapse (remembered per device). */
export default function SessionTree({ tree, selected, filtering, now, onOpenSession, onOpenProject, onLaunch }: {
  tree: Tree
  /** The session in the centre. */
  selected: string | null
  /** A search is active: every project shows expanded and empty groups are gone. */
  filtering: boolean
  now: number
  onOpenSession: (id: string) => void
  onOpenProject: (id: string) => void
  onLaunch: (scope: { projectId?: string; workspaceId?: string }) => void
}) {
  const [collapsed, setCollapsed] = useState(loadCollapsed)
  const toggle = (id: string) => setCollapsed((c) => {
    const n = new Set(c)
    if (n.has(id)) n.delete(id); else n.add(id)
    saveCollapsed(n)
    return n
  })
  const project = (p: TreeProject) => {
    const open = filtering || !collapsed.has(p.id)
    return (
      <li key={p.id} className="min-w-0">
        <div className="flex min-w-0 items-center">
          <button type="button" aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${p.name}`} onClick={() => toggle(p.id)}
            className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-chip hover:text-ink pointer-coarse:size-11">
            <ChevronRight size={14} aria-hidden className={`motion-safe:transition-transform ${open ? 'rotate-90' : ''}`} />
          </button>
          <button type="button" onClick={() => onOpenProject(p.id)}
            className="flex min-h-9 min-w-0 flex-1 items-center rounded-lg px-1 text-left text-[12.5px] font-medium text-ink hover:bg-chip pointer-coarse:min-h-11">
            <span className="truncate" title={p.name}>{p.name}</span>
          </button>
        </div>
        {open && (p.sessions.length > 0 ? (
          <ul className="min-w-0">
            {p.sessions.map((s) => <SessionItem key={s.id} s={s} indent active={s.id === selected} now={now} onOpen={onOpenSession} />)}
          </ul>
        ) : (
          <p className="flex min-h-9 items-center pl-7 text-[12.5px] text-muted-foreground pointer-coarse:min-h-11">
            No sessions ·&nbsp;
            <button type="button" onClick={() => onLaunch({ projectId: p.id })} className="min-h-9 text-accent hover:underline pointer-coarse:min-h-11">Start one</button>
          </p>
        ))}
      </li>
    )
  }
  const flat = (key: string, label: string, list: SessionInfo[]) => list.length > 0 && (
    <section key={key} aria-label={label} className="mt-2 min-w-0">
      <h2 className="px-2 pb-1 pt-2 text-xs text-muted-foreground">{label}</h2>
      <ul className="min-w-0">{list.map((s) => <SessionItem key={s.id} s={s} active={s.id === selected} now={now} onOpen={onOpenSession} />)}</ul>
    </section>
  )
  return (
    <>
      {tree.jobs.map((j) => (
        <section key={j.id || '_'} aria-label={j.name} className="mt-2 min-w-0">
          <div className="flex min-w-0 items-center gap-2 pl-2">
            <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-muted-foreground" style={j.color ? { background: j.color } : undefined} />
            <h2 className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={j.name}>{j.name}</h2>
            <button type="button" aria-label={`New session in ${j.name}`} title={`New session in ${j.name}`} onClick={() => onLaunch(j.id ? { workspaceId: j.id } : {})}
              className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-chip hover:text-ink pointer-coarse:size-11">
              <Plus size={14} aria-hidden />
            </button>
          </div>
          {j.projects.length > 0
            ? <ul className="min-w-0">{j.projects.map(project)}</ul>
            : <p className="px-2 pb-1 text-[12.5px] text-muted-foreground">No projects.</p>}
        </section>
      ))}
      {flat('loose', 'Other sessions', tree.loose)}
      {flat('services', 'Services', tree.services)}
    </>
  )
}
