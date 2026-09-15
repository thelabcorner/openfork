import { EventV2 } from "@opencode-ai/core/event"
import { EventReplayBuffer, estimateEventBytes, parseEventSequence } from "@opencode-ai/core/event-replay"
import {
  coalesceEventBatch,
  createEventDeltaAccumulator,
  createEventCoalescer,
  eventDeltaKey,
  mergeEventDeltas,
} from "@opencode-ai/core/event-coalescer"
import { Effect, Stream } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { Api } from "../api"
import { serializeEvent, wireEvent, type WireEvent } from "../event-serializer"
import { EventTrace } from "@opencode-ai/core/event-trace"
import {
  STREAM_PROGRESS_EVENT,
  STREAM_SESSION_STALE_EVENT,
  isSessionStreamContentEvent,
  sessionStreamContentSessionID,
} from "@opencode-ai/core/session-stream-content"
import {
  eventStreamAllowsSession,
  eventStreamInterestFromHeaders,
  markEventStreamSessionSuppressed,
  registerEventStreamInterest,
  unregisterEventStreamInterest,
  type EventStreamInterest,
} from "../event-interest"

export const ringCapacity = 4096
// Replay is emitted as a pull-driven stream prefix and never occupies this
// queue. Keep the historical item headroom for live bursts; it is deliberately
// no longer coupled to the replay frame count.
export const subscriberCapacity = ringCapacity + 256
export const ringMaxBytes = 8 * 1024 * 1024
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
const subscriberEnvelopeBytes = 48
// Queue accounting adds a small sequence/wrapper charge around an event whose
// payload was already admitted to the 8 MiB replay ring. Keep that legal frame
// limit independent from the ordinary live-backlog budget below.
export const subscriberFrameMaxBytes = ringMaxBytes + subscriberEnvelopeBytes

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

type SequencedWireEvent = { sequence?: number; event: WireEvent; bytes?: number }
type SequencedEvent = { sequence: number; event: EventV2.Payload }

const streamStaleEvent = (sessionID: string): WireEvent => ({
  id: EventV2.ID.create(),
  type: STREAM_SESSION_STALE_EVENT,
  data: { sessionID },
})

const streamProgressEvent = (sequence: number): SequencedWireEvent => ({
  sequence,
  event: { id: EventV2.ID.create(), type: STREAM_PROGRESS_EVENT, data: { latest: sequence } },
})

function suppressedSession(state: EventStreamInterest | undefined, event: EventV2.Payload) {
  if (!state || !isSessionStreamContentEvent(event.type)) return
  const sessionID = sessionStreamContentSessionID(event)
  if (!sessionID || eventStreamAllowsSession(state, sessionID)) return
  return sessionID
}

function sequencedDeltaOptions() {
  const deltas = createEventDeltaAccumulator<EventV2.Payload>()
  return {
    keyOf: (item: SequencedEvent) => eventDeltaKey(item.event),
    orderBy: (item: SequencedEvent) => item.sequence,
    merge: (previous: SequencedEvent, next: SequencedEvent) => {
      const event = mergeEventDeltas(previous.event, next.event)
      return event === undefined ? undefined : { sequence: next.sequence, event }
    },
    accumulator: {
      create: (item: SequencedEvent) => deltas.create(item.event),
      push: (state: object, item: SequencedEvent) => deltas.push(state, item.event),
      finalize: (state: object, item: SequencedEvent): SequencedEvent => ({
        ...item,
        event: deltas.finalize(state, item.event),
      }),
    },
  }
}

const sequencedWireBytes = (item: SequencedWireEvent) =>
  // `bytes` is measured on the original EventV2 payload. That payload was
  // already measured when it entered the replay ring, so ordinary live events
  // hit estimateEventBytes' WeakMap in O(1). Carrying the value across the wire
  // projection avoids rescanning a multi-megabyte `data` object independently
  // for every connected SSE subscriber. Control frames fall back to a tiny
  // direct estimate. The fixed wrapper charge keeps accounting conservative.
  subscriberEnvelopeBytes + (item.bytes ?? estimateEventBytes(item.event))

function eventData(data: object, sequence?: string): Sse.Event {
  const tracing = EventTrace.active()
  const started = tracing ? performance.now() : 0
  const frame = serializeEvent(data)
  if (tracing) {
    EventTrace.timing("native.serializeMs", performance.now() - started)
    EventTrace.sum("native.serializeBytes", frame.length)
  }
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
        const initialInterest = eventStreamInterestFromHeaders(request.headers)
        const output = Stream.unwrap(
          Effect.gen(function* () {
            const interest = registerEventStreamInterest(initialInterest?.subscriber, initialInterest?.sessions)
            yield* Effect.addFinalizer(() => Effect.sync(() => unregisterEventStreamInterest(interest)))
            const subscriber = yield* EventV2.makeByteBoundedSubscriberQueue<SequencedWireEvent>({
              capacity: subscriberCapacity,
              maxBytes: ringMaxBytes,
              maxSingleFrameBytes: subscriberFrameMaxBytes,
              sizeOf: sequencedWireBytes,
              typeOf: (item) => item.event.type,
            })
            let pendingProgress: number | undefined
            let progressTimer: ReturnType<typeof setTimeout> | undefined
            let closed = false
            const flushProgress = () => {
              const sequence = pendingProgress
              if (sequence === undefined || closed) return
              pendingProgress = undefined
              const accepted = subscriber.offer(streamProgressEvent(sequence))
              EventTrace.count(accepted ? "native.interestProgressOffered" : "native.interestProgressFailed")
            }
            const scheduleProgress = () => {
              if (progressTimer !== undefined || closed) return
              // Cursor progress is transport bookkeeping, not UI state. A short
              // coalescing window turns hundreds of hidden token fragments into
              // at most ~10 tiny cursor frames/sec while keeping reconnect cursors
              // well inside the bounded replay ring.
              progressTimer = setTimeout(() => {
                progressTimer = undefined
                flushProgress()
              }, 100)
            }
            const recordSuppressed = (sessionID: string, sequence: number) => {
              pendingProgress = pendingProgress === undefined ? sequence : Math.max(pendingProgress, sequence)
              EventTrace.count("native.interestSuppressed")
              if (markEventStreamSessionSuppressed(interest, sessionID)) {
                const accepted = subscriber.offer({ event: streamStaleEvent(sessionID) })
                EventTrace.count(accepted ? "native.interestStaleOffered" : "native.interestStaleFailed")
              }
              scheduleProgress()
            }
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                closed = true
                if (progressTimer !== undefined) clearTimeout(progressTimer)
                progressTimer = undefined
              }),
            )
            const coalescer = createEventCoalescer<SequencedEvent>(
              (item) => {
                const sessionID = suppressedSession(interest, item.event)
                if (sessionID) {
                  // Interest may change while this item waits in the coalescer.
                  // Re-check at the last responsible moment before projection.
                  recordSuppressed(sessionID, item.sequence)
                  return
                }
                // A cursor acknowledgement for skipped content must precede the
                // next real domain sequence on the wire.
                flushProgress()
                const accepted = subscriber.offer({
                  sequence: item.sequence,
                  event: wireEvent(item.event),
                  bytes: estimateEventBytes(item.event),
                })
                EventTrace.count(accepted ? "native.subscriberOffered" : "native.subscriberFailed")
              },
              sequencedDeltaOptions(),
            )
            const offerCoalescer = (item: SequencedEvent) => {
              const sessionID = suppressedSession(interest, item.event)
              if (sessionID) {
                // Flush any older admitted event before recording a newer
                // suppressed sequence, otherwise a progress cursor could overtake
                // an event still buffered inside the coalescer.
                coalescer.flush()
                recordSuppressed(sessionID, item.sequence)
                return
              }
              flushProgress()
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
            let replayPrefix: SequencedWireEvent[]
            if (replayResult.kind === "gap" || replayResult.frames.length > MAX_REPLAY_FRAMES ||
              replayBytes > MAX_REPLAY_BYTES) {
              if (replayResult.kind === "gap") EventTrace.count("native.gap")
              replayPrefix = [{
                event: {
                  id: EventV2.ID.create(),
                  type: "server.stream.gap",
                  data: {
                    requested: replayResult.kind === "gap" ? replayResult.requested : cursor ?? 0,
                    oldest: replayResult.kind === "gap" ? replayResult.oldest : undefined,
                    latest: replayResult.latest,
                  },
                },
              }]
            } else {
              replayPrefix = []
              let segment: SequencedEvent[] = []
              let replayProgress: number | undefined
              const flushSegment = () => {
                if (segment.length === 0) return
                replayPrefix.push(
                  ...coalesceEventBatch<SequencedEvent>(segment, sequencedDeltaOptions()).map((item) => ({
                    sequence: item.sequence,
                    event: wireEvent(item.event),
                    bytes: estimateEventBytes(item.event),
                  })),
                )
                segment = []
              }
              const flushReplayProgress = () => {
                if (replayProgress === undefined) return
                replayPrefix.push(streamProgressEvent(replayProgress))
                replayProgress = undefined
              }
              for (const frame of replayResult.frames) {
                const item = { sequence: frame.sequence, event: frame.event }
                const sessionID = suppressedSession(interest, item.event)
                if (!sessionID) {
                  flushReplayProgress()
                  segment.push(item)
                  continue
                }
                flushSegment()
                EventTrace.count("native.interestReplaySuppressed")
                if (markEventStreamSessionSuppressed(interest, sessionID)) {
                  replayPrefix.push({ event: streamStaleEvent(sessionID) })
                }
                replayProgress = item.sequence
              }
              flushSegment()
              flushReplayProgress()
            }
            // The replay prefix is not offered to `subscriber`: doing so used to
            // consume almost the full 8 MiB live byte budget before the response
            // body could drain a single frame. A legal ~7.8 MiB live event then
            // collided with a few hundred KiB of replay backlog and killed the
            // whole SSE stream. Only genuinely live backlog is bounded below.
            for (const item of pendingLive) {
              if (item.sequence > replayResult.latest) offerCoalescer(item)
            }
            replaying = false
            coalescer.flush()
            flushProgress()
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
            const domain = Stream.fromIterable(replayPrefix).pipe(Stream.concat(live))
            return Stream.make(connected).pipe(Stream.concat(Stream.merge(domain, heartbeat, { haltStrategy: "left" })))
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
