import { afterEach } from 'vitest'

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

// Testing Library only cleans up by itself with vitest globals, which are off. A tree left mounted
// keeps React's scheduler busy after the file's jsdom is torn down ("window is not defined"), so
// every jsdom test file unmounts after each test.
if (typeof window !== 'undefined') {
  const { cleanup } = await import('@testing-library/react')
  afterEach(() => { cleanup() })
}
