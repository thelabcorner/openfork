import { Config } from "@/config/config"
import { GlobalBus, type GlobalEvent as GlobalBusEvent } from "@/bus/global"
import { registerLegacyTransport } from "@/event-v2-bridge"
import { EffectBridge } from "@/effect/bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { EventReplayBuffer, estimateEventBytes, parseEventSequence } from "@opencode-ai/core/event-replay"
import { createEventCoalescer, eventDeltaKey, mergeEventDeltas } from "@opencode-ai/core/event-coalescer"
import { EventTrace } from "@opencode-ai/core/event-trace"
import { Installation } from "@/installation"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Effect } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { ModelPreferences } from "@/preference/model-preferences"
import { serializeLegacyEvent } from "@/server/event-serialization"
import { RootHttpApi } from "../api"
import { GlobalUpgradeInput, ModelPreferencesPatch } from "../groups/global"

// `sequence` is optional because control frames (heartbeat, gap) are not
// replayable domain state: they must not mint or reuse a Last-Event-ID cursor.
// Only frames carrying a sequence get an `id:` on the wire.
type SequencedGlobalEvent = { sequence?: number; event: GlobalBusEvent }

// Exported so tests can assert the coupling below against the real constants
// instead of duplicated literals: a test that hardcodes today's numbers stops
// detecting the bug the moment either number moves.
export const RING_CAPACITY = 4096
// A replay is only refused when it is genuinely too expensive to resend. The
// ring already bounds retention by count (RING_CAPACITY) and by bytes (8 MiB),
// so a second 128-frame ceiling made ~97% of the retained window unusable and
// forced a full hydration on any reconnect longer than a fraction of a second
// of streaming. Reuse the ring's own capacity and trust its byte budget — this
// matches the native route (packages/server/src/handlers/event.ts).
// Exported so tests assert the queue/ceiling coupling against real values.
export const MAX_REPLAY_FRAMES = RING_CAPACITY
const MAX_REPLAY_BYTES = 4 * 1024 * 1024
// Live-event headroom on top of a full replay window in the subscriber queue.
export const SUBSCRIBER_HEADROOM = 256

/**
 * One connected range's replay state. A fresh generation starts a new epoch
 * and a new ring, so a cursor from a previous connected range cannot be
 * replayed against an unrelated window.
 */
type ReplayGeneration = {
  readonly replay: EventReplayBuffer<GlobalBusEvent>
  readonly sequences: WeakMap<object, number>
}

function newReplayGeneration(): ReplayGeneration {
  return {
    replay: new EventReplayBuffer<GlobalBusEvent>(RING_CAPACITY, {
      maxBytes: 8 * 1024 * 1024,
      sizeOf: estimateEventBytes,
    }),
    sequences: new WeakMap<object, number>(),
  }
}

/**
 * Controls when the legacy ring captures, and how much of it is retained.
 *
 * Two independent consumers:
 *
 * 1. The bridge allocation gate. A registered `event.replay` listener is NOT
 *    evidence of a client, so it must not keep the legacy bridge allocating an
 *    envelope per publish.
 * 2. The capture itself. Capturing only while a subscriber is connected also
 *    removes the per-publish ring append from the zero-client path.
 *
 * Completeness argument: `connect()` runs BEFORE the caller reads
 * `replay.since(...)`, and `release()` runs only in scope release, so the
 * whole window a connected client's cursor covers is captured. The generation
 * is replaced only while `subscribers === 0`, i.e. when no client can hold a
 * cursor in it; overlapping connects therefore share one ring and one
 * monotonic sequence space, and a reconnect within a connected range resumes
 * normally instead of seeing a spurious gap.
 */
class GlobalReplayGate {
  private subscribers = 0
  private generation = newReplayGeneration()

  get active() {
    return this.subscribers > 0
  }

  /** Current generation. Only meaningful while a subscriber is connected. */
  get current() {
    return this.generation
  }

  /**
   * Begin a connected range. Returns the generation to read plus the release
   * function, which is idempotent and must run exactly once per connect.
   */
  connect(): { generation: ReplayGeneration; release: () => void } {
    if (this.subscribers === 0) {
      // No subscriber was connected, so no client can hold a cursor in the
      // outgoing generation. Start a fresh one (new ring, new epoch) BEFORE
      // the caller reads `replay.since(...)`. A client reconnecting into the
      // new range carries a cursor stamped with the previous epoch, which
      // `parseEventSequence(cursor, epoch)` rejects as -1, so it is reported
      // as a gap and the client hydrates from a snapshot rather than
      // silently replaying an unrelated window. Nothing is discarded from a
      // window a live client could still resume: while `subscribers > 0` the
      // generation is never replaced, so an overlapping reconnect shares the
      // same ring and the same monotonic sequence space.
      this.generation = newReplayGeneration()
    }
    this.subscribers += 1
    const generation = this.generation
    let released = false
    return {
      generation,
      release: () => {
        if (released) return
        released = true
        this.subscribers = Math.max(0, this.subscribers - 1)
      },
    }
  }
}

function eventData(data: object, sequence?: string): Sse.Event {
  const started = performance.now()
  const frame = serializeLegacyEvent(data)
  EventTrace.timing("global.serializeMs", performance.now() - started)
  EventTrace.sum("global.serializeBytes", frame.length)
  return {
    _tag: "Event",
    event: "message",
    id: sequence === undefined ? undefined : String(sequence),
    data: frame,
  }
}

function eventResponse(gate: GlobalReplayGate) {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    // Opening a connected range must happen BEFORE the replay read below so
    // capture is live for the whole window this client's cursor covers.
    const { generation, release } = gate.connect()
    yield* Effect.addFinalizer(() => Effect.sync(release))
    const replay = generation.replay
    const sequences = generation.sequences
    yield* Effect.logInfo("global event connected")
    // Request-derived context must be read here, not inside the stream: the
    // body stream runs after this effect returns and no longer has access to
    // per-request services.
    const cursor = parseEventSequence(request.headers["last-event-id"], replay.epoch)

    // Every resource below is created inside `Stream.unwrap`, so its lifetime
    // is bound to the response body stream instead of the request scope. The
    // subscription must survive until the body completes, not merely until the
    // response value is handed back to the server. Registration still happens
    // before `server.connected` is observable, because the whole effect runs
    // before the returned stream emits its first frame.
    const output = Stream.unwrap(
      Effect.gen(function* () {
        const subscriber = yield* EventV2.makeByteBoundedSubscriberQueue<SequencedGlobalEvent>({
          // The subscriber queue must be able to hold a FULL replay window:
          // the entire replay is enqueued synchronously here, before the body
          // stream is ever pulled, and `offer` FAILS the stream on overflow
          // rather than dropping. So the capacity is coupled to
          // MAX_REPLAY_FRAMES: raising the replay ceiling without raising this
          // turns a reconnect more than `capacity` frames behind into a hard
          // disconnect instead of a replay or a gap. The +SUBSCRIBER_HEADROOM
          // keeps space for live events arriving while the replay is enqueued.
          capacity: MAX_REPLAY_FRAMES + SUBSCRIBER_HEADROOM,
          maxBytes: 8 * 1024 * 1024,
          sizeOf: estimateEventBytes,
        })
        const coalescer = createEventCoalescer<SequencedGlobalEvent>(
          (item) => {
            const accepted = subscriber.offer(item)
            EventTrace.count(accepted ? "global.subscriberOffered" : "global.subscriberFailed")
          },
          {
            keyOf: (item) => eventDeltaKey(item.event.payload),
            orderBy: (item) => item.sequence ?? 0,
            merge: (previous, next) => {
              const payload = mergeEventDeltas(previous.event.payload, next.event.payload)
              return payload ? { sequence: next.sequence, event: { ...next.event, payload } } : undefined
            },
          },
        )
        const offerCoalescer = (item: SequencedGlobalEvent) => {
          EventTrace.count("global.coalescerIn")
          coalescer.offer(item)
        }
        let replaying = true
        const pendingLive: SequencedGlobalEvent[] = []
        const listener = (event: GlobalBusEvent) => {
          const sequence = sequences.get(event)
          if (sequence === undefined) return
          const item = { sequence, event }
          if (replaying) pendingLive.push(item)
          else offerCoalescer(item)
        }
        // Register before server.connected is observable, not when concat starts
        // pulling its second stream. Scope cleanup also covers an unread response.
        yield* Effect.acquireRelease(
          Effect.sync(() => GlobalBus.on("event", listener)),
          () =>
            Effect.sync(() => {
              GlobalBus.off("event", listener)
              coalescer.dispose()
            }),
        )
        const replayResult = replay.since(cursor)
        const replayLatest = replayResult.latest
        // `replayResult.bytes` is the sum of the sizes the ring already recorded
        // at append time, so this costs no traversal, no per-frame wrapper
        // allocation and no re-estimate. Shared with the native route rather
        // than open-coded here.
        EventTrace.event({
          phase: "sse.reconnect",
          route: "global",
          fresh: cursor === undefined,
          kind: replayResult.kind,
          frames: replayResult.kind === "gap" ? 0 : replayResult.frames.length,
          bytes: replayResult.kind === "gap" ? 0 : replayResult.bytes,
        })
        if (replayResult.kind === "gap") EventTrace.count("global.gap")
        if (replayResult.kind === "gap" || replayResult.frames.length > MAX_REPLAY_FRAMES ||
          replayResult.bytes > MAX_REPLAY_BYTES) {
          // Deliberately sequence-free. `replayResult.latest` is the last
          // sequence already assigned to a real event, so using it here emitted a
          // duplicate, non-monotonic SSE id. A gap is a repair signal, not
          // replayable domain state, so it needs no cursor.
          subscriber.offer({
            event: {
              directory: "global",
              payload: {
                id: EventV2.ID.create(),
                type: "server.stream.gap",
                properties: {
                  requested: replayResult.kind === "gap" ? replayResult.requested : cursor ?? 0,
                  oldest: replayResult.kind === "gap" ? replayResult.oldest : undefined,
                  latest: replayResult.latest,
                },
              },
            },
          })
        } else {
          for (const frame of replayResult.frames) offerCoalescer({ sequence: frame.sequence, event: frame.event })
        }
        coalescer.flush()
        for (const item of pendingLive) {
          if ((item.sequence ?? 0) > replayLatest) offerCoalescer(item)
        }
        replaying = false
        coalescer.flush()

        const events = subscriber.stream.pipe(
          Stream.map(({ event, sequence }) =>
            eventData(event, sequence === undefined ? undefined : `${replay.epoch}:${sequence}`),
          ),
        )
        // A real `server.heartbeat` frame, never an SSE comment: the SDK parser
        // treats `: heartbeat` as an unknown field, so it produces a frame with
        // `hasData: false` that the generated client does not yield — a comment
        // therefore never refreshes the app's stream liveness. Emitting no id
        // keeps heartbeats from advancing Last-Event-ID.
        const heartbeat = Stream.tick("10 seconds").pipe(
          Stream.drop(1),
          Stream.map(() => eventData({ payload: { id: EventV2.ID.create(), type: "server.heartbeat", properties: {} } })),
        )

        return Stream.make(
          eventData(
            { payload: { id: EventV2.ID.create(), type: "server.connected", properties: { epoch: replay.epoch } } },
            cursor === undefined ? `${replay.epoch}:${replayLatest}` : undefined,
          ),
        ).pipe(Stream.concat(events.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))))
      }),
    )

    return HttpServerResponse.stream(
      output.pipe(
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
        Stream.ensuring(Effect.logInfo("global event disconnected")),
      ),
      {
        contentType: "text/event-stream",
        headers: {
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        },
      },
    )
  })
}

export const globalHandlers = HttpApiBuilder.group(RootHttpApi, "global", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const installation = yield* Installation.Service
    const bridge = yield* EffectBridge.make()
    const gate = new GlobalReplayGate()
    // Capture is registered for the route's lifetime but only APPENDS while a
    // subscriber is connected. Registering unconditionally keeps the
    // documented invariant that replay capture must remain complete even if a
    // compatibility listener throws: the internal `event.replay` channel is
    // fanned out by `GlobalBus.emit` before `event`, and this listener
    // neither throws nor depends on any `event` listener having run.
    const capture = (event: GlobalBusEvent) => {
      if (!gate.active) return
      const generation = gate.current
      generation.sequences.set(event, generation.replay.append(event))
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => GlobalBus.on("event.replay", capture)),
      () => Effect.sync(() => GlobalBus.off("event.replay", capture)),
    )
    // Tell the bridge that a legacy consumer exists only while a /global/event
    // client is actually connected. Registration is not consumption, so the
    // capture listener above must not keep the bridge allocating.
    const unregisterTransport = registerLegacyTransport(() => gate.active)
    yield* Effect.addFinalizer(() => Effect.sync(unregisterTransport))

    const health = Effect.fn("GlobalHttpApi.health")(function* () {
      return { healthy: true as const, version: InstallationVersion }
    })

    const event = Effect.fn("GlobalHttpApi.event")(function* () {
      return yield* eventResponse(gate)
    })

    const configGet = Effect.fn("GlobalHttpApi.configGet")(function* () {
      return yield* config.getGlobal()
    })

    const configUpdate = Effect.fn("GlobalHttpApi.configUpdate")(function* (ctx) {
      const result = yield* config.updateGlobal(ctx.payload)
      if (result.changed) bridge.fork(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }))
      return result.info
    })

    // Model selector preferences are plain shared UI state, not config: they
    // must never dispose instances the way `configUpdate` does, because the
    // desktop writes one on every rail drag.
    const preferencesGet = Effect.fn("GlobalHttpApi.preferencesGet")(function* () {
      return yield* Effect.promise(() => ModelPreferences.get())
    })

    const preferencesUpdate = Effect.fn("GlobalHttpApi.preferencesUpdate")(function* (ctx: {
      payload: typeof ModelPreferencesPatch.Type
    }) {
      return yield* Effect.promise(() => ModelPreferences.update(ctx.payload))
    })

    const dispose = Effect.fn("GlobalHttpApi.dispose")(function* () {
      yield* disposeAllInstancesAndEmitGlobalDisposed()
      return true
    })

    const upgrade = Effect.fn("GlobalHttpApi.upgrade")(function* (ctx: { payload: typeof GlobalUpgradeInput.Type }) {
      const method = yield* installation.method()
      if (method === "unknown") {
        return HttpServerResponse.jsonUnsafe(
          { success: false as const, error: "Unknown installation method" },
          { status: 400 },
        )
      }
      const target = ctx.payload.target
      const result = yield* installation.upgrade(method, target).pipe(
        Effect.as({ success: true as const, version: target }),
        Effect.catch((err) =>
          Effect.succeed({
            success: false as const,
            error: err instanceof Error ? err.message : String(err),
          }),
        ),
      )
      if (!result.success) return HttpServerResponse.jsonUnsafe(result, { status: 500 })
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Installation.Event.Updated.type,
          properties: { version: target },
        },
      })
      return HttpServerResponse.jsonUnsafe(result)
    })

    return handlers
      .handle("health", health)
      .handleRaw("event", event)
      .handle("configGet", configGet)
      .handle("configUpdate", configUpdate)
      .handle("preferencesGet", preferencesGet)
      .handle("preferencesUpdate", preferencesUpdate)
      .handle("dispose", dispose)
      .handle("upgrade", upgrade)
  }),
)
