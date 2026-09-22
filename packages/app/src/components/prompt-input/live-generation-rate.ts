import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { useServerSync } from "@/context/server-sync"
import {
  CHARS_PER_TOKEN,
  MIN_WINDOW_MS,
  type LiveGenerationRate,
  type GenerationRateSource,
} from "./live-generation-rate-math"

export type { LiveGenerationRate, GenerationRateSource } from "./live-generation-rate-math"

export type LiveGenerationRateState = {
  current: LiveGenerationRate
  last: number | null
  source: GenerationRateSource
}

export const TICK_MS = 200

// One page-global high-frequency clock shared by the small number of live
// telemetry consumers in the selected composer. The old implementation created
// this 200ms interval inside `createLiveGenerationRate`; exposing the same clock
// lets the turn elapsed display reuse it rather than adding a second timer.
const [telemetryNow, setTelemetryNow] = createSignal(Date.now(), { name: "liveTelemetryNow" })
let telemetryTimer: ReturnType<typeof setInterval> | undefined
let telemetrySubscribers = 0

export function useLiveTelemetryNow(enabled: () => boolean) {
  let subscribed = false

  const unsubscribe = () => {
    if (!subscribed) return
    subscribed = false
    telemetrySubscribers -= 1
    if (telemetrySubscribers > 0 || telemetryTimer === undefined) return
    clearInterval(telemetryTimer)
    telemetryTimer = undefined
  }

  createEffect(() => {
    if (!enabled()) {
      unsubscribe()
      return
    }
    if (subscribed) return
    if (telemetrySubscribers === 0) {
      setTelemetryNow(Date.now())
      telemetryTimer = setInterval(() => setTelemetryNow(Date.now()), TICK_MS)
    }
    telemetrySubscribers += 1
    subscribed = true
  })

  onCleanup(unsubscribe)
  return telemetryNow
}

/**
 * O(1) live throughput projection for the selected composer session.
 *
 * SessionTelemetry already owns streamed character counters, semantic phase,
 * and generation-only wall time. Do not hydrate messages/parts to reconstruct
 * those facts in the renderer.
 */
export function createLiveGenerationRate(args: { sessionID: () => string | undefined; working: () => boolean }) {
  const serverSync = useServerSync()
  const [lastRate, setLastRate] = createSignal<number | null>(null)
  const now = useLiveTelemetryNow(() => !!args.sessionID() && args.working())

  createEffect(() => {
    const id = args.sessionID()
    const active = !!id && args.working()
    if (!active) return
    serverSync().telemetry.ensure([id])
  })

  const current = createMemo<LiveGenerationRate>(() => {
    const id = args.sessionID()
    if (!id || !args.working()) return null
    const telemetry = serverSync().telemetry.get(id)
    if (!telemetry?.step) return null
    if (telemetry.phase === "requesting" || telemetry.phase === "tool" || telemetry.phase === "retrying") return "paused"
    if (telemetry.phase !== "generating" && telemetry.phase !== "reasoning") return null

    const liveMs = telemetry.phaseStartedAt === undefined ? 0 : Math.max(0, now() - telemetry.phaseStartedAt)
    const elapsedMs = telemetry.step.generatedMs + liveMs
    if (elapsedMs < MIN_WINDOW_MS) return null
    const chars = telemetry.step.visibleChars + telemetry.step.reasoningChars
    if (chars === 0) return 0
    return chars / CHARS_PER_TOKEN / (elapsedMs / 1000)
  })

  createEffect(() => {
    const value = current()
    if (typeof value === "number") setLastRate(value)
  })

  return createMemo<LiveGenerationRateState>(() => ({
    current: current(),
    last: lastRate(),
    source: "measured",
  }))
}
