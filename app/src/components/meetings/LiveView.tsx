import { useEffect, useMemo, useRef, useState } from 'react'
import { currentRecording } from '../../lib/liveRecorder'
import { stopLiveMeeting } from '../../lib/meetingsApi'
import type { AppState } from '../../lib/store'
import type { Meeting, MeetingSegment } from '../../proto.gen'
import { Button } from '@/components/ui/button'
import { wrap } from '../briefing/Section'
import { clock } from './util'

const segKey = (s: MeetingSegment) => `${s.startMs}\u0000${s.text}`

/** The detail's segments and the pushed ones, once each, in time order. */
export function mergeSegments(a: MeetingSegment[], b: MeetingSegment[]): MeetingSegment[] {
  const seen = new Set<string>()
  return [...a, ...b].filter((s) => { const k = segKey(s); if (seen.has(k)) return false; seen.add(k); return true }).sort((x, y) => x.startMs - y.startMs)
}

/** A recording meeting: elapsed time, the transcript as it arrives, and how to stop it. */
export default function LiveView({ state, m, onStopped }: { state: AppState; m: Meeting; onStopped: (m: Meeting) => void }) {
  const pushed = state.meetingText?.[m.id]
  const segments = useMemo(() => mergeSegments(m.segments ?? [], pushed?.segments ?? []), [m.segments, pushed?.segments])
  const waiting = (pushed?.live ?? m.live)?.waiting ?? false
  const machines = Object.values(state.machines ?? {}).filter((x) => x.caps?.transcribe).map((x) => x.name)

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])

  const [, bump] = useState(0)
  const rec = currentRecording()
  const mine = rec?.meetingId === m.id ? rec : null
  useEffect(() => (mine ? mine.subscribe(() => bump((n) => n + 1)) : undefined), [mine])
  const recording = !!mine && (mine.state === 'recording' || mine.state === 'stopping')

  const box = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  useEffect(() => {
    const el = box.current
    if (el && atBottom.current) el.scrollTop = el.scrollHeight
  }, [segments.length])

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function stop(fn: () => Promise<Meeting>) {
    setError('')
    setBusy(true)
    try { onStopped(await fn()) } catch (e) { setError(e instanceof Error ? e.message : 'Stopping failed.') } finally { setBusy(false) }
  }

  return (
    <div className="min-w-0 space-y-3 rounded-xl border border-line bg-surface p-3">
      <div className="flex min-w-0 items-center gap-2">
        <span aria-hidden className="size-2 shrink-0 animate-pulse motion-reduce:animate-none rounded-full bg-danger" />
        <span className="text-sm font-medium text-danger">Recording</span>
        <span className="tabular-nums text-sm text-muted-foreground" aria-label="Elapsed time">{clock(now - (m.startedAt || mine?.startedAt || now))}</span>
      </div>
      {waiting && <p role="status" className={`text-xs text-muted-foreground ${wrap}`}>Transcription waiting for {machines.length ? machines.join(' or ') : 'a machine that can transcribe'}</p>}
      <div ref={box} data-testid="live-transcript" role="log" aria-label="Live transcript" className="max-h-80 min-w-0 space-y-1.5 overflow-y-auto"
        onScroll={(e) => { const el = e.currentTarget; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40 }}>
        {segments.length ? segments.map((s, i) => (
          <p key={s.startMs + ':' + i} className={`text-sm text-ink ${wrap}`}>
            <span className="mr-2 tabular-nums text-xs text-muted-foreground">{clock(s.startMs)}</span>{s.text}
          </p>
        )) : <p className="text-xs text-muted-foreground">The transcript appears here as people speak.</p>}
      </div>
      {mine?.error && <p role="alert" className={`text-xs text-danger ${wrap}`}>{mine.error}</p>}
      {recording && mine.lastError && <p role="status" className={`text-xs text-warning ${wrap}`}>Upload retrying: {mine.lastError}</p>}
      {recording && mine.state === 'recording' && <Button disabled={busy} onClick={() => void stop(() => mine.stop())} className="min-h-11">Stop</Button>}
      {recording && mine.state === 'stopping' && <p role="status" className="text-sm text-muted-foreground">Finishing the upload… ({mine.pending} left)</p>}
      {!recording && (
        <>
          <p className="text-xs text-muted-foreground">Recording on another device, or interrupted. Stop it to process what arrived.</p>
          <Button disabled={busy} onClick={() => void stop(() => stopLiveMeeting(m.id, { slices: 0, force: true }))} className="min-h-11">Stop and process</Button>
        </>
      )}
      {error && <p role="alert" className={`text-xs text-danger ${wrap}`}>{error}</p>}
    </div>
  )
}
