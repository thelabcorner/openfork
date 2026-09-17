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

const TICK_MS = 200

/**
 * O(1) live throughput projection for the selected composer session.
 *
 * SessionTelemetry already owns streamed character counters, semantic phase,
 * and generation-only wall time. Do not hydrate messages/parts to reconstruct
 * those facts in the renderer.
 */
export function createLiveGenerationRate(args: { sessionID: () => string | undefined; working: () => boolean }) {
  const serverSync = useServerSync()
  const [now, setNow] = createSignal(Date.now())
  const [lastRate, setLastRate] = createSignal<number | null>(null)

  createEffect(() => {
    const id = args.sessionID()
    const active = !!id && args.working()
    if (!active) return
    serverSync().telemetry.ensure([id])
    setNow(Date.now())
    const interval = setInterval(() => setNow(Date.now()), TICK_MS)
    onCleanup(() => clearInterval(interval))
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
