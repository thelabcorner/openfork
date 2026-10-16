import { Effect } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"

/**
 * The binary-search fast path is only legal when V1 produces a monotone
 * text-only projection. In particular, signed reasoning, unfinished tools,
 * provider metadata, synthetic continuations and unknown parts are excluded.
 */
export function isMonotoneTextSuffix(messages: readonly SessionV1.WithParts[]): boolean {
  return messages.length > 0 && messages.every(
    (message) =>
      message.info.role === "assistant" &&
      message.info.finish === "end_turn" &&
      !message.info.summary &&
      !message.info.error &&
      message.parts.some((part) => part.type === "text" && part.text.length > 0) &&
      message.parts.every(
        (part) =>
          part.type === "step-start" ||
          part.type === "step-finish" ||
          (part.type === "text" &&
            !part.synthetic &&
            !part.ignored &&
            !part.metadata &&
            !("providerMetadata" in part && part.providerMetadata !== undefined) &&
            !("providerOptions" in part && part.providerOptions !== undefined)),
      ),
  )
}

/**
 * LACE: find the earliest admissible suffix that fits the token budget.
 *
 * The caller must guarantee the cost function is non-increasing as the start
 * index moves forward. In V1 this is restricted to finished, text-only
 * assistant messages with no special parts or provider metadata. Rich tool,
 * reasoning, multimodal, or unfinished turns use the conservative V1 path.
 *
 * Unlike speculative per-message token sums, the caller estimates complete
 * provider-projected suffixes, and the returned suffix is actually checked.
 * This avoids quadratic repeated serialization on oversized plain-text turns
 * without guessing provider token accounting.
 */
export function firstFittingSuffix<E, R>(input: {
  readonly starts: readonly number[]
  readonly budget: number
  readonly estimate: (start: number) => Effect.Effect<number, E, R>
}): Effect.Effect<number | undefined, E, R> {
  return Effect.gen(function* () {
    const { starts, budget } = input
    if (!Number.isFinite(budget) || budget <= 0 || starts.length === 0) return undefined

    // The newest candidate is the shortest valid suffix. If even it cannot
    // fit, there is no admissible nonempty suffix under the monotone contract.
    const newest = starts.length - 1
    // Binary partitioning never revisits a midpoint, including either
    // endpoint. Avoid a map and its allocations on the hot path.
    const fits = (index: number) =>
      input.estimate(starts[index]!).pipe(
        Effect.map((tokens) => Number.isFinite(tokens) && tokens >= 0 && tokens <= budget),
      )
    if (!(yield* fits(newest))) return undefined
    if (yield* fits(0)) return starts[0]!

    let lo = 0 // known not to fit
    let hi = newest // known to fit
    while (hi - lo > 1) {
      const mid = lo + Math.floor((hi - lo) / 2)
      if (yield* fits(mid)) hi = mid
      else lo = mid
    }
    return starts[hi]!
  })
}

export * as LaceCheckpointRetention from "./lace-checkpoint-retention"
