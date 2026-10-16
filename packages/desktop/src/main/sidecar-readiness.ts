/**
 * Current-process sidecar endpoint lease. A completed startup promise is only
 * evidence about the process that fulfilled it; it must not outlive that
 * process or let a delayed exit invalidate a newer endpoint.
 */
export function createSidecarReadiness<T>() {
  let generation = 0
  let current: { generation: number; value: T; stopped: false } | { generation: number; stopped: true } | undefined

  return {
    begin() {
      generation += 1
      current = undefined
      return generation
    },
    publish(owner: number, value: T) {
      if (owner !== generation || current?.stopped) return false
      current = { generation: owner, value, stopped: false }
      return true
    },
    invalidate(owner: number) {
      if (owner !== generation) return false
      current = { generation: owner, stopped: true }
      return true
    },
    get() {
      return current?.stopped ? null : current?.value ?? null
    },
  }
}
