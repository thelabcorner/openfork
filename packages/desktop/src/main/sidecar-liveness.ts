export type SidecarLiveness = "starting" | "healthy" | "suspected-hang" | "stopped"
export type SidecarLivenessEvent = {
  state: SidecarLiveness
  consecutiveFailures: number
  checkedAt: string
}

export type SidecarLivenessOptions = {
  probe: () => Promise<boolean>
  onState: (state: Exclude<SidecarLiveness, "starting">, details: { consecutiveFailures: number; checkedAt: string }) => void
  intervalMs?: number
  startupGraceMs?: number
  failureThreshold?: number
  now?: () => number
}

/** Main-process timer probes the sidecar over loopback; a blocked sidecar loop cannot answer. */
export function startSidecarLiveness(options: SidecarLivenessOptions) {
  const now = options.now ?? Date.now
  const startedAt = now()
  const threshold = options.failureThreshold ?? 3
  let failures = 0
  let stopped = false
  let probing = false
  let reported: Exclude<SidecarLiveness, "starting"> | undefined
  const report = (state: Exclude<SidecarLiveness, "starting">) => {
    if (state === reported) return
    reported = state
    // A status observer (for example, a renderer IPC sender) is outside the
    // health probe path. Its teardown race must not turn a successful probe
    // into a counted sidecar failure.
    try {
      options.onState(state, { consecutiveFailures: failures, checkedAt: new Date(now()).toISOString() })
    } catch {}
  }
  const timer = setInterval(() => {
    if (stopped || probing) return
    probing = true
    void options.probe().then((healthy) => {
      if (stopped) return
      if (healthy) {
        failures = 0
        report("healthy")
        return
      }
      if (now() - startedAt < (options.startupGraceMs ?? 20_000)) return
      failures++
      if (failures >= threshold) report("suspected-hang")
    }).catch(() => {
      if (stopped) return
      if (now() - startedAt < (options.startupGraceMs ?? 20_000)) return
      failures++
      if (failures >= threshold) report("suspected-hang")
    }).finally(() => { probing = false })
  }, options.intervalMs ?? 5_000)
  timer.unref?.()
  return () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    report("stopped")
  }
}
