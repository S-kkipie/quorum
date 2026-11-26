import { useState } from 'react'
import type { Meeting } from '../../proto.gen'
import { Button } from '@/components/ui/button'
import { Mic } from 'lucide-react'

/** "Record meeting": loads the recorder on the first press, starts it and reports the new live meeting. */
export default function RecordMeeting({ projectId, onStarted }: { projectId?: string; onStarted?: (m: Meeting) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function start() {
    setError('')
    setBusy(true)
    try {
      const { startLiveRecording } = await import('../../lib/liveRecorder')
      const r = await startLiveRecording({ projectId })
      onStarted?.({ id: r.meetingId, projectId: projectId ?? '', status: 'live', startedAt: r.startedAt } as Meeting)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Recording could not start.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="min-w-0 space-y-1">
      <Button variant="secondary" disabled={busy} onClick={() => void start()} className="min-h-11"><Mic className="mr-1 size-4" />Record meeting</Button>
      {error && <p role="alert" className="text-xs text-danger [overflow-wrap:anywhere]">{error}</p>}
    </div>
  )
}
