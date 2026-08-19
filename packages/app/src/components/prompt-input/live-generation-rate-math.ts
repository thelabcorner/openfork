import type { Part } from "@opencode-ai/sdk/v2/client"

export const CHARS_PER_TOKEN = 4
// Below this much history the ratio is too noisy to show — wait rather than
// flash a number that's about to jump.
export const MIN_WINDOW_MS = 600
const SMOOTHING = 0.3

export type Sample = { time: number; chars: number }

/**
 * Whether the rate was derived from upstream server-side part timing
 * (`"measured"`) or estimated from character growth sampling (`"estimated"`).
 */
export type GenerationRateSource = "measured" | "estimated"

/**
 * `null` — nothing to show (idle, or not enough samples yet).
 * `"paused"` — actively generating, but no new text/reasoning characters
 * arrived within the sampling window (tool executing, waiting on the first
 * token, etc.) — deliberately distinct from `0` so the UI doesn't claim a
 * measured rate of zero.
 * `number` — estimated tokens/sec, exponentially smoothed across consecutive
 * sample pairs for a stable, responsive readout.
 */
export type LiveGenerationRate = number | "paused" | null

export const streamedChars = (parts: Part[] | undefined) => {
  if (!parts) return 0
  let chars = 0
  for (const part of parts) {
    if (part.type === "text") {
      if (part.synthetic || part.ignored) continue
      chars += part.text.length
    } else if (part.type === "reasoning") {
      chars += part.text.length
    }
  }
  return chars
}

/**
 * Attempts to compute a tokens/sec rate directly from upstream part timing
 * data (the server-stamped `time.start` on text/reasoning parts). Returns
 * the rate and its source when measurable, or `null` when timing data is
 * unavailable (no parts, no text/reasoning parts, or no elapsed time yet).
 *
 * During active streaming the current text part has `time.start` but no
 * `time.end`, so elapsed time is `now - part.time.start`. This isolates
 * actual generation wall-clock time rather than the sampling-window
 * approximation used by the EWMA fallback.
 */
export const computeMeasuredRate = (parts: Part[] | undefined, now?: number): { rate: number; source: GenerationRateSource } | null => {
  if (!parts) return null

  let earliestStart: number | undefined
  let latestEnd: number | undefined
  let hasOpenPart = false

  for (const part of parts) {
    if (part.type !== "text" && part.type !== "reasoning") continue
    if (part.type === "text" && (part.synthetic || part.ignored)) continue
    const time = part.time
    if (!time || time.start === undefined) continue
    if (earliestStart === undefined || time.start < earliestStart) {
      earliestStart = time.start
    }
    // Track the latest end timestamp across all closed parts — for a single
    // open part this stays undefined, for completed parts it bounds the
    // generation window.
    if (time.end !== undefined) {
      if (latestEnd === undefined || time.end > latestEnd) {
        latestEnd = time.end
      }
    } else {
      hasOpenPart = true
    }
  }

  if (earliestStart === undefined) return null

  // Use the latest end time for closed parts, or fall back to now for open
  // (still-streaming) parts.
  const referenceTime = hasOpenPart ? (now ?? Date.now()) : (latestEnd ?? (now ?? Date.now()))
  const elapsedMs = referenceTime - earliestStart
  // Need at least 600ms of generation time to avoid noise from very short
  // bursts or clock jitter.
  if (elapsedMs < MIN_WINDOW_MS) return null

  const chars = streamedChars(parts)
  if (chars === 0) return hasOpenPart ? { rate: 0, source: "measured" } : null

  const tokens = chars / CHARS_PER_TOKEN
  return { rate: tokens / (elapsedMs / 1000), source: "measured" }
}

/**
 * Computes a smoothed tokens/sec rate from consecutive sample pairs using
 * exponential weighted moving average (EWMA). Each pair of adjacent samples
 * yields an instantaneous rate, which is blended into the running estimate
 * with a smoothing factor of 0.3 — giving ~70% weight to history and ~30%
 * to the latest tick. This produces a stable readout that still tracks
 * real throughput changes within a few hundred milliseconds.
 *
 * When `parts` are provided, the function first attempts to derive a rate
 * from upstream server-side part timing (`computeMeasuredRate`). If timing
 * data is available, it is returned directly — no smoothing needed since
 * the server timestamps are authoritative. Falls back to EWMA character
 * sampling only when upstream timing is unavailable.
 *
 * Returns `null` until at least two sample pairs exist with meaningful
 * elapsed time (warm-up guard). Returns `"paused"` when chars are not
 * growing despite elapsed time.
 */
export const computeLiveGenerationRate = (
  samples: Sample[],
  parts?: Part[],
  now?: number,
): { rate: LiveGenerationRate; source: GenerationRateSource } => {
  // Prefer upstream measured timing when available.
  const measured = computeMeasuredRate(parts, now)
  if (measured !== null) {
    return { rate: measured.rate, source: measured.source }
  }

  // Fall back to EWMA character-sampling estimation.
  if (samples.length < 3) return { rate: null, source: "estimated" }

  let smoothed: number | null = null
  let hasGrowth = false

  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1]
    const curr = samples[i]
    const dt = (curr.time - prev.time) / 1000
    if (dt <= 0) continue

    const dChars = curr.chars - prev.chars
    if (dChars > 0) hasGrowth = true

    const delta = Math.max(0, dChars)
    const instantRate = (delta / CHARS_PER_TOKEN) / dt

    smoothed = smoothed === null ? instantRate : smoothed + SMOOTHING * (instantRate - smoothed)
  }

  if (smoothed === null) return { rate: null, source: "estimated" }
  if (!hasGrowth) return { rate: "paused", source: "estimated" }
  return { rate: smoothed, source: "estimated" }
}
