import { useCallback, useEffect, useState } from 'react'
import ConnectorForm, { KINDS, connectorInput, draftFrom, validateConnector } from '../components/ConnectorForm'
import WorkspaceForm from '../components/WorkspaceForm'
import { createProject, deleteProject, listSuggestions, setProjectToken, syncProject, updateProject, type ProjectSuggestion } from '../lib/api'
import type { AppState } from '../lib/store'
import type { Project } from '../proto.gen'

const field = 'mt-1 w-full rounded border border-zinc-800 bg-zinc-900 p-2 text-sm'
const h2 = 'mb-2 mt-6 text-xs font-semibold uppercase tracking-wide text-zinc-400'

/** Nombre sugerido a partir del remoto: git@github.com:o/mi-repo.git → mi-repo. */
export function repoName(url: string): string {
  return url.replace(/\.git$/, '').replace(/[\\/:]+$/, '').split(/[\\/:]/).pop() || url
}

export default function Config({ state, onBack, editProject }: { state: AppState; onBack?: () => void; editProject?: string | null }) {
  const [editWs, setEditWs] = useState<string | null>(null) // id, o '' = nuevo
  const [editPr, setEditPr] = useState<string | null>(editProject ?? null) // id, '' = nuevo
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
    // abierta desde "Editar" de un proyecto: al terminar vuelve a él
    if (editProject && editPr === editProject && onBack) { onBack(); return }
    setEditPr(null); setPrefill(null); loadSuggestions()
  }

  return (
    <div className="mx-auto max-w-2xl pb-10">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-zinc-800 bg-zinc-950/90 px-3 py-2 backdrop-blur">
        {onBack && <button onClick={onBack} aria-label="Volver" className="text-zinc-400">←</button>}
        <h2 className="text-base font-semibold">Configuración</h2>
      </header>
      <div className="px-3">
        <h3 className={h2}>Trabajos</h3>
        <ul className="space-y-2">
          {workspaces.map((w) => (
            <li key={w.id}>
              {editWs === w.id ? <WorkspaceForm workspace={w} onDone={() => setEditWs(null)} onCancel={() => setEditWs(null)} /> : (
                <div className="flex items-center gap-2 rounded border border-zinc-800 px-3 py-2 text-sm">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: w.color || '#71717a' }} />
                  <span className="min-w-0 flex-1 truncate">{w.name}{w.whoasProfile && <span className="text-xs text-zinc-500"> · whoas {w.whoasProfile}</span>}</span>
                  <button onClick={() => setEditWs(w.id)} className="text-xs text-blue-400">Editar</button>
                </div>
              )}
            </li>
          ))}
        </ul>
        {editWs === '' ? <div className="mt-2"><WorkspaceForm onDone={() => setEditWs(null)} onCancel={() => setEditWs(null)} /></div>
          : <button onClick={() => setEditWs('')} className="mt-2 rounded bg-zinc-800 px-3 py-1.5 text-xs">Nuevo trabajo</button>}

        <h3 className={h2}>Proyectos</h3>
        {workspaces.length === 0 && <p className="text-xs text-zinc-600">Crea primero un trabajo.</p>}
        <ul className="space-y-2">
          {projects.map((p) => (
            <li key={p.id}>
              {editPr === p.id ? <ProjectForm state={state} project={p} onDone={closeProject} /> : (
                <div className="flex items-center gap-2 rounded border border-zinc-800 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">
                    {p.name}
                    <span className="text-xs text-zinc-500"> · {state.workspaces[p.workspaceId]?.name ?? 'sin trabajo'} · {KINDS.find(([k]) => k === p.connector?.kind)?.[1] ?? p.connector?.kind}</span>
                  </span>
                  <button onClick={() => { setPrefill(null); setEditPr(p.id) }} className="text-xs text-blue-400">Editar</button>
                </div>
              )}
            </li>
          ))}
        </ul>
        {workspaces.length > 0 && (editPr === '' ? <div className="mt-2"><ProjectForm key={prefill?.repoURL ?? ''} state={state} prefill={prefill} onDone={closeProject} /></div>
          : <button onClick={() => { setPrefill(null); setEditPr('') }} className="mt-2 rounded bg-zinc-800 px-3 py-1.5 text-xs">Nuevo proyecto</button>)}

        <h3 className={h2}>Sugerencias de proyectos</h3>
        {sugError && <p role="alert" className="text-xs text-red-400">{sugError}</p>}
        {suggestions.length === 0 ? <p className="text-xs text-zinc-600">Sin sugerencias: salen de los repos donde hubo sesiones y que aún no son de ningún proyecto.</p> : (
          <ul className="space-y-2">
            {suggestions.map((s) => (
              <li key={s.repoURL} className="flex items-center gap-2 rounded border border-zinc-800 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{s.repoURL}</span>
                  <span className="block truncate text-xs text-zinc-500">
                    {s.roots.map((r) => `${r.machine}:${r.root}`).join(', ')}{s.sessions ? ` · ${s.sessions} ${s.sessions === 1 ? 'sesión' : 'sesiones'}` : ''}
                  </span>
                </span>
                <button disabled={workspaces.length === 0} onClick={() => { setPrefill({ repoURL: s.repoURL, name: repoName(s.repoURL) }); setEditPr('') }}
                  className="shrink-0 rounded bg-blue-600 px-2 py-1 text-xs text-white disabled:opacity-40">Crear proyecto</button>
              </li>
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
      // sincroniza al momento (si no, la primera vuelta llega con el intervalo)
      if (conn.kind !== 'none') await syncProject(saved.id).catch(() => {})
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'error')
    } finally {
      setBusy(false)
    }
  }
  async function remove() {
    if (!p || !confirm(`¿Borrar el proyecto «${p.name}»? Se borran sus tickets en Quorum (no en la ticketera).`)) return
    setBusy(true)
    try { await deleteProject(p.id); onDone() } catch (e) { setError(e instanceof Error ? e.message : 'error'); setBusy(false) }
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); save() }} aria-label={p ? 'Editar proyecto' : 'Nuevo proyecto'} className="rounded border border-zinc-800 bg-zinc-950 p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-xs text-zinc-400">Nombre
          <input value={name} onChange={(e) => setName(e.target.value)} className={field} />
        </label>
        <label className="block text-xs text-zinc-400">Trabajo
          <select value={ws} onChange={(e) => setWs(e.target.value)} className={field}>
            {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </label>
      </div>
      <label className="mt-3 block text-xs text-zinc-400">Repositorio (remoto git)
        <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="git@github.com:owner/repo.git" className={field} />
        <span className="mt-1 block text-[11px] text-zinc-600">Las sesiones en checkouts con este remoto se asocian solas al proyecto.</span>
      </label>
      <ConnectorForm value={conn} onChange={setConn} hasToken={hasToken} />
      {error && <p role="alert" className="mt-2 text-xs text-red-400">{error}</p>}
      <div className="mt-3 flex items-center justify-end gap-2">
        {p && <button type="button" disabled={busy} onClick={remove} className="mr-auto text-xs text-red-400">Borrar</button>}
        <button type="button" onClick={onDone} className="rounded bg-zinc-800 px-3 py-1.5 text-sm">Cancelar</button>
        <button type="submit" disabled={busy || !name.trim() || !ws} className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-40">Guardar</button>
      </div>
    </form>
  )
}
