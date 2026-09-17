import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { GlobalBus } from "@/bus/global"
import { estimateEventBytes, parseEventSequence } from "@opencode-ai/core/event-replay"
import { EventV2 } from "@opencode-ai/core/event"
import {
  coalesceEventBatch,
  createEventDeltaAccumulator,
  createEventCoalescer,
  eventDeltaKey,
  mergeEventDeltas,
} from "@opencode-ai/core/event-coalescer"
import { EventTrace } from "@opencode-ai/core/event-trace"
import { Effect } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { EventApi } from "../groups/event"

import { adaptLegacyEvent, serializeLegacyEvent } from "@/server/event-serialization"

type LegacyEvent = { id: string; type: string; properties: unknown }
// `sequence` is optional because control frames (heartbeat, gap, disposal) are
// not replayable domain state: they must not mint or reuse a Last-Event-ID
// cursor. Only frames carrying a sequence get an `id:` on the wire.
type SequencedLegacyEvent = { sequence?: number; event: LegacyEvent; bytes?: number }
type SequencedEvent = { sequence: number; event: EventV2.Payload }

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

const sequencedLegacyBytes = (item: SequencedLegacyEvent) =>
  48 + (item.bytes ?? estimateEventBytes(item.event))

// The bridge's replay ring already bounds retention by count (4096) and by
// bytes (8 MiB). A much lower frame ceiling here made most of the retained
// window unusable and forced a full snapshot hydration on any reconnect longer
// than a fraction of a second. Match the ring so the replayable window is the
// window that actually exists; the byte ceiling below is the guard that
// protects the client from payload size.
// Exported so tests can assert replay policy directly against the bridge ring.
export const MAX_REPLAY_FRAMES = EventV2Bridge.REPLAY_CAPACITY
export const MAX_REPLAY_BYTES = EventV2Bridge.REPLAY_MAX_BYTES
// Replay is emitted directly as a pull-driven stream prefix, so this queue is
// now strictly a live-backlog bound. Retain the existing item headroom rather
// than coupling correctness to how many replay frames happen to be retained.
export const SUBSCRIBER_HEADROOM = 256
export const SUBSCRIBER_CAPACITY = MAX_REPLAY_FRAMES + SUBSCRIBER_HEADROOM
const SUBSCRIBER_ENVELOPE_BYTES = 48
export const SUBSCRIBER_FRAME_MAX_BYTES = MAX_REPLAY_BYTES + SUBSCRIBER_ENVELOPE_BYTES

function eventData(data: object, sequence?: string): Sse.Event {
  const tracing = EventTrace.active()
  const started = tracing ? performance.now() : 0
  const frame = serializeLegacyEvent(data)
  if (tracing) {
    EventTrace.timing("legacy.serializeMs", performance.now() - started)
    EventTrace.sum("legacy.serializeBytes", frame.length)
  }
  return {
    _tag: "Event",
    event: "message",
    id: sequence === undefined ? undefined : String(sequence),
    data: frame,
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
    const lastEventID = request.headers["last-event-id"]
    // Request-derived context must be read here, not inside the stream: the
    // body stream runs after this effect returns and no longer has access to
    // per-request services.

    // Every resource below is created inside `Stream.unwrap`, so its lifetime
    // is bound to the response body stream instead of the request scope. The
    // subscription must survive until the body completes, not merely until the
    // response value is handed back to the server.
    const output = Stream.unwrap(
      Effect.gen(function* () {
        // Activate compatibility replay capture before installing the live
        // listener. `after` is the exact connect boundary, so a fresh client
        // replays events that race into this setup window without receiving
        // arbitrary history from before it connected.
        const replayConnection = events.replayConnect()
        yield* Effect.addFinalizer(() => Effect.sync(replayConnection.release))
        const cursor = parseEventSequence(lastEventID, replayConnection.epoch)
        const replayAfter = cursor === undefined ? replayConnection.after : cursor
        const subscriber = yield* EventV2.makeByteBoundedSubscriberQueue<SequencedLegacyEvent>({
          capacity: SUBSCRIBER_CAPACITY,
          maxBytes: EventV2Bridge.REPLAY_MAX_BYTES,
          maxSingleFrameBytes: SUBSCRIBER_FRAME_MAX_BYTES,
          sizeOf: sequencedLegacyBytes,
          typeOf: (item) => item.event.type,
        })
        const coalescer = createEventCoalescer<SequencedEvent>(
          (item) => {
            const accepted = subscriber.offer({
              sequence: item.sequence,
              event: adaptLegacyEvent(item.event),
              bytes: estimateEventBytes(item.event),
            })
            EventTrace.count(accepted ? "legacy.subscriberOffered" : "legacy.subscriberFailed")
          },
          sequencedDeltaOptions(),
        )
        const offerCoalescer = (item: SequencedEvent) => {
          EventTrace.count("legacy.coalescerIn")
          coalescer.offer(item)
        }
        const matches = (event: EventV2.Payload) =>
          event.location?.directory === instance.directory &&
          (event.location.workspaceID === undefined || event.location.workspaceID === workspaceID)
        let replaying = true
        const pendingLive: SequencedEvent[] = []
        // Subscribe before the replay snapshot so the replay/live handoff cannot
        // lose an event. During this short synchronous setup window, new live
        // events are held separately and only the post-cutoff suffix is admitted
        // to the live queue.
        // This transport is scoped to one instance directory. Registering it
        // on the process-global fanout made every token in every other project
        // invoke this callback only to fail matches(), and each loopback SSE
        // connection inflated the global EventV2 listener count. Route by
        // directory first; retain the workspace check below for exactness.
        const unsubscribe = yield* events.listenDirectoryAll(instance.directory, (event) =>
          Effect.sync(() => {
            if (!matches(event)) return
            const sequence = events.sequenceOf(event)
            if (sequence === undefined) return
            const item = { sequence, event }
            if (replaying) pendingLive.push(item)
            else offerCoalescer(item)
          }),
        )
        yield* Effect.addFinalizer(() => unsubscribe)
        yield* Effect.addFinalizer(() => Effect.sync(coalescer.dispose))
        const replay = events.replaySince(replayAfter, matches)
        const replayCutoff = replay.latest
        EventTrace.event({
          phase: "sse.reconnect",
          route: "legacy",
          fresh: cursor === undefined,
          kind: replay.kind,
          frames: replay.kind === "gap" ? 0 : replay.frames.length,
          bytes: replay.kind === "gap" ? 0 : replay.bytes,
        })
        if (replay.kind === "gap") EventTrace.count("legacy.gap")
        // `replay.bytes` is the sum of the sizes the ring already recorded at
        // append time, counted over exactly the frames returned after the
        // `matches` filter. It costs no traversal, no per-frame wrapper
        // allocation and no re-estimate — shared with the native route rather
        // than open-coded here.
        let replayPrefix: SequencedLegacyEvent[]
        if (replay.kind === "gap" || replay.frames.length > MAX_REPLAY_FRAMES ||
          replay.bytes > MAX_REPLAY_BYTES) {
          // A reconnect that fell behind the bounded window cannot be repaired by
          // silently dropping old events. Emit a control event so the client can
          // hydrate a snapshot, while keeping the stream itself healthy.
          replayPrefix = [{
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
          }]
        } else {
          replayPrefix = coalesceEventBatch<SequencedEvent>(
            replay.frames.map((frame) => ({ sequence: frame.sequence, event: frame.event })),
            sequencedDeltaOptions(),
          ).map((item) => ({
            sequence: item.sequence,
            event: adaptLegacyEvent(item.event),
            bytes: estimateEventBytes(item.event),
          }))
        }
        // Never preload replay into `subscriber`. Historically a legal live
        // frame near the 8 MiB ring limit could arrive while replay occupied a
        // few hundred KiB of this same byte budget and fail the entire stream.
        // Replay is immutable history and can be pulled directly by the body;
        // only genuinely live backlog belongs in the fail-fast subscriber queue.
        for (const item of pendingLive) {
          if (item.sequence > replayCutoff) offerCoalescer(item)
        }
        replaying = false
        coalescer.flush()
        const disposed = (event: { directory?: string; payload: { id?: string; type?: string; properties?: unknown } }) => {
          if (event.directory !== instance.directory || event.payload.type !== "server.instance.disposed") return
          coalescer.flush()
          // Deliberately sequence-free. `events.replayLatest()` returns the last
          // sequence already assigned to a real event, so using it here emitted a
          // duplicate, non-monotonic SSE id on the frame that ends the stream.
          // Disposal is terminal and not replayable, so it needs no cursor.
          subscriber.offer({
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
        const live = subscriber.stream.pipe(Stream.takeUntil((item) => item.event.type === "server.instance.disposed"))
        // A real `server.heartbeat` frame, never an SSE comment: the SDK parser
        // treats `: heartbeat` as an unknown field, so it produces a frame with
        // `hasData: false` that the generated client does not yield — a comment
        // therefore never refreshes the app's stream liveness. Emitting no id
        // keeps heartbeats from advancing Last-Event-ID.
        const heartbeat = Stream.tick("10 seconds").pipe(
          Stream.drop(1),
          Stream.map(() => eventData({ id: eventID(), type: "server.heartbeat", properties: {} })),
        )

        const replayStream = Stream.fromIterable(replayPrefix).pipe(
          Stream.map(({ sequence, event }) =>
            eventData(event, sequence === undefined ? undefined : `${replayConnection.epoch}:${sequence}`),
          ),
        )
        const liveStream = live.pipe(
          Stream.map(({ sequence, event }) =>
            eventData(event, sequence === undefined ? undefined : `${replayConnection.epoch}:${sequence}`),
          ),
        )
        const domain = replayStream.pipe(Stream.concat(liveStream))

        return Stream.make(
          eventData(
            { id: eventID(), type: "server.connected", properties: { epoch: replayConnection.epoch } },
            cursor === undefined ? `${replayConnection.epoch}:${replayConnection.after}` : undefined,
          ),
        ).pipe(
          Stream.concat(domain.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
        )
      }),
    )

    yield* Effect.logInfo("event connected")
    return HttpServerResponse.stream(
      output.pipe(
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
