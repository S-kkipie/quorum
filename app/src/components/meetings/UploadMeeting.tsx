import { useRef, useState } from 'react'
import { ApiError } from '../../lib/api'
import { MEETING_MAX_BYTES, uploadMeeting } from '../../lib/meetingsApi'
import type { Meeting } from '../../proto.gen'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Upload } from 'lucide-react'
import { bytes } from './util'

const ACCEPT = 'audio/*,.m4a,.mp3,.wav,.ogg,.opus,.webm,.flac'

/** Where an unfinished upload id is kept, so picking the same file again (even after a reload) resumes it. */
const key = (projectId: string, f: File) => `quorum.meetingUpload:${projectId}:${f.name}:${f.size}:${f.lastModified}`
const remember = (k: string, id: string | null) => {
  try { if (id) localStorage.setItem(k, id); else localStorage.removeItem(k) } catch { /* no storage: resume only works in this page */ }
}
const recall = (k: string) => {
  try { return localStorage.getItem(k) || undefined } catch { return undefined }
}

/** "Upload recording": a file picker, the chunked upload with its progress, and Resume after a failure. */
export default function UploadMeeting({ projectId = '', onUploaded }: { projectId?: string; onUploaded?: (m: Meeting) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const abort = useRef<AbortController | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [uploadId, setUploadId] = useState<string | undefined>()
  const [sent, setSent] = useState<{ sent: number; total: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  /** resumeId: the upload to continue; undefined = the one saved for this file, if any; null = a new upload. */
  async function start(f: File, resumeId?: string | null) {
    setError('')
    if (f.size > MEETING_MAX_BYTES) { setFile(null); setError(`The recording is ${bytes(f.size)}, larger than 400 MB.`); return }
    const k = key(projectId, f)
    const id = resumeId === null ? undefined : (resumeId ?? recall(k))
    setFile(f)
    setUploadId(id)
    setBusy(true)
    setSent({ sent: 0, total: f.size })
    const ac = new AbortController()
    abort.current = ac
    try {
      const m = await uploadMeeting(f, {
        projectId, uploadId: id, signal: ac.signal,
        onUploadId: (x) => { setUploadId(x); remember(k, x) },
      }, (s, total) => setSent({ sent: s, total }))
      remember(k, null)
      setFile(null)
      setUploadId(undefined)
      setSent(null)
      onUploaded?.(m)
    } catch (e) {
      if (ac.signal.aborted) { setSent(null); setFile(null); return }
      // the hub no longer knows the saved upload (expired or finished elsewhere): start again from zero
      if (id && e instanceof ApiError && e.status === 404) { remember(k, null); abort.current = null; return start(f, null) }
      setError(e instanceof Error ? e.message : 'The upload failed.')
    } finally {
      setBusy(false)
      abort.current = null
    }
  }

  const pct = sent && sent.total ? Math.floor((sent.sent / sent.total) * 100) : 0
  return (
    <div className="min-w-0">
      <input ref={input} type="file" accept={ACCEPT} aria-label="Recording file" className="sr-only" tabIndex={-1}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void start(f) }} />
      {!busy && (
        <Button variant="secondary" onClick={() => input.current?.click()} className="min-h-11 w-full">
          <Upload aria-hidden className="size-4" />Upload recording
        </Button>
      )}
      {busy && sent && (
        <div className="space-y-1.5">
          <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1 truncate">Uploading {file?.name}</span>
            <span className="shrink-0 tabular-nums">{pct}% · {bytes(sent.sent)} of {bytes(sent.total)}</span>
            <Button variant="ghost" size="sm" onClick={() => abort.current?.abort()} className="min-h-11 shrink-0 text-xs">Cancel</Button>
          </div>
          <Progress value={pct} aria-label="Upload progress" />
        </div>
      )}
      {error && (
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
          <p role="alert" className="min-w-0 flex-1 text-xs text-danger [overflow-wrap:anywhere]">{error}</p>
          {file && !busy && <Button size="sm" onClick={() => void start(file, uploadId)} className="min-h-11">Resume</Button>}
        </div>
      )}
    </div>
  )
}
