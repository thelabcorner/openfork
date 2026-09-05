import { EventV2 } from "@opencode-ai/core/event"
import { EventReplayBuffer, estimateEventBytes, parseEventSequence } from "@opencode-ai/core/event-replay"
import { createEventCoalescer, eventDeltaKey, mergeEventDeltas } from "@opencode-ai/core/event-coalescer"
import { Effect, Stream } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { Api } from "../api"
import { serializeEvent } from "../event-serializer"

const subscriberCapacity = 256
const MAX_REPLAY_FRAMES = 128

type WireEvent = { id: string; type: string; data: unknown }
type SequencedWireEvent = { sequence?: number; event: WireEvent }
type SequencedEvent = { sequence: number; event: EventV2.Payload }

function eventData(data: object, sequence?: string): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: sequence === undefined ? undefined : String(sequence),
    data: serializeEvent(data),
  }
}

export const EventHandler = HttpApiBuilder.group(Api, "server.event", (handlers) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const replay = new EventReplayBuffer<EventV2.Payload>(4096, {
      maxBytes: 8 * 1024 * 1024,
      sizeOf: estimateEventBytes,
    })
    const sequences = new WeakMap<object, number>()
    const capture = yield* events.listen((event) =>
      Effect.sync(() => {
        sequences.set(event, replay.append(event))
      }),
    )
    yield* Effect.addFinalizer(() => capture)
    return handlers.handleRaw("event.subscribe", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const output = Stream.unwrap(
          Effect.gen(function* () {
            const subscriber = yield* EventV2.makeByteBoundedSubscriberQueue<SequencedWireEvent>({
              capacity: subscriberCapacity,
              maxBytes: 8 * 1024 * 1024,
              sizeOf: estimateEventBytes,
            })
            const coalescer = createEventCoalescer<SequencedEvent>(
              (item) =>
                subscriber.offer({
                  sequence: item.sequence,
                  event: { id: item.event.id, type: item.event.type, data: item.event.data },
                }),
              {
                keyOf: (item) => eventDeltaKey(item.event),
                orderBy: (item) => item.sequence,
                merge: (previous, next) => {
                  const event = mergeEventDeltas(previous.event, next.event)
                  return event === undefined ? undefined : { sequence: next.sequence, event }
                },
              },
            )
            let replaying = true
            const pendingLive: SequencedEvent[] = []
            const unsubscribe = yield* events.listen((event) =>
              Effect.sync(() => {
                const sequence = sequences.get(event)
                if (sequence === undefined) return
                const item = { sequence, event }
                if (replaying) pendingLive.push(item)
                else coalescer.offer(item)
              }),
            )
            yield* Effect.addFinalizer(() => unsubscribe)
            yield* Effect.addFinalizer(() => Effect.sync(coalescer.dispose))
            const cursor = parseEventSequence(request.headers["last-event-id"], replay.epoch)
            const replayResult = replay.since(cursor)
            if (replayResult.kind === "gap" || replayResult.frames.length > MAX_REPLAY_FRAMES ||
              replayResult.frames.reduce((bytes, frame) => bytes + estimateEventBytes({ sequence: frame.sequence,
                event: { id: frame.event.id, type: frame.event.type, data: frame.event.data } }), 0) > 4 * 1024 * 1024) {
              subscriber.offer({
                sequence: replayResult.latest,
                event: {
                  id: EventV2.ID.create(),
                  type: "server.stream.gap",
                  data: {
                    requested: replayResult.kind === "gap" ? replayResult.requested : cursor ?? 0,
                    oldest: replayResult.kind === "gap" ? replayResult.oldest : undefined,
                    latest: replayResult.latest,
                  },
                },
              })
            } else {
              for (const frame of replayResult.frames) coalescer.offer({ sequence: frame.sequence, event: frame.event })
            }
            coalescer.flush()
            for (const item of pendingLive) {
              if (item.sequence > replayResult.latest) coalescer.offer(item)
            }
            replaying = false
            coalescer.flush()
            const live = subscriber.stream.pipe(
              Stream.takeUntil((item) => item.event.type === "server.instance.disposed"),
            )
            const connected: SequencedWireEvent = {
              sequence: cursor === undefined ? replayResult.latest : undefined,
              event: { id: EventV2.ID.create(), type: "server.connected", data: { epoch: replay.epoch } },
            }
            return Stream.make(connected).pipe(Stream.concat(live))
          }),
        ).pipe(
          Stream.map(({ sequence, event }) => eventData(event, sequence === undefined ? undefined : `${replay.epoch}:${sequence}`)),
          Stream.pipeThroughChannel(Sse.encode()),
        )
        // Keep the legacy route on the same 10s liveness cadence as the v2
        // instance/global streams. Heartbeats are comments, so they do not
        // advance the replay cursor or count as delivered domain frames.
        const heartbeat = Stream.tick("10 seconds").pipe(Stream.map(() => ": heartbeat\n\n"))
        return HttpServerResponse.stream(
          output.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }), Stream.encodeText),
          {
            contentType: "text/event-stream",
            headers: {
              "Cache-Control": "no-cache, no-transform",
              "X-Accel-Buffering": "no",
              "X-Content-Type-Options": "nosniff",
            },
          },
        )
      }),
    )
  }),
)
