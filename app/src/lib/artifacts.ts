import { buildTimeline, itemKey, type Item } from './timeline'
import type { Event } from '../proto.gen'

export type ArtifactLink = { title: string; url: string; eventKey: string }

// The hub's local-artifact links: `/v/<token>/<file>`, bare (at the start of a word, not the tail of
// another URL or path) or behind an http(s) origin; a markdown label in front of one (`[label](url)`)
// becomes its title. Only bare links and links on the hub's own origin are artifacts.
const LINK = /(?:\[([^\]\n]+)\]\()?((?:https?:\/\/[^\s/)"'<>\]`]+|(?<![^\s("'<>\[`]))\/v\/[0-9a-f]+\/[^\s)"'<>\]`]+?)(?=[.,;:!?]*(?:[\s)"'<>\]`]|$))/g

/** The origin of a URL, or '' when it does not parse. */
function originOf(url: string): string {
  try { return new URL(url).origin } catch { return '' }
}

/** The hub's origin: the configured hub address, or this page's origin when the hub serves the app. */
function hubOrigin(hub: string): string {
  return originOf(hub || (typeof location !== 'undefined' ? location.origin : ''))
}

function nameOf(url: string): string {
  const last = url.split('?')[0].split('/').pop() ?? url
  try { return decodeURIComponent(last) } catch { return last }
}

/**
 * Local-artifact links in tool results and answers, one per URL (the first sighting wins). `hub` is
 * the hub address (api.ts `hubUrl()`; empty: this page's origin).
 */
export const artifactLinks = (events: Event[], hub = ''): ArtifactLink[] => artifactLinksOf(buildTimeline(events, ''), hub)

/** `artifactLinks` over an already built timeline. */
export function artifactLinksOf(items: Item[], hub = ''): ArtifactLink[] {
  const out = new Map<string, ArtifactLink>()
  const own = hubOrigin(hub)
  const scan = (text: string, eventKey: string) => {
    for (const m of text.matchAll(LINK)) {
      const url = m[2]
      if (url[0] !== '/' && (!own || originOf(url) !== own)) continue
      if (!out.has(url)) out.set(url, { title: m[1] || nameOf(url), url, eventKey })
    }
  }
  for (const it of items) {
    if (it.t === 'tool' && it.output) scan(it.output, itemKey(it))
    else if (it.t === 'assistant') scan(it.text, itemKey(it))
  }
  return [...out.values()]
}
