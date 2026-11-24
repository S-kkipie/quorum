import UsageStrip from '../components/UsageStrip'
import ProjectCard from '../components/ProjectCard'
import { pendingByProject, projectAttention, projectSessions, workspaceProjects } from '../lib/projects'
import { lastActivity } from '../lib/sessions'
import type { AppState } from '../lib/store'

/** Board: projects grouped by workspace (columns on desktop, list on the phone). */
export default function Projects({ state, wide, selected, onOpen, onOpenSession, onConfig }: {
  state: AppState
  wide?: boolean
  selected?: string | null
  onOpen?: (id: string) => void
  onOpenSession?: (id: string) => void
  onConfig?: () => void
}) {
  const workspaces = Object.values(state.workspaces).sort((a, b) => a.name.localeCompare(b.name))
  const pending = pendingByProject(state)
  const orphans = Object.values(state.projects).filter((p) => !state.workspaces[p.workspaceId])

  if (workspaces.length === 0) {
    return (
      <div className="p-6 text-center text-sm text-muted-foreground">
        <p>No workspaces or projects yet.</p>
        {onConfig && <button onClick={onConfig} className="press mt-3 min-h-11 rounded-lg bg-accent px-4 text-on-accent hover:bg-accent/90">Open settings</button>}
      </div>
    )
  }
  const column = (key: string, title: string, color: string, projects: ReturnType<typeof workspaceProjects>) => {
    const list = [...projects].sort((a, b) => projectAttention(state, a.id) - projectAttention(state, b.id) || a.name.localeCompare(b.name))
    return (
    <section key={key} className={wide ? 'flex w-[300px] shrink-0 flex-col' : 'mt-4'}>
      <h2 className="flex items-start gap-2 px-3 pb-2 text-[13px] font-medium text-muted-foreground">
        <span className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color || '#71717a' }} />
        {title}
        <span className="font-normal">{list.length}</span>
      </h2>
      <div className="space-y-2 px-3">
        {list.length ? list.map((p) => (
          <ProjectCard key={p.id} project={p} sessions={projectSessions(state, p.id)} pending={pending[p.id] ?? 0} lastActivity={lastActivity(state, p.id)} active={p.id === selected} onOpen={onOpen} onOpenSession={onOpenSession} />
        )) : <p className="text-xs text-muted-foreground">No projects.</p>}
      </div>
    </section>
    )
  }
  return (
    <div className={wide ? 'flex h-full flex-col' : ''}>
      <UsageStrip usage={state.usage} />
      <div className={wide ? 'flex min-h-0 flex-1 gap-1 overflow-x-auto py-4' : 'pb-8'}>
        {workspaces.map((w) => column(w.id, w.name, w.color, workspaceProjects(state, w.id)))}
        {orphans.length > 0 && column('_', 'No workspace', '', orphans)}
      </div>
    </div>
  )
}
