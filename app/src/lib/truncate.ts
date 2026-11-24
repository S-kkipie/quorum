/** Shortens a file name to at most `max` characters by cutting the middle: the start, an ellipsis, then the last ~8 chars of the stem and the extension. */
export function middleTruncate(name: string, max: number): string {
  if (name.length <= max) return name
  const dot = name.lastIndexOf('.')
  const hasExt = dot > 0 && name.length - dot <= 8
  const stem = hasExt ? name.slice(0, dot) : name
  const ext = hasExt ? name.slice(dot) : ''
  const tailLen = Math.max(0, Math.min(8, stem.length, max - ext.length - 2))
  const tail = stem.slice(stem.length - tailLen) + ext
  const head = Math.max(1, max - 1 - tail.length)
  return stem.slice(0, head) + '…' + tail
}
