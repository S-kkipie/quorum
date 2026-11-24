import type { ConnectorConfig } from '../proto.gen'
import type { ConnectorInput } from '../lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

export interface ConnectorDraft {
  kind: string
  settings: Record<string, string>
  intervalMin: number
  /** New token to save (empty = untouched). Never prefilled: the hub does not return it. */
  token: string
  clearToken: boolean
}

export const KINDS: [string, string][] = [
  ['none', 'No ticket source'],
  ['github', 'GitHub Issues'],
  ['paperclip', 'Paperclip'],
  ['exec', 'Executable (your own script)'],
]

const usesToken = (kind: string) => kind === 'paperclip' || kind === 'exec'

export function draftFrom(c?: ConnectorConfig): ConnectorDraft {
  return { kind: c?.kind || 'none', settings: { ...(c?.settings ?? {}) }, intervalMin: c?.intervalMin || 5, token: '', clearToken: false }
}

/** What goes into the project's PATCH/POST (without the token: it goes separately, via PUT). */
export function connectorInput(d: ConnectorDraft): ConnectorInput {
  const settings = Object.fromEntries(Object.entries(d.settings).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v !== ''))
  return { kind: d.kind, settings, intervalMin: d.kind === 'none' ? 0 : d.intervalMin }
}

/** Validation error, or "" if all is well. */
export function validateConnector(d: ConnectorDraft): string {
  const s = (k: string) => (d.settings[k] ?? '').trim()
  if (d.kind === 'exec' && !s('command')) return 'missing connector command'
  if (d.kind === 'exec' && s('statusMap')) {
    try {
      const m = JSON.parse(s('statusMap'))
      if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error()
    } catch { return 'the status map must be a JSON object, e.g. {"waiting":"blocked"}' }
  }
  if (d.kind === 'github' && !/^[\w.-]+\/[\w.-]+$/.test(s('repo'))) return 'the repository must be owner/name'
  if (d.kind === 'paperclip') {
    if (!/^https?:\/\/\S+$/.test(s('baseURL'))) return 'the Paperclip URL must start with http:// or https://'
    if (!s('companyId')) return 'missing company id'
  }
  if (d.kind !== 'none' && !(d.intervalMin >= 1 && d.intervalMin <= 60)) return 'the interval must be between 1 and 60 minutes'
  return ''
}

const field = 'mt-1 min-h-11 w-full rounded border border-zinc-800 bg-zinc-900 p-2 text-sm md:text-sm'

export default function ConnectorForm({ value, onChange, hasToken }: { value: ConnectorDraft; onChange: (d: ConnectorDraft) => void; hasToken?: boolean }) {
  const d = value
  const set = (k: string, v: string) => onChange({ ...d, settings: { ...d.settings, [k]: v } })
  const text = (k: string, label: string, placeholder = '', hint = '') => (
    <label className="mt-3 block text-xs text-zinc-400">{label}
      <Input aria-label={label} value={d.settings[k] ?? ''} onChange={(e) => set(k, e.target.value)} placeholder={placeholder} className={field} />
      {hint && <span className="mt-1 block text-[11px] text-zinc-600">{hint}</span>}
    </label>
  )
  return (
    <fieldset className="mt-3 rounded border border-zinc-800 p-3">
      <legend className="px-1 text-xs text-zinc-400">Ticket source</legend>
      <label className="block text-xs text-zinc-400">Connector
        <select value={d.kind} onChange={(e) => onChange({ ...d, kind: e.target.value, settings: e.target.value === d.kind ? d.settings : {} })} className={field}>
          {KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </label>
      {d.kind === 'github' && (
        <>
          {text('repo', 'Repository', 'owner/name', 'Uses the gh account whoas picks for the workspace.')}
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={(d.settings.labelsAsStatus ?? '') === 'true'} onChange={(e) => set('labelsAsStatus', e.target.checked ? 'true' : '')} />
            Read the status from labels
          </label>
        </>
      )}
      {d.kind === 'paperclip' && (
        <>
          {text('baseURL', 'Instance URL', 'https://paperclip.example')}
          {text('companyId', 'Company')}
          {text('projectId', 'Paperclip project (optional)')}
        </>
      )}
      {d.kind === 'exec' && (
        <>
          {text('command', 'Command', '/path/to/connector.sh', 'No shell: the program and its arguments separated by spaces.')}
          <label className="mt-3 block text-xs text-zinc-400">Status map (JSON, optional)
            <Textarea value={d.settings.statusMap ?? ''} onChange={(e) => set('statusMap', e.target.value)} rows={2} placeholder='{"waiting":"blocked"}' className={field + ' font-mono'} />
          </label>
        </>
      )}
      {usesToken(d.kind) && (
        <label className="mt-3 block text-xs text-zinc-400">Token
          <Input aria-label="Token" type="password" autoComplete="new-password" value={d.token} onChange={(e) => onChange({ ...d, token: e.target.value, clearToken: false })}
            placeholder={hasToken && !d.clearToken ? 'saved · type to replace it' : 'no token'} className={field} />
          {hasToken && (
            <span className="mt-1 flex items-center gap-2 text-[11px] text-zinc-500">
              {d.clearToken ? 'Will be deleted on save.' : 'Write-only: not shown.'}
              <Button type="button" variant="link" size="sm" onClick={() => onChange({ ...d, token: '', clearToken: !d.clearToken })} className="min-h-11 text-red-400">
                {d.clearToken ? 'Keep' : 'Delete token'}
              </Button>
            </span>
          )}
        </label>
      )}
      {d.kind !== 'none' && (
        <label className="mt-3 block text-xs text-zinc-400">Sync every (minutes)
          <Input type="number" min={1} max={60} value={d.intervalMin} onChange={(e) => onChange({ ...d, intervalMin: Number(e.target.value) })} className={field} />
        </label>
      )}
    </fieldset>
  )
}
