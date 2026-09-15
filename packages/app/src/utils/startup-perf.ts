type StartupMark = {
  name: string
  ms: number
  extra?: Record<string, string | number | boolean | null | undefined>
}

type StartupDiagnostic = {
  name: string
  ms: number
  data: unknown
}

const DEV = (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true
const FLAG = (() => {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem("opencode:startup-perf") === "1"
  } catch {
    return false
  }
})()
const ENABLED = DEV || FLAG
const marks = new Map<string, StartupMark>()
const diagnostics = new Map<string, StartupDiagnostic>()

function expose() {
  try {
    const target = globalThis as typeof globalThis & {
      __opencodeStartupPerf?: () => StartupMark[]
      __opencodeStartupDiagnostics?: () => StartupDiagnostic[]
    }
    target.__opencodeStartupPerf = () => [...marks.values()]
    target.__opencodeStartupDiagnostics = () => [...diagnostics.values()]
  } catch {}
}

expose()

export function startupMark(
  name: string,
  extra?: Record<string, string | number | boolean | null | undefined>,
) {
  if (!ENABLED || marks.has(name)) return
  const ms = performance.now()
  const mark = { name, ms: Math.round(ms * 100) / 100, extra }
  marks.set(name, mark)
  try {
    performance.mark(`opencode:${name}`)
    console.info(`[startup-perf] ${JSON.stringify(mark)}`)
  } catch {}
}

export function startupSpan(
  name: string,
  startedAt: number,
  extra?: Record<string, string | number | boolean | null | undefined>,
) {
  startupMark(name, { ...extra, durationMs: Math.round((performance.now() - startedAt) * 100) / 100 })
}

/**
 * One-shot structured diagnostic tied to startup milestones. Unlike a profiler
 * or sampler this does no periodic work: callers snapshot already-maintained
 * counters exactly once, and the single-line JSON record is easy for the
 * Electron startup harness to capture and diff across trials.
 */
export function startupDiagnostic(name: string, data: unknown) {
  if (!ENABLED || diagnostics.has(name)) return
  const record = { name, ms: Math.round(performance.now() * 100) / 100, data }
  diagnostics.set(name, record)
  try {
    console.info(`[startup-diagnostic] ${JSON.stringify(record)}`)
  } catch {}
}

export function startupTransportDiagnostic(name: string) {
  if (!ENABLED || diagnostics.has(name)) return
  const target = globalThis as typeof globalThis & {
    __opencodeServerRequestQoS?: () => unknown
    __opencodeServerStreamQoS?: () => unknown
  }
  startupDiagnostic(name, {
    requests: target.__opencodeServerRequestQoS?.(),
    streams: target.__opencodeServerStreamQoS?.(),
  })
}
