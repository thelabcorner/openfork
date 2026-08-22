import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Deferred, Effect } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID } from "../../src/session/schema"
import { SessionRunState } from "../../src/session/run-state"
import { testEffect } from "../lib/effect"

/**
 * t-manual-stop (opencode side): an operator cancel must be OBSERVABLE.
 *
 * The idle transition caused by SessionRunState.cancel publishes
 * session.idle with reason:"aborted" so downstream consumers (swarm
 * supervisors) can distinguish an operator stop from a natural turn end
 * and never auto-resume it. A naturally-completing run publishes the same
 * event WITHOUT the reason.
 */

const it = testEffect(LayerNode.compile(LayerNode.group([SessionRunState.node, EventV2Bridge.node])))

const work = Effect.succeed({} as SessionV1.WithParts)

/** Register a listener that resolves on the next session.idle payload. The
 * listener is attached synchronously (no pubsub subscription race). */
const nextIdle = Effect.gen(function* () {
  const events = yield* EventV2Bridge.Service
  const deferred = yield* Deferred.make<any>()
  yield* events.listen((event) =>
    event.type === "session.idle" ? Deferred.succeed(deferred, event as any) : Effect.void,
  )
  return deferred
})

it.instance("operator cancel publishes session.idle with reason aborted", () =>
  Effect.gen(function* () {
    const runState = yield* SessionRunState.Service
    const sessionID = SessionID.make("session-abort-test")

    const fiber = yield* nextIdle
    yield* Effect.forkChild(runState.ensureRunning(sessionID, work, Effect.never))
    yield* Effect.sleep("50 millis")
    yield* runState.cancel(sessionID)

    const event = yield* Deferred.await(fiber)
    expect(event.type).toBe("session.idle")
    expect(event.data.sessionID).toBe(sessionID)
    expect(event.data.reason).toBe("aborted")
  }).pipe(Effect.timeout("5 seconds")),
)

it.instance("cancel with no active run still publishes reason aborted", () =>
  Effect.gen(function* () {
    const runState = yield* SessionRunState.Service
    const sessionID = SessionID.make("session-abort-noop")

    const fiber = yield* nextIdle
    yield* runState.cancel(sessionID)

    const event = yield* Deferred.await(fiber)
    expect(event.data.sessionID).toBe(sessionID)
    expect(event.data.reason).toBe("aborted")
  }).pipe(Effect.timeout("5 seconds")),
)

it.instance("natural completion publishes session.idle without a reason", () =>
  Effect.gen(function* () {
    const runState = yield* SessionRunState.Service
    const sessionID = SessionID.make("session-natural-idle")

    const fiber = yield* nextIdle
    yield* Effect.sleep("20 millis")
    yield* runState.ensureRunning(sessionID, work, work)

    const event = yield* Deferred.await(fiber)
    expect(event.data.sessionID).toBe(sessionID)
    expect(event.data.reason).toBeUndefined()
  }).pipe(Effect.timeout("5 seconds")),
)
