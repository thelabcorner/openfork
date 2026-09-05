import { Config } from "@/config/config"
import { GlobalBus, type GlobalEvent as GlobalBusEvent } from "@/bus/global"
import { EffectBridge } from "@/effect/bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { EventReplayBuffer, estimateEventBytes, parseEventSequence } from "@opencode-ai/core/event-replay"
import { createEventCoalescer, eventDeltaKey, mergeEventDeltas } from "@opencode-ai/core/event-coalescer"
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

type SequencedGlobalEvent = { sequence: number; event: GlobalBusEvent }

const MAX_REPLAY_FRAMES = 128

function eventData(data: object, sequence?: string): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: sequence === undefined ? undefined : String(sequence),
    data: serializeLegacyEvent(data),
  }
}

function eventResponse(replay: EventReplayBuffer<GlobalBusEvent>, sequences: WeakMap<object, number>) {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    yield* Effect.logInfo("global event connected")
    const subscriber = yield* EventV2.makeByteBoundedSubscriberQueue<SequencedGlobalEvent>({
      capacity: 256,
      maxBytes: 8 * 1024 * 1024,
      sizeOf: estimateEventBytes,
    })
    const coalescer = createEventCoalescer<SequencedGlobalEvent>(
      (item) => subscriber.offer(item),
      {
        keyOf: (item) => eventDeltaKey(item.event.payload),
        orderBy: (item) => item.sequence,
        merge: (previous, next) => {
          const payload = mergeEventDeltas(previous.event.payload, next.event.payload)
          return payload ? { sequence: next.sequence, event: { ...next.event, payload } } : undefined
        },
      },
    )
    let replaying = true
    const pendingLive: SequencedGlobalEvent[] = []
    const listener = (event: GlobalBusEvent) => {
      const sequence = sequences.get(event)
      if (sequence === undefined) return
      const item = { sequence, event }
      if (replaying) pendingLive.push(item)
      else coalescer.offer(item)
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
    const cursor = parseEventSequence(request.headers["last-event-id"], replay.epoch)
    const replayResult = replay.since(cursor)
    const replayLatest = replayResult.latest
    if (replayResult.kind === "gap" || replayResult.frames.length > MAX_REPLAY_FRAMES ||
      replayResult.frames.reduce((bytes, frame) => bytes + estimateEventBytes(frame), 0) > 4 * 1024 * 1024) {
      subscriber.offer({
        sequence: replayResult.latest,
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
      for (const frame of replayResult.frames) coalescer.offer({ sequence: frame.sequence, event: frame.event })
    }
    coalescer.flush()
    for (const item of pendingLive) {
      if (item.sequence > replayLatest) coalescer.offer(item)
    }
    replaying = false
    coalescer.flush()

    const events = subscriber.stream.pipe(
      Stream.map(({ event, sequence }) => eventData(event, `${replay.epoch}:${sequence}`)),
    )
    const heartbeat = Stream.tick("10 seconds").pipe(
      Stream.drop(1),
      Stream.map(() => eventData({ payload: { id: EventV2.ID.create(), type: "server.heartbeat", properties: {} } })),
    )

    return HttpServerResponse.stream(
      Stream.make(eventData({ payload: { id: EventV2.ID.create(), type: "server.connected", properties: { epoch: replay.epoch } } }, cursor === undefined ? `${replay.epoch}:${replayLatest}` : undefined)).pipe(
        Stream.concat(events.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
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
    const replay = new EventReplayBuffer<GlobalBusEvent>(4096, {
      maxBytes: 8 * 1024 * 1024,
      sizeOf: estimateEventBytes,
    })
    const sequences = new WeakMap<object, number>()
    const capture = (event: GlobalBusEvent) => {
      sequences.set(event, replay.append(event))
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => GlobalBus.on("event.replay", capture)),
      () => Effect.sync(() => GlobalBus.off("event.replay", capture)),
    )

    const health = Effect.fn("GlobalHttpApi.health")(function* () {
      return { healthy: true as const, version: InstallationVersion }
    })

    const event = Effect.fn("GlobalHttpApi.event")(function* () {
      return yield* eventResponse(replay, sequences)
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
