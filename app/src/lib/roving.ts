import { useRef, type KeyboardEvent } from 'react'

/**
 * Keyboard for a radio group with a roving tabindex: one tab stop (the checked option); arrows /
 * Home / End move to an option, select it and focus it.
 */
export function useRoving<T>(values: readonly T[], select: (v: T) => void) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = values.length
    const to = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? (i + 1) % n
      : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? (i + n - 1) % n
        : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1
    if (to < 0) return
    e.preventDefault()
    select(values[to])
    refs.current[to]?.focus()
  }
  const ref = (i: number) => (el: HTMLButtonElement | null) => { refs.current[i] = el }
  return { ref, onKey }
}
