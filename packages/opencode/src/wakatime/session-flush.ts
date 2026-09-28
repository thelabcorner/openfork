import { Effect, Layer } from "effect"

import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { EventV2 } from "@opencode-ai/core/event"
import { WakaTime } from "@opencode-ai/core/wakatime"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"

/**
 * Thin `SessionStatusEvent.Idle` -> `WakaTime.requestFlushSession` adapter.
 *
 * `Idle` is the one canonical terminal settlement signal: `SessionStatus.set`
 * publishes it after natural success, after a terminal error, and after an
 * explicit abort, and only once durable execution ownership has actually been
 * released. That single event is therefore the only settlement fact this
 * adapter needs. Separate success / failed / interrupted hooks would be a second
 * lifecycle stream projecting the same answer onto the same flush.
 *
 * Tier-0 process-global consumer, and nothing else:
 *
 * - No Location/Instance ownership. A settled session is a process fact, so this
 *   never asks for a directory, never reaches `InstanceStore`, and never
 *   materializes a workspace graph in order to learn that a session ended.
 * - No message, part, history, or session lookup. Idle handling is O(1): read
 *   `event.data.sessionID` and dispatch it.
 * - No per-session state, timer, fiber, or listener. One listener for the whole
 *   process, so N concurrent sessions cost exactly one callback.
 * - No flush on nonterminal transitions. `busy` / `retry` / `Status` are not
 *   settlement, so they are never subscribed to.
 *
 * EventV2 invokes `listenType` callbacks inline on the publish path, so the
 * callback must never hold session settlement on telemetry work. It therefore
 * calls `requestFlushSession`, not `flushSession`: `requestFlushSession` is
 * Core's non-blocking lifecycle entry point, doing only bounded process-memory
 * work under Core's own queue mutex and re-arming Core's single existing
 * scheduler. A blocked wakatime-cli can therefore never delay — let alone fail —
 * the `SessionStatus.set` that published the Idle event.
 */

/**
 * Subscriber-only layer: it exports no service, because nothing may call it
 * directly. The Idle event is the only entry point, and a public method here
 * would be an invitation to add a second, non-canonical flush path.
 *
 * The subscription is scope-bound rather than detached: `acquireRelease` ties
 * the one unsubscribe to this graph's layer scope, so closing the graph releases
 * the listener and nothing outlives its owner. Global-node memoization is what
 * makes that safe with two graphs in one process — the second graph reuses the
 * live instance instead of installing a second listener.
 */
const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const wakatime = yield* WakaTime.Service

    const settle = (sessionID: string) =>
      wakatime.requestFlushSession(sessionID).pipe(
        // Telemetry is best-effort. Isolating the cause here also means the
        // callback can never fault: EventV2 detaches a listener on its first
        // failure, which would silently stop every later session from settling.
        Effect.catchCause((cause) => Effect.logWarning("WakaTime session settlement flush request failed", { sessionID, cause })),
      )

    yield* Effect.acquireRelease(
      // `listenType` (not `listen`) so unrelated high-rate events never invoke
      // this callback just to be filtered out, and (not `subscribe`) so the
      // adapter owns an explicit unsubscribe instead of a fiber and a scope.
      events.listenType(SessionStatusEvent.Idle, (event) => settle(event.data.sessionID)),
      (unsubscribe) => unsubscribe.pipe(Effect.catchCause((cause) => Effect.logWarning("WakaTime session flush unsubscribe failed", { cause }))),
    )
  }),
)

export const node = makeGlobalNode({
  name: "wakatime-session-flush",
  layer,
  deps: [EventV2.node, WakaTime.node],
})

export * as WakaTimeSessionFlush from "./session-flush"
