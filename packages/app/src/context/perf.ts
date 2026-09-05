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
let longTaskObserver: PerformanceObserver | undefined

function frameLoop() {
  if (!ENABLED || !frameMonitorStarted) return
  const now = performance.now()
  const dt = now - frameLast
  frameLast = now
  if (dt > acc.frameMax) acc.frameMax = dt
  if (dt > FRAME_STALL_MS) acc.frameStalls++
  frameHandle = requestAnimationFrame(frameLoop)
}

// Surface the sporadic multi-hundred-ms main-thread blocks (seen even at 0
// events/s) that dominate perceived jank. These are NOT in the SSE/reducer path.
// Attribution container tells us whether the block is in the app bundle vs an
// iframe/extension; a CPU profile in DevTools gives the exact function.
function observeLongTasks() {
  if (!ENABLED || typeof PerformanceObserver === "undefined") return
  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration < 100) continue
        const attr = (entry as { attribution?: Array<{ containerSrc?: string; containerId?: string; name?: string }> }).attribution
        const where = attr?.[0]?.containerSrc ?? attr?.[0]?.containerId ?? attr?.[0]?.name ?? "unknown"
        console.warn(`[perf-longtask] ${entry.duration.toFixed(0)}ms · ${where}`)
      }
    })
    obs.observe({ entryTypes: ["longtask"] })
    longTaskObserver = obs
  } catch {
    /* longtask unsupported */
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
      if (typeof requestAnimationFrame === "function") frameLoop()
      observeLongTasks()
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
      longTaskObserver?.disconnect()
      longTaskObserver = undefined
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
