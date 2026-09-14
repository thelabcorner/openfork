// Phase-by-phase trace for the renderer event pipeline: SSE receive, reducer,
// projection, row construction, frames and reconnects. Metadata only — event
// types, session ids, counts, sizes and durations, never payload content.
//
// Opt-in: set localStorage `opencode:phase-trace` to "1" (or add
// `?phase-trace=1` to the URL) to enable. Summaries go to the console as
// `[phase-trace]` JSON lines every 5s, which the desktop file logger persists,
// and the full snapshot is available live as `window.__opencodePhaseTrace()`.
//
// Cost discipline: integer counters on the hot path, one bounded ring (512)
// for slow/rare events, capped histograms (64 keys + "other"). Nothing here
// allocates per token except a slow-row record above threshold.

type WindowSummary = {
  t: number
  windowSec: number
  frames: number
  deltas: number
  dispatchMs: number
  applyV2Ms: number
  applyMs: number
  projectionMs: number
  projectionRuns: number
  projectionTurns: number
  rowsBuilt: number
  rowsMs: number
  slowRows: number
  estimateCacheResets: number
  reconnects: number
  gaps: number
  frameMaxMs: number
  frameStalls: number
  markdown: MarkdownSummary
}

type MarkdownSummary = {
  pacedUpdates: number
  pacedChars: number
  effects: number
  effectMs: number
  effectMaxMs: number
  blocks: number
  blockMs: number
  blockMaxMs: number
  blockChars: number
  blockSkips: number
  sanitizeCalls: number
  sanitizeMs: number
  sanitizeMaxMs: number
  innerHTMLMs: number
  decorateMs: number
  morphMs: number
  codeMs: number
  codeTokens: number
  workerRequests: number
  workerMs: number
  workerComputeMs: number
  workerInternalQueueMs: number
  workerQueueMs: number
  workerDispatchWaitMs: number
  workerResponseWaitMs: number
  workerMaxMs: number
  workerSuperseded: number
  workerErrors: number
  workerByKind: Record<string, number>
  parseIncremental: number
  parseFull: number
  parseUnknown: number
}

type MarkdownTraceEvent =
  | { phase: "paced"; chars: number; streaming: boolean }
  | { phase: "effect"; ms: number; textChars: number; blockCount: number; streaming: boolean }
  | {
      phase: "block"
      ms: number
      action: string
      mode: string
      chars: number
      innerHTMLMs?: number
      decorateMs?: number
      morphMs?: number
      codeMs?: number
      tokenCount?: number
    }
  | { phase: "sanitize"; ms: number; chars: number; htmlChars: number }
  | {
      phase: "worker"
      kind: "parse" | "project" | "highlight"
      status: "ok" | "superseded" | "error" | "disposed"
      ms: number
      chars: number
      workerMs?: number
      workerQueueMs?: number
      dispatchWaitMs?: number
      responseWaitMs?: number
      incremental?: boolean
    }

const MAX_RING = 512
const MAX_HISTOGRAM_KEYS = 64
const MAX_WINDOWS = 120
const SLOW_ROW_MS = 25
const SUMMARY_MS = 5_000

function freshMarkdown(): MarkdownSummary {
  return {
    pacedUpdates: 0,
    pacedChars: 0,
    effects: 0,
    effectMs: 0,
    effectMaxMs: 0,
    blocks: 0,
    blockMs: 0,
    blockMaxMs: 0,
    blockChars: 0,
    blockSkips: 0,
    sanitizeCalls: 0,
    sanitizeMs: 0,
    sanitizeMaxMs: 0,
    innerHTMLMs: 0,
    decorateMs: 0,
    morphMs: 0,
    codeMs: 0,
    codeTokens: 0,
    workerRequests: 0,
    workerMs: 0,
    workerComputeMs: 0,
    workerInternalQueueMs: 0,
    workerQueueMs: 0,
    workerDispatchWaitMs: 0,
    workerResponseWaitMs: 0,
    workerMaxMs: 0,
    workerSuperseded: 0,
    workerErrors: 0,
    workerByKind: {},
    parseIncremental: 0,
    parseFull: 0,
    parseUnknown: 0,
  }
}

function flagOn(): boolean {
  try {
    if (typeof localStorage !== "undefined" && localStorage.getItem("opencode:phase-trace") === "1") return true
  } catch {
    // Storage access can throw in locked-down contexts; tracing stays off.
  }
  try {
    if (typeof location !== "undefined" && /[?&]phase-trace=1\b/.test(location.search)) return true
  } catch {
    // No location (tests, SSR); tracing stays off.
  }
  return false
}

let enabled = flagOn()

let window_: WindowSummary = freshWindow()
let windows: WindowSummary[] = []
const ring: Array<Record<string, unknown>> = []
const kinds = new Map<string, number>()
const sessions = new Map<string, number>()
let summaryTimer: ReturnType<typeof setInterval> | undefined
let lastSummary = typeof performance !== "undefined" ? performance.now() : 0

function freshWindow(): WindowSummary {
  return {
    t: Date.now(),
    windowSec: 0,
    frames: 0,
    deltas: 0,
    dispatchMs: 0,
    applyV2Ms: 0,
    applyMs: 0,
    projectionMs: 0,
    projectionRuns: 0,
    projectionTurns: 0,
    rowsBuilt: 0,
    rowsMs: 0,
    slowRows: 0,
    estimateCacheResets: 0,
    reconnects: 0,
    gaps: 0,
    frameMaxMs: 0,
    frameStalls: 0,
    markdown: freshMarkdown(),
  }
}

function bucket(into: Map<string, number>, key: string) {
  const short = key.length > 128 ? key.slice(0, 128) : key
  if (!into.has(short) && into.size >= MAX_HISTOGRAM_KEYS) {
    into.set("other", (into.get("other") ?? 0) + 1)
    return
  }
  into.set(short, (into.get(short) ?? 0) + 1)
}

function snapshot() {
  return {
    t: Date.now(),
    windows,
    current: window_,
    kinds: Object.fromEntries(kinds),
    sessions: Object.fromEntries(sessions),
    recent: [...ring],
  }
}

function summarize() {
  if (!enabled) return
  const now = typeof performance !== "undefined" ? performance.now() : 0
  window_.windowSec = lastSummary === 0 ? 0 : (now - lastSummary) / 1000
  lastSummary = now
  windows.push(window_)
  if (windows.length > MAX_WINDOWS) windows.splice(0, windows.length - MAX_WINDOWS)
  try {
    console.info(`[phase-trace] ${JSON.stringify({ ...window_, kinds: Object.fromEntries(kinds) })}`)
  } catch {
    // Logging must never break rendering.
  }
  window_ = freshWindow()
}

function ensureTimer() {
  if (!enabled || summaryTimer !== undefined) return
  if (typeof setInterval !== "function") return
  summaryTimer = setInterval(summarize, SUMMARY_MS)
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(frameLoop)
}

let frameLast = 0

// Independent worst-gap sampler. rAF stops while hidden, so a multi-second gap
// is a visibility return, not a stall, and is skipped rather than recorded.
function frameLoop() {
  if (!enabled) return
  const now = performance.now()
  if (frameLast !== 0) {
    const dt = now - frameLast
    if (dt <= 5000) {
      if (dt > window_.frameMaxMs) window_.frameMaxMs = dt
      if (dt > 50) window_.frameStalls += 1
    }
  }
  frameLast = now
  requestAnimationFrame(frameLoop)
}

try {
  const w = globalThis as unknown as { __opencodePhaseTrace?: () => unknown }
  w.__opencodePhaseTrace = () => snapshot()
} catch {
  // No global to attach to (tests); the module API still works.
}

export const phaseTrace = {
  get enabled() {
    return enabled
  },
  /** Runtime/test switch. Production stays off unless explicitly opted in. */
  configure(value: boolean) {
    if (enabled === value) return
    enabled = value
    if (!enabled && summaryTimer !== undefined) {
      clearInterval(summaryTimer)
      summaryTimer = undefined
    }
    frameLast = 0
  },
  /** One received SSE frame. kind is the event type, sessionID optional. */
  frame(kind: string, sessionID?: string) {
    if (!enabled) return
    window_.frames += 1
    bucket(kinds, kind)
    if (sessionID !== undefined) {
      bucket(sessions, sessionID)
      window_.deltas += 1
    }
    ensureTimer()
  },
  /** Dispatch-side cost of handing one frame to the stores. */
  dispatch(ms: number) {
    if (!enabled || !(ms >= 0)) return
    window_.dispatchMs += ms
  },
  /** Reducer cost. name is "applyV2" or "apply". */
  reducer(name: "applyV2" | "apply", ms: number, sessionID?: string) {
    if (!enabled || !(ms >= 0)) return
    if (name === "applyV2") window_.applyV2Ms += ms
    else window_.applyMs += ms
    if (sessionID !== undefined) bucket(sessions, sessionID)
    ensureTimer()
  },
  /** One grouped() projection run over `turns` turns costing ms. */
  projection(ms: number, turns: number) {
    if (!enabled || !(ms >= 0)) return
    window_.projectionMs += ms
    window_.projectionRuns += 1
    window_.projectionTurns = turns
  },
  /** One constructed turn row. Only records a ring entry above threshold. */
  row(key: string, ms: number) {
    if (!enabled || !(ms >= 0)) return
    window_.rowsBuilt += 1
    window_.rowsMs += ms
    if (ms < SLOW_ROW_MS) return
    window_.slowRows += 1
    ring.push({ t: Date.now(), phase: "row.slow", key: key.slice(0, 128), ms: Math.round(ms * 100) / 100 })
    if (ring.length > MAX_RING) ring.splice(0, ring.length - MAX_RING)
  },
  /** Frame-monitor sample: worst rAF gap and stall count for the window. */
  frameSample(maxMs: number, stalls: number) {
    if (!enabled) return
    if (maxMs > window_.frameMaxMs) window_.frameMaxMs = maxMs
    window_.frameStalls += stalls
  },
  reconnect(info: { failures: number }) {
    if (!enabled) return
    window_.reconnects += 1
    ring.push({ t: Date.now(), phase: "sse.reconnect", failures: info.failures })
    if (ring.length > MAX_RING) ring.splice(0, ring.length - MAX_RING)
    ensureTimer()
  },
  gap(info: { requested: unknown; latest: unknown }) {
    if (!enabled) return
    window_.gaps += 1
    ring.push({ t: Date.now(), phase: "sse.gap", requested: info.requested, latest: info.latest })
    if (ring.length > MAX_RING) ring.splice(0, ring.length - MAX_RING)
    ensureTimer()
  },
  counter(name: "estimateCacheResets") {
    if (!enabled) return
    if (name === "estimateCacheResets") window_.estimateCacheResets += 1
    ensureTimer()
  },
  markdown(event: MarkdownTraceEvent) {
    if (!enabled) return
    const markdown = window_.markdown
    if (event.phase === "paced") {
      markdown.pacedUpdates += 1
      markdown.pacedChars = Math.max(markdown.pacedChars, event.chars)
      ensureTimer()
      return
    }
    if (event.phase === "effect") {
      markdown.effects += 1
      markdown.effectMs += event.ms
      markdown.effectMaxMs = Math.max(markdown.effectMaxMs, event.ms)
      if (event.ms >= 25) pushRing({ phase: "markdown.effect.slow", ms: event.ms, chars: event.textChars })
      ensureTimer()
      return
    }
    if (event.phase === "block") {
      markdown.blocks += 1
      markdown.blockMs += event.ms
      markdown.blockMaxMs = Math.max(markdown.blockMaxMs, event.ms)
      markdown.blockChars += event.chars
      if (event.action === "skip") markdown.blockSkips += 1
      markdown.innerHTMLMs += event.innerHTMLMs ?? 0
      markdown.decorateMs += event.decorateMs ?? 0
      markdown.morphMs += event.morphMs ?? 0
      markdown.codeMs += event.codeMs ?? 0
      markdown.codeTokens += event.tokenCount ?? 0
      if (event.ms >= 25) pushRing({ phase: "markdown.block.slow", action: event.action, mode: event.mode, ms: event.ms })
      ensureTimer()
      return
    }
    if (event.phase === "sanitize") {
      markdown.sanitizeCalls += 1
      markdown.sanitizeMs += event.ms
      markdown.sanitizeMaxMs = Math.max(markdown.sanitizeMaxMs, event.ms)
      if (event.ms >= 25)
        pushRing({
          phase: "markdown.sanitize.slow",
          ms: event.ms,
          chars: event.chars,
          htmlChars: event.htmlChars,
        })
      ensureTimer()
      return
    }
    markdown.workerRequests += 1
    markdown.workerMs += event.ms
    markdown.workerComputeMs += event.workerMs ?? 0
    markdown.workerInternalQueueMs += event.workerQueueMs ?? 0
    markdown.workerQueueMs += Math.max(0, event.ms - (event.workerMs ?? 0))
    markdown.workerDispatchWaitMs += event.dispatchWaitMs ?? 0
    markdown.workerResponseWaitMs += event.responseWaitMs ?? 0
    markdown.workerMaxMs = Math.max(markdown.workerMaxMs, event.ms)
    markdown.workerByKind[`${event.kind}.${event.status}`] = (markdown.workerByKind[`${event.kind}.${event.status}`] ?? 0) + 1
    if (event.kind === "parse" && event.status === "ok") {
      if (event.incremental === true) markdown.parseIncremental += 1
      else if (event.incremental === false) markdown.parseFull += 1
      else markdown.parseUnknown += 1
    }
    if (event.status === "superseded") markdown.workerSuperseded += 1
    if (event.status === "error") markdown.workerErrors += 1
    if (event.ms >= 100)
      pushRing({
        phase: "markdown.worker.slow",
        kind: event.kind,
        status: event.status,
        ms: event.ms,
        workerMs: event.workerMs,
        workerQueueMs: event.workerQueueMs,
        queueMs: Math.max(0, event.ms - (event.workerMs ?? 0)),
        dispatchWaitMs: event.dispatchWaitMs,
        responseWaitMs: event.responseWaitMs,
      })
    ensureTimer()
  },
  snapshot,
  /** Test seam: clear everything without touching the timer. */
  reset() {
    window_ = freshWindow()
    windows = []
    ring.length = 0
    kinds.clear()
    sessions.clear()
    lastSummary = 0
  },
}

function pushRing(event: Record<string, unknown>) {
  ring.push({ t: Date.now(), ...event })
  if (ring.length > MAX_RING) ring.splice(0, ring.length - MAX_RING)
}

try {
  const w = globalThis as typeof globalThis & {
    __opencodeMarkdownTrace?: (event: MarkdownTraceEvent) => void
    __opencodeMarkdownTraceEnabled?: () => boolean
  }
  // Keep both hooks stable so tracing can be enabled at runtime without reload.
  // Session UI consults the enable hook before taking timestamps/allocating
  // trace bookkeeping, so a configured-off trace is genuinely off the hot path.
  w.__opencodeMarkdownTraceEnabled = () => phaseTrace.enabled
  w.__opencodeMarkdownTrace = (event) => phaseTrace.markdown(event)
} catch {
  // No global to attach to (tests, SSR); the module API still works.
}
