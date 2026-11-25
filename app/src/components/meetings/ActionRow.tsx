import { useState } from 'react'
import { createMeetingIssue } from '../../lib/meetingsApi'
import type { MeetingAction } from '../../proto.gen'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { clock } from './util'

const wrap = '[overflow-wrap:anywhere]'

/**
 * One action: text, owner, due date, "Mine", and "Create issue" (GitHub projects; once it exists the button opens it)
 * or "Copy". A cited time seeks the audio.
 */
export default function ActionRow({ meetingId, a, github, onIssue, onSeek }: {
  meetingId: string
  a: MeetingAction
  github: boolean
  onIssue?: (actionId: string, url: string) => void
  onSeek?: (ms: number) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  async function create() {
    setBusy(true)
    setError('')
    try {
      const r = await createMeetingIssue(meetingId, a.id)
      if (r.url) onIssue?.(a.id, r.url)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'error')
    } finally {
      setBusy(false)
    }
  }
  async function copy() {
    const text = [a.text, a.owner && `Owner: ${a.owner}`, a.due && `Due: ${a.due}`].filter(Boolean).join(' · ')
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { setError('Could not copy.') }
  }

  return (
    <li className="flex min-w-0 flex-wrap items-start gap-2 py-2">
      <div className="min-w-0 flex-1 basis-48">
        <p className={`text-sm text-ink ${wrap}`}>{a.mine && <Badge variant="secondary" className="mr-1.5 align-middle">Mine</Badge>}{a.text}</p>
        <p className={`text-xs text-muted-foreground ${wrap}`}>
          {a.owner || 'Unassigned'}{a.due && ` · due ${a.due}`}
          {!!a.tsMs && onSeek && <> · <button type="button" onClick={() => onSeek(a.tsMs!)} className="inline-flex min-h-11 items-center px-1 text-accent underline-offset-2 hover:underline">at {clock(a.tsMs)}</button></>}
        </p>
        {error && <p role="alert" className={`text-xs text-danger ${wrap}`}>{error}</p>}
      </div>
      {github ? (
        a.issueUrl ? (
          <Button asChild variant="secondary" size="sm" className="min-h-11 shrink-0"><a href={a.issueUrl} target="_blank" rel="noreferrer">Open issue</a></Button>
        ) : (
          <Button variant="secondary" size="sm" disabled={busy} onClick={create} className="min-h-11 shrink-0">{busy ? 'Creating…' : 'Create issue'}</Button>
        )
      ) : (
        <Button variant="ghost" size="sm" onClick={copy} className="min-h-11 shrink-0">{copied ? 'Copied' : 'Copy'}</Button>
      )}
    </li>
  )
}
