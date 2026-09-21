/**
 * Mock turn driver for the Send / Stop concept lab. DEV-ONLY.
 *
 * This is the only thing that moves the prototypes. It never talks to the SDK,
 * a session, or an AbortController that anyone else owns. Everything it exposes
 * is local signal state, so a concept can be judged against a lifecycle without
 * a running turn existing anywhere.
 */

import { createStore } from "solid-js/store"
import { onCleanup } from "solid-js"
import type { LabTurnFacts, LabTurnPhase } from "./types"

/**
 * Turn shapes worth designing against. "Instant" is the one that breaks naive
 * implementations: the turn can be over before a transition finishes, which is
 * how a control ends up strobing between two glyphs.
 */
export type LabTurnLength = "instant" | "short" | "long" | "held"

export const LAB_TURN_LENGTHS: { id: LabTurnLength; label: string; hint: string }[] = [
  { id: "instant", label: "Instant", hint: "180ms — shorter than most transitions" },
  { id: "short", label: "Short", hint: "2.4s" },
  { id: "long", label: "Long", hint: "45s" },
  { id: "held", label: "Held", hint: "runs until stopped" },
]

/** Time between the click and the first streamed token. */
export type LabLatency = "none" | "typical" | "slow"

export const LAB_LATENCIES: { id: LabLatency; label: string; ms: number }[] = [
  { id: "none", label: "0ms", ms: 0 },
  { id: "typical", label: "320ms", ms: 320 },
  { id: "slow", label: "1.4s", ms: 1400 },
]

const TURN_MS: Record<LabTurnLength, number> = {
  instant: 180,
  short: 2400,
  long: 45_000,
  held: Number.POSITIVE_INFINITY,
}

/** How long the runtime takes to acknowledge an abort. */
const STOP_ACK_MS = 420
/** How long "just finished" stays legible. */
const SETTLE_MS = 900

export type LabDriver = {
  turn: LabTurnFacts
  length: () => LabTurnLength
  latency: () => LabLatency
  setLength: (value: LabTurnLength) => void
  setLatency: (value: LabLatency) => void
  /** Mock send. Starts the lifecycle, or increments the queue if one is live. */
  send: () => void
  /** Mock abort. */
  stop: () => void
  /** Jump straight to a phase without running the lifecycle, for inspection. */
  pin: (phase: LabTurnPhase) => void
  reset: () => void
}

export function createLabDriver(): LabDriver {
  const [turn, setTurn] = createStore<LabTurnFacts>({
    phase: "idle",
    elapsedMs: 0,
    pressure: 0,
    tokensPerSecond: 0,
    queued: 0,
  })

  const [config, setConfig] = createStore<{ length: LabTurnLength; latency: LabLatency }>({
    length: "long",
    latency: "typical",
  })

  const timers = new Set<ReturnType<typeof setTimeout>>()
  let raf: number | undefined
  let startedAt = 0
  let runDurationMs = TURN_MS.long

  const clearTimers = () => {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
  }

  const later = (ms: number, run: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      run()
    }, ms)
    timers.add(timer)
    return timer
  }

  const stopClock = () => {
    if (raf === undefined) return
    cancelAnimationFrame(raf)
    raf = undefined
  }

  const tick = () => {
    const elapsed = performance.now() - startedAt
    const ratio = Number.isFinite(runDurationMs) ? Math.min(1, elapsed / runDurationMs) : (elapsed % 9000) / 9000
    // A plausible rate curve: ramps in, wobbles, decays near the end.
    const wobble = 1 + Math.sin(elapsed / 620) * 0.07 + Math.sin(elapsed / 211) * 0.03
    const ramp = Math.min(1, elapsed / 700)
    const decay = Number.isFinite(runDurationMs) ? 1 - 0.25 * ratio ** 3 : 1
    setTurn({
      elapsedMs: elapsed,
      pressure: ratio,
      tokensPerSecond: Math.max(0, Math.round(54 * ramp * wobble * decay)),
    })
    raf = requestAnimationFrame(tick)
  }

  const startClock = () => {
    stopClock()
    startedAt = performance.now()
    raf = requestAnimationFrame(tick)
  }

  const finish = (phase: Extract<LabTurnPhase, "settling">) => {
    stopClock()
    setTurn({ phase, tokensPerSecond: 0 })
    later(SETTLE_MS, () => setTurn({ phase: "idle", elapsedMs: 0, pressure: 0, queued: 0 }))
  }

  const beginRun = () => {
    setTurn("phase", "running")
    if (!Number.isFinite(runDurationMs)) return
    later(runDurationMs, () => finish("settling"))
  }

  const send = () => {
    if (turn.phase === "arming" || turn.phase === "running") {
      setTurn("queued", (value) => value + 1)
      return
    }
    clearTimers()
    runDurationMs = TURN_MS[config.length]
    const latency = LAB_LATENCIES.find((item) => item.id === config.latency)?.ms ?? 0
    setTurn({ phase: "arming", elapsedMs: 0, pressure: 0, tokensPerSecond: 0, queued: 0 })
    startClock()
    if (latency === 0) {
      beginRun()
      return
    }
    later(latency, beginRun)
  }

  const stop = () => {
    if (turn.phase !== "arming" && turn.phase !== "running") return
    clearTimers()
    setTurn("phase", "stopping")
    later(STOP_ACK_MS, () => finish("settling"))
  }

  const pin = (phase: LabTurnPhase) => {
    clearTimers()
    stopClock()
    if (phase === "idle") {
      setTurn({ phase, elapsedMs: 0, pressure: 0, tokensPerSecond: 0, queued: 0 })
      return
    }
    if (phase === "arming") {
      setTurn({ phase, elapsedMs: 120, pressure: 0, tokensPerSecond: 0 })
      return
    }
    // Pinned running/stopping/settling keep the clock alive so motion stays
    // inspectable while the phase itself is frozen.
    runDurationMs = Number.POSITIVE_INFINITY
    setTurn({ phase, elapsedMs: 12_400, pressure: 0.42, tokensPerSecond: phase === "running" ? 48 : 0 })
    if (phase === "running") startClock()
  }

  const reset = () => {
    clearTimers()
    stopClock()
    setTurn({ phase: "idle", elapsedMs: 0, pressure: 0, tokensPerSecond: 0, queued: 0 })
  }

  onCleanup(() => {
    clearTimers()
    stopClock()
  })

  return {
    turn,
    length: () => config.length,
    latency: () => config.latency,
    setLength: (value) => setConfig("length", value),
    setLatency: (value) => setConfig("latency", value),
    send,
    stop,
    pin,
    reset,
  }
}
