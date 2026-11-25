import type { BriefingMeetings, MeetingItem } from '../../proto.gen'
import Section, { wrap } from './Section'

const KINDS: { key: keyof BriefingMeetings; label: string; tone: string }[] = [
  { key: 'actions', label: 'Your action', tone: 'text-accent' },
  { key: 'openPoints', label: 'Open', tone: 'text-warning' },
  { key: 'decisions', label: 'Decision', tone: 'text-success' },
]

export const meetingCount = (m: BriefingMeetings) => m.decisions.length + m.openPoints.length + m.actions.length

/** Decisions, open points and the owner's actions from the project's meeting notes (last 14 days). */
export default function Meetings({ m }: { m: BriefingMeetings }) {
  const rows: (MeetingItem & { label: string; tone: string })[] = KINDS.flatMap((k) => m[k.key].map((x) => ({ ...x, label: k.label, tone: k.tone })))
  return (
    <Section title="From meetings" aside="last 2 weeks">
      <ul className="divide-y divide-line">
        {rows.map((x, i) => (
          <li key={i} className="py-1.5">
            <span className={`block text-sm text-ink ${wrap}`}><span className={`font-medium ${x.tone}`}>{x.label}:</span> {x.text}</span>
            <span className={`block text-xs text-muted-foreground ${wrap}`}>{x.date}{x.noteTitle ? ` · ${x.noteTitle}` : ''}</span>
          </li>
        ))}
      </ul>
    </Section>
  )
}
