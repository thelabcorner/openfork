import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { useSync } from "@/context/sync"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import {
  computeLiveGenerationRate,
  streamedChars,
  type Sample,
  type LiveGenerationRate,
  type GenerationRateSource,
} from "./live-generation-rate-math"

export type { LiveGenerationRate, GenerationRateSource } from "./live-generation-rate-math"

export type LiveGenerationRateState = {
  /** Current rate, or null when idle/not enough data. */
  current: LiveGenerationRate
  /** Last numeric rate from a previous generation, or null if none yet. */
  last: number | null
  /** Whether the current rate is measured (upstream timing) or estimated (char sampling). */
  source: GenerationRateSource
}

const SAMPLE_INTERVAL_MS = 200
const WINDOW_MS = 2500

/**
 * Provides a live tokens/sec readout while a reply is streaming, for
 * display next to the composer.
 *
 * When upstream part timing data is available (server-stamped `time.start`
 * on text/reasoning parts), the rate is measured directly from generation
 * wall-clock time — the most accurate signal. When timing data is not yet
 * available (parts not in sync, or no text/reasoning parts), the rate is
 * estimated from streamed character count (~4 chars/token) using EWMA
 * smoothing over a short sampling window.
 *
 * Returns a `LiveGenerationRateState` with the current rate, the last
 * measured rate, and whether the current rate is measured or estimated so
 * the UI can distinguish the two.
 */
export function createLiveGenerationRate(args: { sessionID: () => string | undefined; working: () => boolean }) {
  const sync = useSync()
  const [samples, setSamples] = createSignal<Sample[]>([])
  const [lastRate, setLastRate] = createSignal<number | null>(null)

  const currentMessageID = createMemo(() => {
    const id = args.sessionID()
    if (!id) return undefined
    const list = (sync().data.message[id] ?? []) as Message[]
    for (let i = list.length - 1; i >= 0; i--) {
      const msg = list[i]
      if (msg.role !== "assistant") continue
      return msg.time.completed ? undefined : msg.id
    }
    return undefined
  })

  createEffect(() => {
    const messageID = currentMessageID()
    const active = args.working() && !!messageID

    setSamples([])
    if (!active) return

    const interval = setInterval(() => {
      const parts = sync().data.part[messageID] as Part[] | undefined
      const now = Date.now()
      const chars = streamedChars(parts)
      setSamples((prev) => [...prev, { time: now, chars }].filter((sample) => now - sample.time <= WINDOW_MS))
    }, SAMPLE_INTERVAL_MS)
    onCleanup(() => clearInterval(interval))
  })

  const currentResult = createMemo(() => {
    const messageID = currentMessageID()
    const parts = messageID ? (sync().data.part[messageID] as Part[] | undefined) : undefined
    return computeLiveGenerationRate(samples(), parts)
  })

  const current = createMemo(() => {
    const { rate } = currentResult()
    if (typeof rate === "number") setLastRate(rate)
    return rate
  })

  const source = createMemo(() => currentResult().source)

  return createMemo<LiveGenerationRateState>(() => ({
    current: current(),
    last: lastRate(),
    source: source(),
  }))
}
