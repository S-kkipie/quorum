import type { ConnectorConfig } from '../proto.gen'
import type { ConnectorInput } from '../lib/api'

export interface ConnectorDraft {
  kind: string
  settings: Record<string, string>
  intervalMin: number
  /** Token nuevo a guardar (vacío = no se toca). Nunca se precarga: el hub no lo devuelve. */
  token: string
  clearToken: boolean
}

export const KINDS: [string, string][] = [
  ['none', 'Sin ticketera'],
  ['github', 'GitHub Issues'],
  ['paperclip', 'Paperclip'],
  ['exec', 'Ejecutable (script propio)'],
]

const usesToken = (kind: string) => kind === 'paperclip' || kind === 'exec'

export function draftFrom(c?: ConnectorConfig): ConnectorDraft {
  return { kind: c?.kind || 'none', settings: { ...(c?.settings ?? {}) }, intervalMin: c?.intervalMin || 5, token: '', clearToken: false }
}

/** Lo que va al PATCH/POST del proyecto (sin token: va aparte, por PUT). */
export function connectorInput(d: ConnectorDraft): ConnectorInput {
  const settings = Object.fromEntries(Object.entries(d.settings).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v !== ''))
  return { kind: d.kind, settings, intervalMin: d.kind === 'none' ? 0 : d.intervalMin }
}

/** Error de validación en español, o "" si está bien. */
export function validateConnector(d: ConnectorDraft): string {
  const s = (k: string) => (d.settings[k] ?? '').trim()
  if (d.kind === 'exec' && !s('command')) return 'falta el comando del conector'
  if (d.kind === 'exec' && s('statusMap')) {
    try {
      const m = JSON.parse(s('statusMap'))
      if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error()
    } catch { return 'el mapa de estados debe ser un objeto JSON, p. ej. {"waiting":"bloqueado"}' }
  }
  if (d.kind === 'github' && !/^[\w.-]+\/[\w.-]+$/.test(s('repo'))) return 'el repositorio debe ser owner/nombre'
  if (d.kind === 'paperclip') {
    if (!/^https?:\/\/\S+$/.test(s('baseURL'))) return 'la URL de Paperclip debe empezar con http:// o https://'
    if (!s('companyId')) return 'falta el id de la company'
  }
  if (d.kind !== 'none' && !(d.intervalMin >= 1 && d.intervalMin <= 60)) return 'el intervalo debe estar entre 1 y 60 minutos'
  return ''
}

const field = 'mt-1 w-full rounded border border-zinc-800 bg-zinc-900 p-2 text-sm'

export default function ConnectorForm({ value, onChange, hasToken }: { value: ConnectorDraft; onChange: (d: ConnectorDraft) => void; hasToken?: boolean }) {
  const d = value
  const set = (k: string, v: string) => onChange({ ...d, settings: { ...d.settings, [k]: v } })
  const text = (k: string, label: string, placeholder = '', hint = '') => (
    <label className="mt-3 block text-xs text-zinc-400">{label}
      <input aria-label={label} value={d.settings[k] ?? ''} onChange={(e) => set(k, e.target.value)} placeholder={placeholder} className={field} />
      {hint && <span className="mt-1 block text-[11px] text-zinc-600">{hint}</span>}
    </label>
  )
  return (
    <fieldset className="mt-3 rounded border border-zinc-800 p-3">
      <legend className="px-1 text-xs text-zinc-400">Ticketera</legend>
      <label className="block text-xs text-zinc-400">Conector
        <select value={d.kind} onChange={(e) => onChange({ ...d, kind: e.target.value, settings: e.target.value === d.kind ? d.settings : {} })} className={field}>
          {KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </label>
      {d.kind === 'github' && (
        <>
          {text('repo', 'Repositorio', 'owner/nombre', 'Usa la cuenta de gh que elija whoas para el trabajo.')}
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={(d.settings.labelsAsStatus ?? '') === 'true'} onChange={(e) => set('labelsAsStatus', e.target.checked ? 'true' : '')} />
            Leer el estado de las labels
          </label>
        </>
      )}
      {d.kind === 'paperclip' && (
        <>
          {text('baseURL', 'URL de la instancia', 'https://paperclip.ejemplo')}
          {text('companyId', 'Company')}
          {text('projectId', 'Proyecto de Paperclip (opcional)')}
        </>
      )}
      {d.kind === 'exec' && (
        <>
          {text('command', 'Comando', '/ruta/al/conector.sh', 'Sin shell: el programa y sus argumentos separados por espacios.')}
          <label className="mt-3 block text-xs text-zinc-400">Mapa de estados (JSON, opcional)
            <textarea value={d.settings.statusMap ?? ''} onChange={(e) => set('statusMap', e.target.value)} rows={2} placeholder='{"waiting":"bloqueado"}' className={field + ' font-mono'} />
          </label>
        </>
      )}
      {usesToken(d.kind) && (
        <label className="mt-3 block text-xs text-zinc-400">Token
          <input aria-label="Token" type="password" autoComplete="new-password" value={d.token} onChange={(e) => onChange({ ...d, token: e.target.value, clearToken: false })}
            placeholder={hasToken && !d.clearToken ? 'guardado · escribe para reemplazarlo' : 'sin token'} className={field} />
          {hasToken && (
            <span className="mt-1 flex items-center gap-2 text-[11px] text-zinc-500">
              {d.clearToken ? 'Se borrará al guardar.' : 'Solo de escritura: no se muestra.'}
              <button type="button" onClick={() => onChange({ ...d, token: '', clearToken: !d.clearToken })} className="text-red-400 underline">
                {d.clearToken ? 'No borrar' : 'Borrar token'}
              </button>
            </span>
          )}
        </label>
      )}
      {d.kind !== 'none' && (
        <label className="mt-3 block text-xs text-zinc-400">Sincronizar cada (minutos)
          <input type="number" min={1} max={60} value={d.intervalMin} onChange={(e) => onChange({ ...d, intervalMin: Number(e.target.value) })} className={field} />
        </label>
      )}
    </fieldset>
  )
}
