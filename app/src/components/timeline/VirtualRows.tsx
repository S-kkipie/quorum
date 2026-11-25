import { useEffect, useRef, useState, type ReactNode } from 'react'
import { observeElementRect, useVirtualizer } from '@tanstack/react-virtual'
import { useStickToBottomContext } from 'use-stick-to-bottom'

/** A row height before it is measured. */
const ESTIMATE = 72

/**
 * The scroll element's size; one that is not laid out (hidden, or a test DOM) counts as a screenful
 * so the first rows still render.
 */
const observeRect: typeof observeElementRect = (instance, cb) =>
  observeElementRect(instance, (r) => cb(r.height > 0 ? r : { width: r.width, height: window.innerHeight || 800 }))

/** Renders only the rows near the viewport of the Conversation's scroll element; heights are measured. */
export default function VirtualRows<R extends { key: string }>({ rows, render, focus }: { rows: R[]; render: (r: R) => ReactNode; focus?: { key: string; n: number } }) {
  const { scrollRef } = useStickToBottomContext()
  const list = useRef<HTMLDivElement>(null)
  // the scroll element's ref is attached after this child's layout effects: render again once it is
  const [, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const v = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATE,
    getItemKey: (i) => rows[i].key,
    overscan: 6,
    scrollMargin: list.current?.offsetTop ?? 0,
    observeElementRect: observeRect,
  })
  // scroll to the requested row once it is in the list (a folded one is unfolded by the parent first)
  const done = useRef(0)
  const at = focus ? rows.findIndex((r) => r.key === focus.key) : -1
  useEffect(() => {
    if (!focus || at < 0 || done.current === focus.n) return
    done.current = focus.n
    v.scrollToIndex(at, { align: 'center' })
  }, [focus, at, v])
  const items = v.getVirtualItems()
  const margin = v.options.scrollMargin
  return (
    <div ref={list} className="relative w-full" style={{ height: v.getTotalSize() }}>
      {items.map((it) => (
        // flex column: the rows' own vertical margins stay inside the measured box
        <div key={it.key} data-index={it.index} ref={v.measureElement} className="absolute left-0 top-0 flex w-full flex-col"
          style={{ transform: `translateY(${it.start - margin}px)` }}>
          {render(rows[it.index])}
        </div>
      ))}
    </div>
  )
}

