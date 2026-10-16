import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { BrowserHostBroker } from "@opencode-ai/core/browser/host-broker"
import { ExchangeBrowser } from "../../src/exchange/browser"
import { ExchangeError } from "../../src/exchange/error"
import { it } from "../lib/effect"

/**
 * Forward-boundary certainty for OFXP browser calls.
 *
 * The broker records WHERE a failure happened as a verified payload field. This
 * suite pins the projection rule that turns that field into the repository's
 * existing AmbiguousCommit contract: a mutating browser call whose dispatched
 * outcome cannot be confirmed must not be replayed blindly, while a read-only
 * call carries no external effect and stays an ordinary repeatable failure.
 */

const brokerResponse = (response: Effect.Effect<BrowserHostBroker.BrokerResponse>): BrowserHostBroker.Interface =>
  BrowserHostBroker.Service.of({
    register: () => Effect.die("certainty test does not register hosts"),
    dispatch: () => response,
    abort: () => Effect.void,
    pushEvent: () => Effect.void,
    list: () => Effect.succeed([]),
    listTabs: () => Effect.succeed([]),
    assign: () => Effect.die("certainty test does not assign tabs"),
    orphanSession: () => Effect.void,
  })

/** A broker-detected failure whose certainty is the thing under test. */
const interrupted = (
  certainty: BrowserHostBroker.BrowserErrorCertainty | undefined,
  tag: BrowserHostBroker.BrowserErrorTag = "BrowserControlInterrupted",
): Effect.Effect<BrowserHostBroker.BrokerResponse> =>
  Effect.succeed({
    ok: false as const,
    requestId: "req-certainty",
    elapsedMs: 1,
    error: {
      tag,
      message: "Browser control was interrupted",
      // The broker never marks a dispatched_unconfirmed failure retryable.
      retryable: certainty !== "dispatched_unconfirmed",
      ...(certainty === undefined ? {} : { certainty }),
    },
  })

const committedButUnreadable = (result: unknown): Effect.Effect<BrowserHostBroker.BrokerResponse> =>
  Effect.succeed({ ok: true as const, requestId: "req-1", elapsedMs: 1, result })

const contextFor = (
  broker: BrowserHostBroker.Interface,
  options: { readonly signal?: AbortSignal } = {},
): ExchangeBrowser.Context => ({
  principalId: "peer:session",
  broker,
  revalidate: () => Effect.void,
  ...options,
})

const runFailure = (input: ExchangeBrowser.Input, context: ExchangeBrowser.Context) =>
  ExchangeBrowser.execute(input, context).pipe(Effect.flip)

const click: ExchangeBrowser.Input = { operation: "click", args: { target: { ref: "e1", snapshotVersion: 1 } } }

describe("ExchangeBrowser dispatch certainty", () => {
  it.live("a mutating call whose dispatched outcome was lost is AmbiguousCommit with inspect-before-replay recovery", () =>
    Effect.gen(function* () {
      const error = yield* runFailure(click, contextFor(brokerResponse(interrupted("dispatched_unconfirmed"))))
      expect(error).toBeInstanceOf(ExchangeError.AmbiguousCommit)
      const detail = error instanceof ExchangeError.AmbiguousCommit ? error.detail : ""
      expect(detail).toContain("browser.click")
      // Recovery is state inspection, never blind replay.
      expect(detail).toContain("before replaying")
      expect(detail).not.toMatch(/just retry|retry it/i)
    }),
  )

  it.live("a mutating call rejected BEFORE dispatch is not ambiguous and stays retryable", () =>
    Effect.gen(function* () {
      const error = yield* runFailure(click, contextFor(brokerResponse(interrupted("not_dispatched"))))
      expect(error).not.toBeInstanceOf(ExchangeError.AmbiguousCommit)
      expect(error).toBeInstanceOf(ExchangeError.Cancelled)
    }),
  )

  it.live("a READ-ONLY call whose dispatched outcome was lost stays an ordinary repeatable failure", () =>
    Effect.gen(function* () {
      const error = yield* runFailure(
        { operation: "snapshot", args: {} },
        contextFor(brokerResponse(interrupted("dispatched_unconfirmed", "BrowserHostUnavailable"))),
      )
      expect(error).not.toBeInstanceOf(ExchangeError.AmbiguousCommit)
      expect(error).toBeInstanceOf(ExchangeError.DependencyUnavailable)
    }),
  )

  it.live("a mid-flight INTERRUPTION of a read-only call stays cancellation, never an automatic retry", () =>
    Effect.gen(function* () {
      const error = yield* runFailure(
        { operation: "snapshot", args: {} },
        contextFor(brokerResponse(interrupted("dispatched_unconfirmed"))),
      )
      // Certainty only decides whether the failure is ambiguous; it must never
      // convert an interruption into a silently auto-retried failure.
      expect(error).not.toBeInstanceOf(ExchangeError.AmbiguousCommit)
      expect(error).toBeInstanceOf(ExchangeError.Cancelled)
    }),
  )

  it.live("an unreadable MUTATION result is AmbiguousCommit (the host committed; only the payload was lost)", () =>
    Effect.gen(function* () {
      const error = yield* runFailure(click, contextFor(brokerResponse(committedButUnreadable({ nonsense: true }))))
      expect(error).toBeInstanceOf(ExchangeError.AmbiguousCommit)
    }),
  )

  it.live("an unreadable READ-ONLY result stays DependencyUnavailable", () =>
    Effect.gen(function* () {
      const error = yield* runFailure(
        { operation: "snapshot", args: {} },
        contextFor(brokerResponse(committedButUnreadable({ nonsense: true }))),
      )
      expect(error).toBeInstanceOf(ExchangeError.DependencyUnavailable)
    }),
  )

  it.live("a pre-entry aborted signal stays Cancelled and never reaches the broker", () =>
    Effect.gen(function* () {
      let dispatched = 0
      const response = interrupted("not_dispatched")
      const broker: BrowserHostBroker.Interface = {
        ...brokerResponse(response),
        dispatch: () =>
          Effect.suspend(() => {
            dispatched++
            return response
          }),
      }
      const controller = new AbortController()
      controller.abort()
      const error = yield* runFailure(click, contextFor(broker, { signal: controller.signal }))
      expect(error).toBeInstanceOf(ExchangeError.Cancelled)
      expect(dispatched).toBe(0)
    }),
  )

  it.live("a successful mutating call still reports attempted+committed", () =>
    Effect.gen(function* () {
      const broker = brokerResponse(
        committedButUnreadable({
          clicked: {
            target: { kind: "ref", ref: "e1" },
            coords: { x: 1, y: 2 },
            clickCount: 1,
          },
        }),
      )
      const result = yield* ExchangeBrowser.execute(click, contextFor(broker))
      expect(result.mutation).toEqual({ attempted: true, committed: true })
    }),
  )
})