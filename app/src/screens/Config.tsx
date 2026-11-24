import { useCallback, useEffect, useState } from 'react'
import ConnectorForm, { KINDS, connectorInput, draftFrom, validateConnector } from '../components/ConnectorForm'
import WorkspaceForm from '../components/WorkspaceForm'
import { createProject, deleteProject, listSuggestions, setProjectToken, syncProject, updateProject, type ProjectSuggestion } from '../lib/api'
import type { AppState } from '../lib/store'
import type { Project } from '../proto.gen'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

const field = 'mt-1 min-h-11 w-full rounded border border-zinc-800 bg-zinc-900 p-2 text-sm md:text-sm'
const h2 = 'mb-2 mt-6 text-xs font-semibold uppercase tracking-wide text-zinc-400'

/** Suggested name from the remote: git@github.com:o/my-repo.git → my-repo. */
export function repoName(url: string): string {
  return url.replace(/\.git$/, '').replace(/[\\/:]+$/, '').split(/[\\/:]/).pop() || url
}

export default function Config({ state, onBack, editProject }: { state: AppState; onBack?: () => void; editProject?: string | null }) {
  const [editWs, setEditWs] = useState<string | null>(null) // id, or '' = new
  const [editPr, setEditPr] = useState<string | null>(editProject ?? null) // id, '' = new
  const [prefill, setPrefill] = useState<{ repoURL: string; name: string } | null>(null)
  const [suggestions, setSuggestions] = useState<ProjectSuggestion[]>([])
  const [sugError, setSugError] = useState('')
  const workspaces = Object.values(state.workspaces).sort((a, b) => a.name.localeCompare(b.name))
  const projects = Object.values(state.projects).sort((a, b) => a.name.localeCompare(b.name))

  const loadSuggestions = useCallback(() => {
    listSuggestions().then((x) => { setSuggestions(x ?? []); setSugError('') }).catch((e) => setSugError(e instanceof Error ? e.message : 'error'))
  }, [])
  useEffect(loadSuggestions, [loadSuggestions])

  const closeProject = () => {
    // opened from a project's "Edit": when done it goes back to it
    if (editProject && editPr === editProject && onBack) { onBack(); return }
    setEditPr(null); setPrefill(null); loadSuggestions()
  }

  return (
    <div className="mx-auto max-w-2xl pb-10">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-zinc-800 bg-zinc-950/90 px-3 py-2 backdrop-blur">
        {onBack && <Button variant="ghost" onClick={onBack} aria-label="Back" className="min-h-11 min-w-11 text-zinc-400">←</Button>}
        <h2 className="text-base font-semibold">Settings</h2>
      </header>
      <div className="px-3">
        <h3 className={h2}>Workspaces</h3>
        <ul className="space-y-2">
          {workspaces.map((w) => (
            <li key={w.id}>
              {editWs === w.id ? <WorkspaceForm workspace={w} onDone={() => setEditWs(null)} onCancel={() => setEditWs(null)} /> : (
                <Card className="flex-row items-center gap-2 rounded border-zinc-800 bg-transparent px-3 py-2 text-sm shadow-none">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: w.color || '#71717a' }} />
                  <span className="min-w-0 flex-1 truncate">{w.name}{w.whoasProfile && <span className="text-xs text-zinc-500"> · whoas {w.whoasProfile}</span>}</span>
                  <Button variant="ghost" size="sm" onClick={() => setEditWs(w.id)} className="min-h-11 text-xs text-blue-400">Edit</Button>
                </Card>
              )}
            </li>
          ))}
        </ul>
        {editWs === '' ? <div className="mt-2"><WorkspaceForm onDone={() => setEditWs(null)} onCancel={() => setEditWs(null)} /></div>
          : <Button variant="secondary" size="sm" onClick={() => setEditWs('')} className="mt-2 min-h-11 text-xs">New workspace</Button>}

        <h3 className={h2}>Projects</h3>
        {workspaces.length === 0 && <p className="text-xs text-zinc-600">Create a workspace first.</p>}
        <ul className="space-y-2">
          {projects.map((p) => (
            <li key={p.id}>
              {editPr === p.id ? <ProjectForm state={state} project={p} onDone={closeProject} /> : (
                <Card className="flex-row items-center gap-2 rounded border-zinc-800 bg-transparent px-3 py-2 text-sm shadow-none">
                  <span className="min-w-0 flex-1 truncate">
                    {p.name}
                    <span className="text-xs text-zinc-500"> · {state.workspaces[p.workspaceId]?.name ?? 'no workspace'} · {KINDS.find(([k]) => k === p.connector?.kind)?.[1] ?? p.connector?.kind}</span>
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => { setPrefill(null); setEditPr(p.id) }} className="min-h-11 text-xs text-blue-400">Edit</Button>
                </Card>
              )}
            </li>
          ))}
        </ul>
        {workspaces.length > 0 && (editPr === '' ? <div className="mt-2"><ProjectForm key={prefill?.repoURL ?? ''} state={state} prefill={prefill} onDone={closeProject} /></div>
          : <Button variant="secondary" size="sm" onClick={() => { setPrefill(null); setEditPr('') }} className="mt-2 min-h-11 text-xs">New project</Button>)}

        <h3 className={h2}>Project suggestions</h3>
        {sugError && <p role="alert" className="text-xs text-red-400">{sugError}</p>}
        {suggestions.length === 0 ? <p className="text-xs text-zinc-600">No suggestions: they come from repos where there were sessions and that do not belong to any project yet.</p> : (
          <ul className="space-y-2">
            {suggestions.map((s) => (
              <li key={s.repoURL}><Card className="flex-row items-center gap-2 rounded border-zinc-800 bg-transparent px-3 py-2 text-sm shadow-none">
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{s.repoURL}</span>
                  <span className="block truncate text-xs text-zinc-500">
                    {s.roots.map((r) => `${r.machine}:${r.root}`).join(', ')}{s.sessions ? ` · ${s.sessions} ${s.sessions === 1 ? 'session' : 'sessions'}` : ''}
                  </span>
                </span>
                <Button size="sm" disabled={workspaces.length === 0} onClick={() => { setPrefill({ repoURL: s.repoURL, name: repoName(s.repoURL) }); setEditPr('') }}
                  className="min-h-11 text-xs">Create project</Button>
              </Card></li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function ProjectForm({ state, project, prefill, onDone }: { state: AppState; project?: Project; prefill?: { repoURL: string; name: string } | null; onDone: () => void }) {
  const p = project
  const workspaces = Object.values(state.workspaces).sort((a, b) => a.name.localeCompare(b.name))
  const [name, setName] = useState(p?.name ?? prefill?.name ?? '')
  const [ws, setWs] = useState(p?.workspaceId ?? workspaces[0]?.id ?? '')
  const [repo, setRepo] = useState(p?.repoUrl ?? prefill?.repoURL ?? '')
  const [conn, setConn] = useState(() => draftFrom(p?.connector))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const hasToken = state.projects[p?.id ?? '']?.connector?.hasToken ?? false

  async function save() {
    const bad = validateConnector(conn)
    if (bad) { setError(bad); return }
    setBusy(true)
    setError('')
    try {
      const body = { name: name.trim(), workspaceId: ws, repoURL: repo.trim(), connector: connectorInput(conn) }
      const saved = p ? await updateProject(p.id, body) : await createProject(body)
      if (conn.token || (conn.clearToken && hasToken)) await setProjectToken(saved.id, conn.clearToken ? '' : conn.token)
      // sync right away (otherwise the first pass only comes with the interval)
      if (conn.kind !== 'none') await syncProject(saved.id).catch(() => {})
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'error')
    } finally {
      setBusy(false)
    }
  }
  async function remove() {
    if (!p || !confirm(`Delete project "${p.name}"? Its tickets are deleted in Quorum (not in the ticket source).`)) return
    setBusy(true)
    try { await deleteProject(p.id); onDone() } catch (e) { setError(e instanceof Error ? e.message : 'error'); setBusy(false) }
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); save() }} aria-label={p ? 'Edit project' : 'New project'} className="rounded border border-zinc-800 bg-zinc-950 p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-xs text-zinc-400">Name
          <Input value={name} onChange={(e) => setName(e.target.value)} className={field} />
        </label>
        <label className="block text-xs text-zinc-400">Workspace
          <select value={ws} onChange={(e) => setWs(e.target.value)} className={field}>
            {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </label>
      </div>
      <label className="mt-3 block text-xs text-zinc-400">Repository (git remote)
        <Input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="git@github.com:owner/repo.git" className={field} />
        <span className="mt-1 block text-[11px] text-zinc-600">Sessions in checkouts with this remote are linked to the project automatically.</span>
      </label>
      <ConnectorForm value={conn} onChange={setConn} hasToken={hasToken} />
      {error && <p role="alert" className="mt-2 text-xs text-red-400">{error}</p>}
      <div className="mt-3 flex items-center justify-end gap-2">
        {p && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={remove} className="mr-auto min-h-11 text-xs text-red-400">Delete</Button>}
        <Button type="button" variant="secondary" className="min-h-11" onClick={onDone}>Cancel</Button>
        <Button type="submit" className="min-h-11" disabled={busy || !name.trim() || !ws}>Save</Button>
      </div>
    </form>
  )
}
