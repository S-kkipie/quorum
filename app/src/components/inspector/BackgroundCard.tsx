import { BackgroundContent, hasBackground } from '../BackgroundSheet'
import InspectorCard from './InspectorCard'
import type { BackgroundInfo } from '../../proto.gen'

/** The session's background work (the BackgroundSheet's content); hidden when there is none. */
export default function BackgroundCard({ background }: { background?: BackgroundInfo }) {
  if (!hasBackground(background)) return null
  return <InspectorCard title="Background"><BackgroundContent background={background} /></InspectorCard>
}
