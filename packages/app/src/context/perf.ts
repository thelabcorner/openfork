// Dev-only SSE -> reducer + frame perf sampler. Enabled automatically in dev
// builds (the `bun run dev` desktop exe runs the app in dev mode, so these land in
// the console you already watch). To force it on in a production/non-dev build, run
// `localStorage.setItem("opencode:perf", "1")` in the devtools console and reload.
// Disable with `localStorage.removeItem("opencode:perf")`.
//
// It reports, each second: how many events the consumer processed and how many
// reducer passes ran (`reducer ms/s` broken down per sub-call), PLUS the worst
// main-thread frame time + how many frames blew the 16ms budget (`frame:`). That
// split is the key diagnostic:
//   - high `reducer ms/s`  -> the cost is in the per-event reducer passes (the
//     O(messages) scan in applyV2, store writes, invalidateQueries). Fix = batch
//     the consumer to apply a whole frame in one reducer pass.
//   - low reducer but high `frame:` stalls -> the cost is rendering (re-highlight /
//     re-render of message components per delta), which no SSE/reducer change fixes.

type Span = "applyV2" | "apply" | "dir" | "home" | "invalid" | "list" | "watcher" | "prune"

const DEV = (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true
const FLAG =
  typeof localStorage !== "undefined" && (localStorage.getItem("opencode:perf") === "1" || /[?&]perf\b/.test(location.search))
const ENABLED = DEV || FLAG

const acc = {
  events: 0,
  frames: 0,
  applyV2: 0,
  apply: 0,
  dir: 0,
  home: 0,
  invalid: 0,
  list: 0,
  watcher: 0,
  prune: 0,
  frameMax: 0,
  frameStalls: 0,
}

let lastSummary = ENABLED ? performance.now() : 0
let frameLast = ENABLED ? performance.now() : 0
const FRAME_STALL_MS = 50
let frameMonitorStarted = false
let frameMonitorRefs = 0
let frameHandle: number | undefined
let longFrameObserver: PerformanceObserver | undefined
let frameWasHidden = typeof document !== "undefined" && document.hidden

function resetFrameBaseline() {
  frameLast = performance.now()
  frameWasHidden = typeof document !== "undefined" && document.hidden
}

type LongAnimationFrameScript = {
  duration?: number
  invoker?: string
  sourceURL?: string
  sourceFunctionName?: string
}

export type LongAnimationFrameEntry = PerformanceEntry & {
  blockingDuration?: number
  renderStart?: number
  styleAndLayoutStart?: number
  scripts?: LongAnimationFrameScript[]
}

function frameLoop() {
  if (!ENABLED || !frameMonitorStarted) return
  const now = performance.now()
  const dt = now - frameLast
  frameLast = now
  const hidden = typeof document !== "undefined" && document.hidden
  // Chromium throttles or suspends requestAnimationFrame for an occluded
  // renderer. Those gaps are visibility transitions, not main-thread stalls.
  if (!hidden && !frameWasHidden) {
    if (dt > acc.frameMax) acc.frameMax = dt
    if (dt > FRAME_STALL_MS) acc.frameStalls++
  }
  frameWasHidden = hidden
  frameHandle = requestAnimationFrame(frameLoop)
}

// Surface the sporadic multi-hundred-ms main-thread blocks (seen even at 0
// events/s) that dominate perceived jank. These are NOT in the SSE/reducer path.
// Attribution container tells us whether the block is in the app bundle vs an
// iframe/extension; a CPU profile in DevTools gives the exact function.
function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

const ATTRIBUTION_LOGS_PER_SECOND = 3
const LOAF_MIN_MS = 50
let attributionLogWindow = 0
let attributionLogCount = 0

export function longFrameEntryType(supported: readonly string[] | undefined): "long-animation-frame" | "longtask" {
  return supported?.includes("long-animation-frame") ? "long-animation-frame" : "longtask"
}

function shortLabel(value: string | undefined, limit = 64) {
  if (!value) return ""
  const clipped = value.slice(0, 256)
  const leaf = clipped.split(/[?#]/, 1)[0]!.split(/[\\/]/).at(-1) ?? clipped
  return leaf.length > limit ? `${leaf.slice(0, limit - 1)}…` : leaf
}

export function formatLongAnimationFrame(entry: LongAnimationFrameEntry): string | undefined {
  if (!finite(entry.duration) || entry.duration < LOAF_MIN_MS) return undefined
  const end = entry.startTime + entry.duration
  const renderMs = finite(entry.renderStart) ? Math.max(0, end - entry.renderStart) : undefined
  const styleLayoutMs = finite(entry.styleAndLayoutStart) ? Math.max(0, end - entry.styleAndLayoutStart) : undefined
  const topScripts = (entry.scripts ?? [])
    .slice(0, 12)
    .filter((script) => finite(script.duration) && script.duration > 0)
    .sort((left, right) => (right.duration ?? 0) - (left.duration ?? 0))
    .slice(0, 3)
    .map((script) => {
      const label = shortLabel(script.invoker || script.sourceFunctionName || script.sourceURL)
      const file = script.sourceURL ? shortLabel(script.sourceURL, 48) : ""
      return `${label || "script"} ${(script.duration ?? 0).toFixed(0)}ms${file && file !== label ? ` (${file})` : ""}`
    })
  return (
    `[perf-loaf] ${entry.duration.toFixed(0)}ms` +
    (finite(entry.blockingDuration) ? ` · blocking ${entry.blockingDuration.toFixed(0)}ms` : "") +
    (renderMs !== undefined ? ` · render ${renderMs.toFixed(0)}ms` : "") +
    (styleLayoutMs !== undefined ? ` · style/layout ${styleLayoutMs.toFixed(0)}ms` : "") +
    (topScripts.length ? ` · scripts: ${topScripts.join(", ")}` : "")
  )
}

function allowAttributionLog(now: number) {
  if (now - attributionLogWindow >= 1000) {
    attributionLogWindow = now
    attributionLogCount = 0
  }
  if (attributionLogCount >= ATTRIBUTION_LOGS_PER_SECOND) return false
  attributionLogCount++
  return true
}

function observeLongFrames() {
  if (!ENABLED || typeof PerformanceObserver === "undefined") return
  const preferred = longFrameEntryType(PerformanceObserver.supportedEntryTypes)
  const onEntry = (list: PerformanceObserverEntryList) => {
    for (const entry of list.getEntries()) {
      if (entry.entryType === "long-animation-frame") {
        if (entry.duration < LOAF_MIN_MS || !allowAttributionLog(performance.now())) continue
        const message = formatLongAnimationFrame(entry as LongAnimationFrameEntry)
        if (message) console.warn(message)
        continue
      }
      if (entry.duration < 100 || !allowAttributionLog(performance.now())) continue
      const attr = (entry as PerformanceEntry & { attribution?: Array<{ containerSrc?: string; containerId?: string; name?: string }> }).attribution
      const where = shortLabel(attr?.[0]?.containerSrc ?? attr?.[0]?.containerId ?? attr?.[0]?.name) || "unknown"
      console.warn(`[perf-longtask] ${entry.duration.toFixed(0)}ms · ${where}`)
    }
  }
  try {
    let observer = new PerformanceObserver(onEntry)
    if (preferred === "long-animation-frame") {
      try {
        observer.observe({ type: "long-animation-frame", buffered: false })
      } catch {
        observer.disconnect()
        observer = new PerformanceObserver(onEntry)
        observer.observe({ entryTypes: ["longtask"] })
      }
    } else {
      observer.observe({ entryTypes: ["longtask"] })
    }
    longFrameObserver = observer
  } catch {
    /* Neither long-animation-frame nor the longtask fallback is supported. */
  }
}

export const perf = {
  enabled: ENABLED,
  event() {
    if (ENABLED) acc.events++
  },
  frame() {
    if (ENABLED) acc.frames++
  },
  span(name: Span, ms: number) {
    if (ENABLED) acc[name] += ms
  },
  startFrameMonitor() {
    if (!ENABLED) return () => undefined
    frameMonitorRefs += 1
    if (!frameMonitorStarted) {
      frameMonitorStarted = true
      if (typeof document !== "undefined") {
        resetFrameBaseline()
        document.addEventListener("visibilitychange", resetFrameBaseline)
      }
      if (typeof requestAnimationFrame === "function") frameLoop()
      observeLongFrames()
    }
    let released = false
    return () => {
      if (released) return
      released = true
      frameMonitorRefs = Math.max(0, frameMonitorRefs - 1)
      if (frameMonitorRefs > 0 || !frameMonitorStarted) return
      frameMonitorStarted = false
      if (frameHandle !== undefined && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frameHandle)
      frameHandle = undefined
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", resetFrameBaseline)
      longFrameObserver?.disconnect()
      longFrameObserver = undefined
    }
  },
  tick() {
    if (!ENABLED) return
    const now = performance.now()
    const dt = now - lastSummary
    if (dt < 1000) return
    const ev = acc.events
    const perSec = (n: number) => ((n / dt) * 1000).toFixed(0)
    const perEventUs = ev ? (acc.applyV2 / ev) * 1000 : 0
    console.log(
      `[perf] ${perSec(acc.events)} events/s · ${acc.frames ? (acc.events / acc.frames).toFixed(0) : "-"} ev/frame` +
        ` | reducer ms/s: applyV2 ${perSec(acc.applyV2)} apply ${perSec(acc.apply)} dir ${perSec(acc.dir)}` +
        ` home ${perSec(acc.home)} invalid ${perSec(acc.invalid)} list ${perSec(acc.list)} watcher ${perSec(acc.watcher)} prune ${perSec(acc.prune)}` +
        ` · applyV2 ${perEventUs.toFixed(2)}us/ev` +
        ` | frame: max ${acc.frameMax.toFixed(0)}ms stalls(>50ms) ${acc.frameStalls}`,
    )
    acc.events = acc.applyV2 = acc.apply = acc.dir = acc.home = acc.invalid = acc.list = acc.watcher = acc.prune = acc.frames = 0
    acc.frameMax = 0
    acc.frameStalls = 0
    lastSummary = now
  },
}
