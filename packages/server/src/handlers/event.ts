import { EventV2 } from "@opencode-ai/core/event"
import { EventReplayBuffer, estimateEventBytes, parseEventSequence } from "@opencode-ai/core/event-replay"
import { createEventCoalescer, eventDeltaKey, mergeEventDeltas } from "@opencode-ai/core/event-coalescer"
import { Effect, Stream } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { Api } from "../api"
import { serializeEvent, wireEvent, type WireEvent } from "../event-serializer"
import { EventTrace } from "@opencode-ai/core/event-trace"

export const ringCapacity = 4096
// A full replay window is enqueued synchronously, before the response stream is
// ever consumed, so the subscriber queue's ITEM capacity must exceed the replay
// window. At the old MAX_REPLAY_FRAMES of 128 a 256-item queue was comfortably
// ahead of the burst; raising the ceiling to the ring capacity makes this
// coupling load-bearing -- a 4096-frame replay into a 256-item queue overflows
// it and fails the stream with SubscriberOverflowError, turning a reconnect
// into a hard disconnect. Keep the headroom for live events that arrive while
// the replay is still being enqueued.
export const subscriberCapacity = ringCapacity + 256
const ringMaxBytes = 8 * 1024 * 1024
// A replay is only refused when it is genuinely too expensive to resend. The
// ring already bounds retention by count (4096) and by bytes (8 MiB), so a
// second 128-frame ceiling made ~97% of the retained window unusable and
// forced a full hydration on any reconnect longer than a fraction of a second
// of streaming. Reuse the ring's own capacity and trust its byte budget.
export const MAX_REPLAY_FRAMES = ringCapacity
// The byte guard must not sit below the ring's own retention budget. The ring
// can never produce more than it retains, so a guard under `ringMaxBytes`
// means holding bytes we refuse to send and forcing a full snapshot hydration
// for a window the server is already retaining -- the same defect as a frame
// ceiling below the ring capacity. Match the ring so the two budgets agree.
export const MAX_REPLAY_BYTES = ringMaxBytes

/**
 * Control frames are not replayable domain events: `server.heartbeat` proves
 * liveness, `server.stream.gap` is a repair signal, and
 * `server.instance.disposed` terminates the stream. None of them may carry an
 * `id:` field.
 *
 * The previous shape stamped them with a real event's sequence, so one SSE id
 * identified two different positions and the id was non-monotonic. Omitting the
 * id also keeps them from advancing Last-Event-ID, which is what makes a
 * heartbeat safe to emit on an otherwise idle stream.
 */

type SequencedWireEvent = { sequence?: number; event: WireEvent }
type SequencedEvent = { sequence: number; event: EventV2.Payload }

function eventData(data: object, sequence?: string): Sse.Event {
  const started = performance.now()
  const frame = serializeEvent(data)
  EventTrace.timing("native.serializeMs", performance.now() - started)
  EventTrace.sum("native.serializeBytes", frame.length)
  return {
    _tag: "Event",
    event: "message",
    id: sequence === undefined ? undefined : String(sequence),
    data: frame,
  }
}

export const EventHandler = HttpApiBuilder.group(Api, "server.event", (handlers) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const replay = new EventReplayBuffer<EventV2.Payload>(ringCapacity, {
      maxBytes: ringMaxBytes,
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
              (item) => {
                const accepted = subscriber.offer({ sequence: item.sequence, event: wireEvent(item.event) })
                EventTrace.count(accepted ? "native.subscriberOffered" : "native.subscriberFailed")
              },
              {
                keyOf: (item) => eventDeltaKey(item.event),
                orderBy: (item) => item.sequence,
                merge: (previous, next) => {
                  const event = mergeEventDeltas(previous.event, next.event)
                  return event === undefined ? undefined : { sequence: next.sequence, event }
                },
              },
            )
            const offerCoalescer = (item: SequencedEvent) => {
              EventTrace.count("native.coalescerIn")
              coalescer.offer(item)
            }
            let replaying = true
            const pendingLive: SequencedEvent[] = []
            const unsubscribe = yield* events.listen((event) =>
              Effect.sync(() => {
                const sequence = sequences.get(event)
                if (sequence === undefined) return
                const item = { sequence, event }
                if (replaying) pendingLive.push(item)
                else offerCoalescer(item)
              }),
            )
            yield* Effect.addFinalizer(() => unsubscribe)
            yield* Effect.addFinalizer(() => Effect.sync(coalescer.dispose))
            const cursor = parseEventSequence(request.headers["last-event-id"], replay.epoch)
            const replayResult = replay.since(cursor)
            // The ring recorded each frame's size once, at append time. Summing
            // those stored values is free; re-estimating per frame here costs a
            // full traversal of the window on the request path, and the fresh
            // wrapper object it used to allocate could never hit
            // estimateEventBytes' identity-keyed cache.
            const replayBytes = replayResult.kind === "gap" ? 0 : replayResult.bytes
            EventTrace.event({
              phase: "sse.reconnect",
              route: "native",
              fresh: cursor === undefined,
              kind: replayResult.kind,
              frames: replayResult.kind === "gap" ? 0 : replayResult.frames.length,
              bytes: replayBytes,
            })
            if (replayResult.kind === "gap" || replayResult.frames.length > MAX_REPLAY_FRAMES ||
              replayBytes > MAX_REPLAY_BYTES) {
              if (replayResult.kind === "gap") EventTrace.count("native.gap")
              subscriber.offer({
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
              for (const frame of replayResult.frames) offerCoalescer({ sequence: frame.sequence, event: frame.event })
            }
            coalescer.flush()
            for (const item of pendingLive) {
              if (item.sequence > replayResult.latest) offerCoalescer(item)
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
            // Keep the legacy routes' 10s liveness cadence. This must be a real
            // data frame, not an SSE comment: the client parser discards
            // comment frames before they reach the app, so a `: heartbeat`
            // never refreshes stream liveness and an idle-but-healthy
            // connection expires. It carries no id, so it does not advance
            // Last-Event-ID. Merging rather than concatenating keeps liveness
            // flowing during long streams instead of only after they end.
            const heartbeat: Stream.Stream<SequencedWireEvent> = Stream.tick("10 seconds").pipe(
              Stream.map((): SequencedWireEvent => ({
                event: { id: EventV2.ID.create(), type: "server.heartbeat", data: {} },
              })),
            )
            return Stream.make(connected).pipe(Stream.concat(Stream.merge(live, heartbeat, { haltStrategy: "left" })))
          }),
        ).pipe(
          Stream.map(({ sequence, event }) => eventData(event, sequence === undefined ? undefined : `${replay.epoch}:${sequence}`)),
          Stream.pipeThroughChannel(Sse.encode()),
        )
        return HttpServerResponse.stream(
          output.pipe(Stream.encodeText),
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
