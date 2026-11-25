/** An open modal dialog (Radix dialogs, sheets and alert dialogs carry `data-state="open"`). */
const MODAL = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]'

/**
 * True when an app-wide shortcut must not act on a key: something already handled it, or a modal
 * dialog is open (the dialog owns the keyboard, its Esc closes only the dialog).
 */
export function shortcutBlocked(e: KeyboardEvent): boolean {
  return e.defaultPrevented || (typeof document !== 'undefined' && document.querySelector(MODAL) !== null)
}
