import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { GlobalBus } from "@/bus/global"
import { estimateEventBytes, parseEventSequence } from "@opencode-ai/core/event-replay"
import { EventV2 } from "@opencode-ai/core/event"
import { createEventCoalescer, eventDeltaKey, mergeEventDeltas } from "@opencode-ai/core/event-coalescer"
import { Effect } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { EventApi } from "../groups/event"

import { adaptLegacyEvent, serializeLegacyEvent } from "@/server/event-serialization"

type LegacyEvent = { id: string; type: string; properties: unknown }
type SequencedLegacyEvent = { sequence: number; event: LegacyEvent }
type SequencedEvent = { sequence: number; event: EventV2.Payload }

const MAX_REPLAY_FRAMES = 128

function eventData(data: object, sequence?: string): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: sequence === undefined ? undefined : String(sequence),
    data: serializeLegacyEvent(data),
  }
}

function eventID() {
  return EventV2.ID.create()
}

function eventResponse(events: EventV2Bridge.Interface) {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const instance = yield* InstanceState.context
    const workspaceID = yield* InstanceState.workspaceID
    const subscriber = yield* EventV2.makeByteBoundedSubscriberQueue<SequencedLegacyEvent>({
      capacity: 256,
      maxBytes: 8 * 1024 * 1024,
      sizeOf: estimateEventBytes,
    })
    const coalescer = createEventCoalescer<SequencedEvent>(
      (item) => subscriber.offer({ sequence: item.sequence, event: adaptLegacyEvent(item.event) }),
      {
        keyOf: (item) => eventDeltaKey(item.event),
        orderBy: (item) => item.sequence,
        merge: (previous, next) => {
          const event = mergeEventDeltas(previous.event, next.event)
          return event === undefined ? undefined : { sequence: next.sequence, event }
        },
      },
    )
    const matches = (event: EventV2.Payload) =>
      event.location?.directory === instance.directory &&
      (event.location.workspaceID === undefined || event.location.workspaceID === workspaceID)
    let replaying = true
    const pendingLive: SequencedEvent[] = []
    // Both sources subscribe before readiness, and share one bounded queue so
    // disposal cannot race stream startup or overtake previously queued events.
    const unsubscribe = yield* events.listen((event) =>
      Effect.sync(() => {
        if (!matches(event)) return
        const sequence = events.sequenceOf(event)
        if (sequence === undefined) return
        const item = { sequence, event }
        if (replaying) pendingLive.push(item)
        else coalescer.offer(item)
      }),
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    yield* Effect.addFinalizer(() => Effect.sync(coalescer.dispose))
    const cursor = parseEventSequence(request.headers["last-event-id"], events.replayEpoch)
    const replay = events.replaySince(cursor, matches)
    const replayCutoff = replay.latest
    if (replay.kind === "gap" || replay.frames.length > MAX_REPLAY_FRAMES ||
      replay.frames.reduce((bytes, frame) => bytes + estimateEventBytes({ sequence: frame.sequence, event: adaptLegacyEvent(frame.event) }), 0) > 4 * 1024 * 1024) {
      // A reconnect that fell behind the bounded window cannot be repaired by
      // silently dropping old events. Emit a control event so the client can
      // hydrate a snapshot, while keeping the stream itself healthy.
      subscriber.offer({
        sequence: replay.latest,
        event: {
          id: eventID(),
          type: "server.stream.gap",
          properties: {
            requested: replay.kind === "gap" ? replay.requested : cursor ?? 0,
            oldest: replay.kind === "gap" ? replay.oldest : undefined,
            latest: replay.latest,
            directory: instance.directory,
          },
        },
      })
    } else {
      for (const frame of replay.frames) coalescer.offer({ sequence: frame.sequence, event: frame.event })
    }
    coalescer.flush()
    for (const item of pendingLive) {
      if (item.sequence > replayCutoff) coalescer.offer(item)
    }
    replaying = false
    coalescer.flush()
    const disposed = (event: { directory?: string; payload: { id?: string; type?: string; properties?: unknown } }) => {
      if (event.directory !== instance.directory || event.payload.type !== "server.instance.disposed") return
      coalescer.flush()
      subscriber.offer({
        sequence: events.replayLatest(),
        event: {
          id: event.payload.id ?? eventID(),
          type: "server.instance.disposed",
          properties: event.payload.properties ?? {},
        },
      })
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => GlobalBus.on("instance.disposed", disposed)),
      () => Effect.sync(() => GlobalBus.off("instance.disposed", disposed)),
    )
    const output = subscriber.stream.pipe(Stream.takeUntil((item) => item.event.type === "server.instance.disposed"))
    const heartbeat = Stream.tick("10 seconds").pipe(
      Stream.drop(1),
      // Heartbeats prove liveness but must not advance Last-Event-ID; only
      // domain frames participate in replay cursors.
      Stream.map(() => eventData({ id: eventID(), type: "server.heartbeat", properties: {} })),
    )

    yield* Effect.logInfo("event connected")
    return HttpServerResponse.stream(
      Stream.make(eventData({ id: eventID(), type: "server.connected", properties: { epoch: events.replayEpoch } }, cursor === undefined ? `${events.replayEpoch}:${replay.latest}` : undefined)).pipe(
        Stream.concat(
          output.pipe(
            Stream.map(({ sequence, event }) => eventData(event, `${events.replayEpoch}:${sequence}`)),
            Stream.merge(heartbeat, { haltStrategy: "left" }),
          ),
        ),
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
        Stream.ensuring(Effect.logInfo("event disconnected")),
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

export const eventHandlers = HttpApiBuilder.group(EventApi, "event", (handlers) =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    return handlers.handleRaw(
      "subscribe",
      Effect.fn("EventHttpApi.subscribe")(function* () {
        return yield* eventResponse(events)
      }),
    )
  }),
)
