/** Owns the delayed, one-shot SessionGroup query activation lifecycle.
 * Unlike an unowned queued microtask + timer, disposal cancels the pending
 * network-activation attempt before it can restart work for a retired context.
 */
export function createSessionGroupActivation(
  activate: () => void,
  delayMs = 300,
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let activated = false
  const fire = () => {
    if (disposed || activated) return
    activated = true
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    activate()
  }
  return {
    request() {
      if (disposed || activated || timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        fire()
      }, delayMs)
    },
    /** The user has committed to an interactive hover card after its own
     * pointer dwell. Avoid stacking another 300ms bootstrap delay on it. */
    now: fire,
    dispose() {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
  }
}