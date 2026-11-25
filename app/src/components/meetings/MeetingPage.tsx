import { useEffect, useRef, useState, type ReactNode } from 'react'
import { deleteMeeting, getMeeting, meetingAudioURL, nameSpeakers, patchMeeting, reprocessMeeting, retryMeeting } from '../../lib/meetingsApi'
import { addMeetingPending } from '../../lib/pendingsApi'
import type { AppState } from '../../lib/store'
import type { Meeting, MeetingPoint } from '../../proto.gen'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { MoreHorizontal, Pencil } from 'lucide-react'
import Section, { wrap } from '../briefing/Section'
import ActionRow from './ActionRow'
import Transcript from './Transcript'
import { BEFORE_TRANSCRIPT, LANGUAGES, PROVIDERS, clock, date, duration, liveStatus, meetingTitle, renameSegments, sortActions, stageText, statusText, statusTone } from './util'

const field = 'min-h-11 rounded-lg border border-line bg-surface px-2 text-sm'

/** A PATCH, retry or reprocess answers without the detail (summary, segments, actions): keep what the page has. */
const merge = (prev: Meeting | null, r: Meeting): Meeting => (prev ? {
  ...prev, ...r,
  summary: r.summary ?? prev.summary, segments: r.segments ?? prev.segments, actions: r.actions ?? prev.actions, speakers: r.speakers ?? prev.speakers,
} : r)

function Points({ items, onSeek, onAdd }: { items: MeetingPoint[]; onSeek: (ms: number) => void; onAdd?: (text: string) => Promise<void> }) {
  // per point (by text): the ones added, the one in flight and the last error
  const [added, setAdded] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<Record<string, string>>({})
  const add = async (text: string) => {
    if (!onAdd) return
    setBusy(text)
    setErr((p) => ({ ...p, [text]: '' }))
    try { await onAdd(text); setAdded((p) => ({ ...p, [text]: true })) } catch (e) { setErr((p) => ({ ...p, [text]: e instanceof Error ? e.message : 'error' })) } finally { setBusy(null) }
  }
  if (!items.length) return <p className="text-xs text-muted-foreground">None.</p>
  return (
    <ul className="divide-y divide-line">
      {items.map((x, i) => (
        <li key={i} className={`py-1.5 text-sm text-ink ${wrap}`}>
          {x.text}
          {!!x.tsMs && <> <button type="button" onClick={() => onSeek(x.tsMs!)} className="inline-flex min-h-11 items-center px-1 text-xs text-accent hover:underline">at {clock(x.tsMs)}</button></>}
          {onAdd && (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <button type="button" disabled={!!added[x.text] || busy === x.text} onClick={() => void add(x.text)}
                className="inline-flex min-h-11 items-center rounded-lg px-2 text-xs text-accent hover:underline disabled:text-muted-foreground disabled:no-underline">
                {added[x.text] ? 'Added' : 'Add as pending'}
              </button>
              {err[x.text] && <span role="alert" className={`text-xs text-danger ${wrap}`}>{err[x.text]}</span>}
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}

/** "How many people?" and the language, while the transcription has not run yet (or failed). */
function BeforeTranscript({ m, onPatch }: { m: Meeting; onPatch: (b: { speakers?: number; language?: string }) => Promise<void> }) {
  const [n, setN] = useState(m.speakerCount ? String(m.speakerCount) : '')
  useEffect(() => { setN(m.speakerCount ? String(m.speakerCount) : '') }, [m.speakerCount])
  const v = n.trim() === '' ? 0 : Number(n)
  const bad = !Number.isInteger(v) || v < 0 || v > 20
  return (
    <div className="flex min-w-0 flex-wrap items-end gap-2">
      <form className="flex min-w-0 items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (!bad && v !== m.speakerCount) void onPatch({ speakers: v }) }}>
        <label className="block text-xs text-muted-foreground">How many people?
          <Input type="number" inputMode="numeric" min={0} max={20} value={n} placeholder="Not sure" onChange={(e) => setN(e.target.value)}
            aria-invalid={bad} className="mt-1 min-h-11 w-28" />
        </label>
        <Button type="submit" variant="secondary" size="sm" disabled={bad || v === m.speakerCount} className="min-h-11">Save</Button>
      </form>
      <label className="block text-xs text-muted-foreground">Language
        <select value={m.language || ''} onChange={(e) => void onPatch({ language: e.target.value })} className={`mt-1 block ${field}`}>
          <option value="">Default</option>
          {LANGUAGES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </label>
      <p className="w-full text-xs text-muted-foreground">The number of people helps tell the voices apart. Leave it empty when you are not sure.</p>
    </div>
  )
}

/** The meeting page: header, processing status, summary, decisions, open points, actions, attendees and transcript. */
export default function MeetingPage({ state, id, onBack }: { state: AppState; id: string; onBack?: () => void }) {
  const [m, setM] = useState<Meeting | null>(null)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [editingTitle, setEditingTitle] = useState<string | null>(null)
  const [renamed, setRenamed] = useState(false)
  const [audio, setAudio] = useState('')
  // issues created from this view, by action id and text: a hub that could not link one still never gets a
  // second create for that action (a refetch or a re-summary may bring the action back without its link)
  const [issues, setIssues] = useState<{ byId: Record<string, string>; byText: Record<string, string> }>({ byId: {}, byText: {} })
  const player = useRef<HTMLAudioElement>(null)
  const pendingSeek = useRef<number | null>(null)
  const live = state.meetingLive?.[id]
  const rev = live?.rev ?? 0
  const seq = useRef(0)

  useEffect(() => {
    const n = ++seq.current
    getMeeting(id)
      .then((x) => { if (n === seq.current) { setM(x); setLoadError('') } })
      .catch((e) => { if (n === seq.current) setLoadError(e instanceof Error ? e.message : 'error') })
  }, [id, rev])
  useEffect(() => () => { seq.current++ }, [])

  const hasSegments = !!m?.segments?.length
  const hasAudio = !!m?.hasAudio
  // the playback link is valid for an hour: a page left open longer asks for a new one when the audio fails
  const [audioTry, setAudioTry] = useState(0)
  useEffect(() => {
    if (!hasSegments || !hasAudio) return
    let off = false
    meetingAudioURL(id).then((u) => { if (!off) setAudio(u) }).catch(() => { /* playback is optional */ })
    return () => { off = true }
  }, [id, hasSegments, hasAudio, audioTry])
  const audioAt = useRef(0)
  useEffect(() => { audioAt.current = Date.now() }, [audio])

  const back = onBack && <Button variant="ghost" onClick={onBack} aria-label="Back" className="min-h-11 min-w-11 shrink-0 text-muted-foreground">←</Button>
  if (live?.status === 'deleted') return <p className="flex items-center p-4 text-sm text-muted-foreground">{back}This meeting was deleted.</p>
  if (!m) return <p className="flex items-center p-4 text-sm text-muted-foreground [overflow-wrap:anywhere]">{back}{loadError ? `Meeting unavailable: ${loadError}` : 'Loading…'}</p>

  const act = async (fn: () => Promise<Meeting | void>) => {
    setError('')
    try { const r = await fn(); if (r) setM((p) => merge(p, r)) } catch (e) { setError(e instanceof Error ? e.message : 'error') }
  }
  const patch = (b: { title?: string; projectId?: string; language?: string; speakers?: number }) => act(() => patchMeeting(id, b))
  const seek = (ms: number) => {
    const a = player.current
    if (!a) { pendingSeek.current = ms; return }
    a.currentTime = ms / 1000
    try { void a.play()?.catch(() => {}) } catch { /* no playback here */ }
  }
  const rename = async (label: string, name: string) => {
    const before = m.segments
    setM((p) => (p ? { ...p, segments: renameSegments(p.segments ?? [], label, name) } : p))
    try {
      const r = await nameSpeakers(id, { [label]: name })
      setM((p) => merge(p, r))
    } catch (e) {
      setM((p) => (p ? { ...p, segments: before } : p))
      throw e
    }
    setRenamed(true)
  }
  const resummarise = (provider?: string) => act(async () => { const r = await reprocessMeeting(id, provider); setRenamed(false); return r })
  async function remove() {
    if (!m || !confirm(`Delete "${meetingTitle(m)}"? Its recording, transcript and summary are removed.`)) return
    await act(async () => { await deleteMeeting(id); onBack?.() })
  }

  const st = liveStatus(m, live)
  const project = m.projectId ? state.projects[m.projectId] : undefined
  const github = project?.connector?.kind === 'github' && !!project.connector.settings?.repo?.trim()
  const projects = Object.values(state.projects).sort((a, b) => a.name.localeCompare(b.name))
  const s = m.summary
  const actions = sortActions(m.actions ?? []).map((a) => (a.issueUrl ? a : { ...a, issueUrl: issues.byId[a.id] || issues.byText[a.text] || undefined }))
  const onIssue = (aid: string, url: string) => {
    const text = (m.actions ?? []).find((x) => x.id === aid)?.text
    setIssues((p) => ({ byId: { ...p.byId, [aid]: url }, byText: text ? { ...p.byText, [text]: url } : p.byText }))
    setM((p) => (p ? { ...p, actions: (p.actions ?? []).map((x) => (x.id === aid ? { ...x, issueUrl: url } : x)) } : p))
  }
  const transcribed = hasSegments && st.status !== 'transcribing' && st.status !== 'queued' && st.status !== 'uploaded'
  const workers = Object.values(state.machines).filter((x) => x.caps?.transcribe).sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
  const noWorker = st.status === 'queued' && !workers.some((x) => x.online)
  // a local summary runs on a machine's Ollama: until it starts, say which machine it waits for
  const localWait = st.status === 'summarising' && m.provider === 'local' && !st.progress && !st.stage
  const waitFor = workers.filter((x) => x.online).map((x) => x.name)
  const meta = [date(m.startedAt || m.createdAt), duration(m.durationS)].filter(Boolean).join(' · ')
  const sec = (title: string, body: ReactNode) => <Section title={title}>{body}</Section>

  return (
    <div className="min-w-0 pb-10">
      <header className="sticky top-0 z-10 flex min-w-0 items-center gap-2 border-b border-line bg-background/90 px-3 py-2 backdrop-blur">
        {back}
        {editingTitle === null ? (
          <>
            <h2 className="min-w-0 flex-1 truncate text-base font-semibold">{meetingTitle(m)}</h2>
            <button type="button" aria-label="Edit title" onClick={() => setEditingTitle(m.title)} className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-chip"><Pencil className="size-4" /></button>
          </>
        ) : (
          <form className="flex min-w-0 flex-1 items-center gap-2" onSubmit={(e) => { e.preventDefault(); const t = editingTitle; setEditingTitle(null); if (t.trim() !== m.title) void patch({ title: t }) }}>
            <Input autoFocus value={editingTitle} maxLength={200} onChange={(e) => setEditingTitle(e.target.value)} aria-label="Title" className="min-h-11 min-w-0 flex-1"
              onKeyDown={(e) => { if (e.key === 'Escape') setEditingTitle(null) }} />
            <Button type="submit" size="sm" className="min-h-11 shrink-0">Save</Button>
          </form>
        )}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button aria-label="Meeting menu" className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-chip"><MoreHorizontal className="h-5 w-5" /></button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {transcribed && (
              <>
                <DropdownMenuLabel className="text-xs text-muted-foreground">Re-summarise with</DropdownMenuLabel>
                {PROVIDERS.map(([k, l]) => <DropdownMenuItem key={k} className="min-h-11" onSelect={() => void resummarise(k)}>{l}{k === m.provider ? ' (used)' : ''}</DropdownMenuItem>)}
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem className="min-h-11 text-danger" onSelect={() => void remove()}>Delete</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <div className="min-w-0 space-y-3 px-3 pt-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {meta && <span>{meta}</span>}
          <label className="flex min-w-0 items-center gap-1.5">Project
            <select value={m.projectId} onChange={(e) => void patch({ projectId: e.target.value })} className={`min-w-0 max-w-56 truncate ${field}`}>
              <option value="">Unassigned</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        </div>
        {error && <p role="alert" className={`text-xs text-danger ${wrap}`}>{error}</p>}

        {st.status !== 'ready' && (
          <div role="status" aria-label="Processing" className="space-y-2 rounded-xl border border-line bg-surface p-3">
            <p className={`text-sm font-medium ${statusTone(st.status)}`}>{statusText(st.status, st.progress)}{stageText(st.stage) && st.status !== 'failed' ? <span className="font-normal text-muted-foreground"> · {stageText(st.stage)}</span> : null}</p>
            {(st.status === 'transcribing' || (st.status === 'summarising' && st.progress > 0)) && <Progress value={st.progress} aria-label="Progress" />}
            {localWait && (
              <p className={`text-xs text-muted-foreground ${wrap}`}>
                {!workers.length ? <>No machine can summarise locally. Run <code>quorumd meetings setup</code> on a machine with a GPU, or re-summarise with another provider.</>
                  : waitFor.length ? `Waiting for ${waitFor.join(' or ')} to summarise.`
                  : `Waiting for ${workers.map((x) => x.name).join(' or ')} to summarise: turn it on.`}
              </p>
            )}
            {noWorker && <p className="text-xs text-muted-foreground">No machine can transcribe right now. Run <code>quorumd meetings setup</code> on a machine with a GPU, or turn it on.</p>}
            {st.status === 'failed' && (
              <>
                <p role="alert" className={`text-sm text-danger ${wrap}`}>{m.error || 'The processing failed.'}</p>
                <Button onClick={() => void act(() => retryMeeting(id))} className="min-h-11">Retry</Button>
              </>
            )}
            {BEFORE_TRANSCRIPT.includes(st.status) && !hasSegments && <BeforeTranscript m={m} onPatch={patch} />}
          </div>
        )}

        {st.status === 'ready' && (
          <>
            {sec('Summary', s?.summary ? (
              <>
                <p className={`whitespace-pre-line text-sm text-ink ${wrap}`}>{s.summary}</p>
                {!!s.topics?.length && <ul aria-label="Topics" className="flex flex-wrap gap-1.5">{s.topics.map((t, i) => <li key={i} className={`rounded-full bg-chip px-2 py-0.5 text-xs ${wrap}`}>{t}</li>)}</ul>}
              </>
            ) : <p className="text-xs text-muted-foreground">No summary: the recording had no speech.</p>)}
            {sec('Decisions', <Points items={s?.decisions ?? []} onSeek={seek} />)}
            {sec('Open points', <Points items={s?.openPoints ?? []} onSeek={seek} onAdd={m.projectId ? async (t) => { await addMeetingPending(id, t) } : undefined} />)}
            {sec('Actions', actions.length ? (
              <ul className="divide-y divide-line">
                {actions.map((a) => <ActionRow key={a.id} meetingId={id} a={a} github={github} onSeek={seek} onIssue={onIssue} />)}
              </ul>
            ) : <p className="text-xs text-muted-foreground">None.</p>)}
            {sec('Attendees', s?.attendees?.length ? <p className={`text-sm text-ink ${wrap}`}>{s.attendees.join(', ')}</p> : <p className="text-xs text-muted-foreground">Not stated.</p>)}
          </>
        )}

        {hasSegments && sec('Transcript', (
          <>
            {audio ? (
              <audio ref={player} src={audio} controls preload="metadata" aria-label="Recording" className="w-full"
                onError={() => { if (Date.now() - audioAt.current > 50 * 60_000) setAudioTry((n) => n + 1) }}
                onLoadedMetadata={() => { if (pendingSeek.current != null) { const ms = pendingSeek.current; pendingSeek.current = null; seek(ms) } }} />
            ) : !hasAudio && <p className="text-xs text-muted-foreground">The recording is no longer on the hub (it is kept for 30 days).</p>}
            <Transcript segments={m.segments ?? []} onSeek={seek} onRename={rename}
              onResummarise={renamed && st.status === 'ready' ? () => void resummarise(m.provider || undefined) : undefined} />
          </>
        ))}
      </div>
    </div>
  )
}
