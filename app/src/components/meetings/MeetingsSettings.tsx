import { useEffect, useState } from 'react'
import { getMeetingSettings, meetingDisk, putMeetingSettings, type MeetingSettings } from '../../lib/meetingsApi'
import type { AppState } from '../../lib/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import MeetingsList, { useMeetings } from './MeetingsList'
import UploadMeeting from './UploadMeeting'
import { LANGUAGES, PROVIDERS, bytes } from './util'

const field = 'mt-1 min-h-11 w-full rounded-lg border border-line bg-surface p-2 text-sm md:text-sm'
const h4 = 'mb-2 mt-4 text-[13px] font-medium text-muted-foreground'
const DEFAULT_MODEL: Record<string, string> = { local: 'gemma3:12b', ccapi: 'sonnet', 'openai-compatible': '' }

const hostOf = (u: string) => { try { return new URL(u).host.toLowerCase() } catch { return u } }

/** What a machine's caps say about its meeting worker. */
export function workerState(c: { transcribe?: boolean; meetingWorker?: string } | undefined): { text: string; ok: boolean } {
  switch (c?.meetingWorker) {
    case 'ready': return { text: c.transcribe ? 'Ready: GPU found, models downloaded' : 'Set up', ok: !!c.transcribe }
    case 'no_gpu': return { text: 'Set up, but no CUDA GPU found', ok: false }
    case 'incomplete': return { text: 'The setup did not finish: run quorumd meetings setup again', ok: false }
    default: return { text: 'Not set up (quorumd meetings setup)', ok: false }
  }
}

/** Settings → Meetings: summary provider, default language, names I go by, workers, hub disk and the inbox. */
export default function MeetingsSettings({ state, onOpenMeeting }: { state: AppState; onOpenMeeting?: (id: string) => void }) {
  const [saved, setSaved] = useState<MeetingSettings | null>(null)
  const [provider, setProvider] = useState('local')
  const [model, setModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [language, setLanguage] = useState('es')
  const [aliases, setAliases] = useState('')
  const [correct, setCorrect] = useState(true)
  // the key field is write-only: it starts empty and is cleared after every save
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [ok, setOk] = useState(false)
  const [disk, setDisk] = useState<{ audioBytes: number; freeBytes: number } | null>(null)
  // an upload finished: refetch at once (the meeting_changed may come a moment later)
  const [uploads, setUploads] = useState(0)
  const inbox = useMeetings({ unassigned: true }, `${state.meetingsRev ?? 0}:${uploads}`)

  const show = (s: MeetingSettings) => {
    setSaved(s)
    setProvider(s.provider || 'local')
    setModel(s.model || '')
    setBaseUrl(s.baseUrl || '')
    setLanguage(s.language || 'es')
    setAliases((s.aliases ?? []).join(', '))
    setCorrect(s.correct !== false)
  }
  useEffect(() => {
    getMeetingSettings().then(show).catch((e) => setError(e instanceof Error ? e.message : 'error'))
    meetingDisk().then(setDisk).catch(() => { /* optional */ })
  }, [])

  async function save(b: Parameters<typeof putMeetingSettings>[0]) {
    setBusy(true)
    setError('')
    setOk(false)
    try {
      const s = await putMeetingSettings(b)
      show(s)
      setKey('')
      setOk(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'error')
    } finally {
      setBusy(false)
    }
  }
  const submit = () => save({
    provider: provider as MeetingSettings['provider'], model: model.trim(), baseUrl: baseUrl.trim(), language,
    aliases: aliases.split(',').map((a) => a.trim()).filter(Boolean), correct,
    ...(key.trim() ? { key: key.trim() } : {}),
  })

  // a model belongs to its provider: another provider starts from its default (the saved one keeps its model)
  const changeProvider = (p: string) => {
    setProvider(p)
    setModel(saved && p === (saved.provider || 'local') ? saved.model || '' : DEFAULT_MODEL[p] ?? '')
  }

  const machines = Object.values(state.machines).sort((a, b) => a.name.localeCompare(b.name))
  const openai = provider === 'openai-compatible'
  // the hub drops the saved key when the base URL moves to another host
  const hostMoved = !!saved?.baseUrl && hostOf(baseUrl.trim()) !== hostOf(saved.baseUrl)
  return (
    <div className="min-w-0">
      <form aria-label="Meetings settings" onSubmit={(e) => { e.preventDefault(); void submit() }} className="rounded-xl border border-line bg-surface p-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block min-w-0 text-xs text-muted-foreground">Summary provider
            <select value={provider} onChange={(e) => changeProvider(e.target.value)} className={field}>
              {PROVIDERS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          <label className="block min-w-0 text-xs text-muted-foreground">Model
            <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder={DEFAULT_MODEL[provider] || 'model name'} className={field} />
          </label>
        </div>
        {openai && (
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <label className="block min-w-0 text-xs text-muted-foreground">Base URL
              <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" inputMode="url" className={field} />
            </label>
            <label className="block min-w-0 text-xs text-muted-foreground">API key
              <Input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={saved?.hasKey ? 'Saved' : 'Not set'} className={field} />
              {saved?.hasKey && (hostMoved
                ? <span className="mt-1 block text-warning">A new host does not get the saved key: enter it again.</span>
                : <span className="mt-1 block">Saved. Type a new key to replace it.</span>)}
            </label>
          </div>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          {provider === 'local' ? 'The laptop summarises with Ollama: nothing leaves your machines.' : 'Only the transcript text is sent to this provider, never the audio.'}
        </p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <label className="block min-w-0 text-xs text-muted-foreground">Default language
            <select value={language} onChange={(e) => setLanguage(e.target.value)} className={field}>
              {LANGUAGES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          <label className="block min-w-0 text-xs text-muted-foreground">Names I go by
            <Input value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="e.g. Brax, Bri" className={field} />
            <span className="mt-1 block">Comma-separated. Actions owned by these names are yours.</span>
          </label>
        </div>
        <label className="mt-2 flex min-h-11 items-start gap-2 text-sm text-ink">
          <input type="checkbox" role="switch" checked={correct} onChange={(e) => setCorrect(e.target.checked)} className="mt-3 size-4 shrink-0" />
          <span className="min-w-0 py-2">Correct transcripts with Claude
            <span className="block text-xs text-muted-foreground">Only when summaries run through ccapi</span>
          </span>
        </label>
        {error && <p role="alert" className="mt-2 text-xs text-danger [overflow-wrap:anywhere]">{error}</p>}
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          {ok && <span role="status" className="mr-auto text-xs text-success">Saved</span>}
          {openai && saved?.hasKey && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void save({ key: '' })} className="min-h-11 text-xs text-danger">Remove key</Button>}
          <Button type="submit" disabled={busy || !saved} className="min-h-11">Save</Button>
        </div>
      </form>

      <h4 className={h4}>Transcription workers</h4>
      {machines.length === 0 ? <p className="text-xs text-muted-foreground">No machines yet.</p> : (
        <ul aria-label="Transcription workers" className="space-y-1 text-xs">
          {machines.map((m) => {
            const w = workerState(m.caps)
            return (
              <li key={m.name} className="flex min-w-0 items-baseline gap-2">
                <span className={m.online ? 'text-success' : 'text-muted-foreground'} aria-label={m.online ? 'online' : 'offline'}>●</span>
                <span className="min-w-0 shrink truncate font-medium text-ink">{m.name}</span>
                <span className={`min-w-0 flex-1 [overflow-wrap:anywhere] ${w.ok ? 'text-success' : 'text-muted-foreground'}`}>{w.text}</span>
              </li>
            )
          })}
        </ul>
      )}

      <h4 className={h4}>Hub disk</h4>
      <p className="text-xs text-muted-foreground">
        {disk ? `Meeting audio uses ${bytes(disk.audioBytes)}; ${bytes(disk.freeBytes)} free. Audio is deleted 30 days after a meeting is ready.` : 'Unknown.'}
      </p>

      <h4 className={h4}>Inbox: unassigned meetings</h4>
      <div className="mb-2"><UploadMeeting projectId="" onUploaded={() => setUploads((n) => n + 1)} /></div>
      {inbox.error ? <p role="alert" className="text-xs text-danger">{inbox.error}</p>
        : inbox.list && <MeetingsList list={inbox.list} live={state.meetingLive ?? {}} onOpen={(id) => onOpenMeeting?.(id)} empty="No unassigned meetings. Recordings uploaded without a project wait here." />}
    </div>
  )
}
