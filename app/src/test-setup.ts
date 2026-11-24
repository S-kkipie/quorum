// jsdom has no ResizeObserver; use-stick-to-bottom (Conversation) needs one.
if (typeof window !== 'undefined' && !('ResizeObserver' in window)) {
  class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.assign(window, { ResizeObserver })
  Object.assign(globalThis, { ResizeObserver })
}
