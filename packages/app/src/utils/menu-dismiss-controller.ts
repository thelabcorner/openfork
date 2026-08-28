/** Coordinates focus restoration and actions that must run after menu content unmounts. */
export function createMenuDismissController(content: () => HTMLElement | undefined) {
  let restoreTrigger = true

  return {
    /** Allows the menu primitive to restore focus to its trigger when closing. */
    allowTriggerRestore() {
      restoreTrigger = true
    },
    /** Keeps focus at its current or next destination instead of returning it to the trigger. */
    preventTriggerRestore() {
      restoreTrigger = false
    },
    /** Applies the current restoration policy during the menu primitive's close-focus event. */
    onCloseAutoFocus(event: Event) {
      if (!restoreTrigger) event.preventDefault()
    },
    /** Runs an action after the menu unmounts and its focus-close work has settled. */
    afterClose(callback: () => void, valid: () => boolean = () => true) {
      const complete = () => {
        if (!valid()) return
        if (content()?.isConnected) {
          requestAnimationFrame(complete)
          return
        }
        requestAnimationFrame(() => requestAnimationFrame(() => valid() && callback()))
      }
      requestAnimationFrame(complete)
    },
  }
}
