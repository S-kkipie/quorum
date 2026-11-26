import { useState } from 'react'
import type { AppState } from '../../lib/store'
import Section from '../briefing/Section'
import MeetingsList, { useMeetings } from './MeetingsList'
import RecordMeeting from './RecordMeeting'
import UploadMeeting from './UploadMeeting'

/** The project's Meetings section: "Upload recording" and the list of its meetings. */
export default function ProjectMeetings({ state, projectId, onOpenMeeting }: { state: AppState; projectId: string; onOpenMeeting?: (id: string) => void }) {
  // an upload finished: refetch at once (the meeting_changed may come a moment later)
  const [uploads, setUploads] = useState(0)
  const { list, error } = useMeetings({ projectId }, `${state.meetingsRev ?? 0}:${uploads}`)
  return (
    <div className="min-w-0 px-3 pt-3">
      <Section title="Meetings" aside={list?.length ? String(list.length) : undefined}>
        <div className="flex min-w-0 flex-wrap items-start gap-2">
          <UploadMeeting projectId={projectId} onUploaded={() => setUploads((n) => n + 1)} />
          <RecordMeeting projectId={projectId} onStarted={(m) => onOpenMeeting?.(m.id)} />
        </div>
        {error ? <p role="alert" className="text-xs text-danger [overflow-wrap:anywhere]">{error}</p>
          : list && <MeetingsList list={list} live={state.meetingLive ?? {}} onOpen={(id) => onOpenMeeting?.(id)} empty="No meetings yet. Upload a recording to transcribe and summarise it." />}
      </Section>
    </div>
  )
}
