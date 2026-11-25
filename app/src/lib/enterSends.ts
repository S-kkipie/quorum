/**
 * Enter sends on a computer (a fine pointer that can hover: mouse or trackpad), Shift+Enter is a new line.
 * On a touch screen Enter stays a new line (phone keyboards) and the Send button sends; Ctrl/Cmd+Enter works on both.
 */
export function enterSends(): boolean {
  try { return typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches } catch { return false }
}
