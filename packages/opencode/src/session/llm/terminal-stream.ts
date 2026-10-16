import type { LLMEvent } from "@opencode-ai/llm"
import { Effect, Stream } from "effect"
import { ProviderError } from "@/provider/error"

/**
 * V1 production stream admission invariant: natural EOF requires an explicit
 * terminal disposition (finish or provider-error). SDK streams and native
 * streams are both subject to this fence. No turn may silently finish after
 * dropped reasoning/text/tool deltas; errors remain errors.
 * This does not fabricate missing tool completions.
 *
 * A deliberate consumer-side take/interruption never drains the final check.
 * A producer acknowledging cancellation may end without finish only when its
 * attempt's actual AbortSignal is aborted.
 *
 * The latch belongs to each subscription, not the service or Session.
 */
export function requireTerminalFinish<E>(
  source: Stream.Stream<LLMEvent, E>,
  abort: AbortSignal,
): Stream.Stream<LLMEvent, E | ProviderError.ResponseStreamError> {
  return Stream.unwrap(
    Effect.sync(() => {
      let terminated = false
      return source.pipe(
        Stream.map((event) => {
          // Provider errors are explicit terminal dispositions. The V1
          // processor throws these rather than treating them as success.
          if (event.type === "finish" || event.type === "provider-error") terminated = true
          return event
        }),
        Stream.concat(
          Stream.fromEffectDrain(
            Effect.suspend(() =>
              terminated || abort.aborted
                ? Effect.void
                : Effect.fail(new ProviderError.ResponseStreamError(
                    "Provider stream ended without a terminal finish event",
                  )),
            ),
          ),
        ),
      )
    }),
  )
}
