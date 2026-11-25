import type { WhereLeftOff as Data } from '../../proto.gen'
import Section, { wrap } from './Section'

export default function WhereLeftOff({ w }: { w: Data }) {
  const from = w.sessions === 1 ? 'your last session' : `your last ${w.sessions} sessions`
  return (
    <Section title="Where you left off">
      <p className={`text-sm leading-relaxed text-ink ${wrap}`}>{w.text}</p>
      <p className="text-xs text-muted-foreground">Written by Haiku from {from} · not a source of truth</p>
    </Section>
  )
}
