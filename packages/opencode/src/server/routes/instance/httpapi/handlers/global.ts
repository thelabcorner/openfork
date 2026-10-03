import { Config } from "@/config/config"
import { GlobalBus, type GlobalEvent as GlobalBusEvent } from "@/bus/global"
import { registerLegacyTransport } from "@/event-v2-bridge"
import { EffectBridge } from "@/effect/bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { PRODUCT_RELEASES_URL } from "@opencode-ai/core/brand"
import { EventReplayBuffer, estimateEventBytes, parseEventSequence } from "@opencode-ai/core/event-replay"
import {
  coalesceEventBatch,
  createEventCoalescer,
  eventDeltaKey,
  mergeEventDeltas,
} from "@opencode-ai/core/event-coalescer"
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
  updateEventStreamInterest,
  eventStreamInterestGeneration,
  type EventStreamInterest,
} from "@opencode-ai/server/event-interest"
import { Installation } from "@/installation"
import { disposeAllInstancesAndEmitGlobalDisposed, emitGlobalDisposed } from "@/server/global-lifecycle"
import { InstanceStore } from "@/project/instance-store"
import { resetLocalData } from "@/storage/reset-local-data"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm"
import { Effect } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { ModelPreferences } from "@/preference/model-preferences"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { NotFoundError } from "@/storage/storage"
import { SessionTelemetry } from "@opencode-ai/core/session/telemetry"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import { SessionStatus } from "@/session/status"
import { OxpActivity } from "@opencode-ai/core/oxp-activity/activity"
import { OxpActivityInspection } from "@opencode-ai/core/oxp-activity/inspection"
import { OxpAttribution } from "@opencode-ai/core/oxp-attribution/attribution"
import { Project } from "@/project/project"
import { bumpUsageCache } from "@/fork/usage-cache"
import { resetUsageSummaryCache } from "@/usage/usage"
import { serializeLegacyEvent } from "@/server/event-serialization"
import { isT3CodeCompatibilityProfile, localClientReportedVersion } from "@/compat/t3code"
import { RootHttpApi } from "../api"
import {
  GlobalArchivedSessionRootsInput,
  GlobalSessionRootsQuery,
  GlobalSessionMetadataInput,
  GlobalSessionStatusQuery,
  GlobalSessionTelemetryInput,
  GlobalOxpActivityListQuery,
  GlobalOxpActivityPatch,
  GlobalOxpAttributionQuery,
  GlobalOxpInvocationQuery,
  GlobalOxpResourceQuery,
  GlobalUpgradeInput,
  ModelPreferencesPatch,
} from "../groups/global"
import { SemanticCompactionFeature } from "../groups/sync"

function projectOxpActivity(row: OxpActivityInspection.ParentSummary) {
  return {
    id: row.id,
    ...(row.title ? { title: row.title } : {}),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    callCount: row.call_count,
    failureCount: row.failure_count,
    augmentationCalls: row.augmentation_calls,
    supervisionCalls: row.supervision_calls,
    delegationCalls: row.delegation_calls,
    observedEpochCount: row.observed_epoch_count,
    ...(row.last_tool ? { lastTool: row.last_tool } : {}),
    ...(row.last_root_alias ? { lastRootAlias: row.last_root_alias } : {}),
    ...(row.time_archived === null || row.time_archived === undefined ? {} : { archivedAt: row.time_archived }),
  }
}

function projectOxpInvocation(
  row: OxpActivityInspection.Invocation,
  links: readonly OxpActivityInspection.InvocationLink[],
) {
  return {
    id: row.id,
    activityID: row.activity_id,
    hostRunID: row.host_run_id,
    ...(row.observed_epoch === null || row.observed_epoch === undefined ? {} : { observedEpoch: row.observed_epoch }),
    plane: row.plane,
    tool: row.tool,
    ...(row.action ? { action: row.action } : {}),
    ...(row.root_id ? { rootID: row.root_id } : {}),
    ...(row.root_alias ? { rootAlias: row.root_alias } : {}),
    status: row.status,
    ...(row.safe_summary?.continuityMarker === "handoff_advisory"
      ? { continuityMarker: "handoff_advisory" as const }
      : {}),
    ...(row.safe_summary ? { safeSummary: row.safe_summary } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    mutationAttempted: row.mutation_attempted,
    mutationCommitted: row.mutation_committed,
    startedAt: row.time_started,
    ...(row.time_completed === null || row.time_completed === undefined ? {} : { completedAt: row.time_completed }),
    links: links.map((link) => ({
      kind: link.kind,
      ref: link.ref,
      relation: link.relation,
      ...(link.label ? { label: link.label } : {}),
    })),
  }
}

// `sequence` is optional because control frames (heartbeat, gap) are not
// replayable domain state: they must not mint or reuse a Last-Event-ID cursor.
// Only frames carrying a sequence get an `id:` on the wire.
type SequencedGlobalEvent = { sequence?: number; event: GlobalBusEvent }

const streamStaleGlobalEvent = (sessionID: string): SequencedGlobalEvent => ({
  event: {
    directory: "global",
    payload: { id: EventV2.ID.create(), type: STREAM_SESSION_STALE_EVENT, properties: { sessionID } },
  },
})

const streamProgressGlobalEvent = (sequence: number): SequencedGlobalEvent => ({
  sequence,
  event: {
    directory: "global",
    payload: { id: EventV2.ID.create(), type: STREAM_PROGRESS_EVENT, properties: { latest: sequence } },
  },
})

function suppressedGlobalSession(state: EventStreamInterest | undefined, event: GlobalBusEvent) {
  const type = event.payload?.type
  if (!state || typeof type !== "string" || !isSessionStreamContentEvent(type)) return
  const sessionID = sessionStreamContentSessionID({ type, properties: event.payload.properties })
  if (!sessionID || eventStreamAllowsSession(state, sessionID)) return
  return sessionID
}

// The desktop interest protocol is also a capability signal. Interest-aware
// renderers consume the ordinary compatibility event and explicitly discard the
// parallel durable `sync` envelope. Keep `sync` for legacy/control-plane/CLI
// subscribers that do not advertise interest support, but do not serialize and
// transmit it to a desktop that can never consume it.
function suppressGlobalSync(state: EventStreamInterest | undefined, event: GlobalBusEvent) {
  return state?.sessions !== undefined && event.payload?.type === "sync"
}

// Exported so tests can assert replay policy against the real ring constants.
export const RING_CAPACITY = 4096
export const RING_MAX_BYTES = 8 * 1024 * 1024
// A replay is only refused when it is genuinely too expensive to resend. The
// ring already bounds retention by count (RING_CAPACITY) and by bytes (8 MiB),
// so a second 128-frame ceiling made ~97% of the retained window unusable and
// forced a full hydration on any reconnect longer than a fraction of a second
// of streaming. Reuse the ring's own capacity and trust its byte budget — this
// matches the native route (packages/server/src/handlers/event.ts).
export const MAX_REPLAY_FRAMES = RING_CAPACITY
export const MAX_REPLAY_BYTES = RING_MAX_BYTES
// Conservative LIVE-event item headroom. Replay bypasses the subscriber queue.
export const SUBSCRIBER_HEADROOM = 256
const SUBSCRIBER_ENVELOPE_BYTES = 48
export const SUBSCRIBER_FRAME_MAX_BYTES = RING_MAX_BYTES + SUBSCRIBER_ENVELOPE_BYTES

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
      maxBytes: RING_MAX_BYTES,
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
  private listeners = 0
  // Once a sync-capable subscriber participates in one replay generation, keep
  // generating sync until the whole generation retires. Otherwise an old client
  // could disconnect briefly while an interest-aware desktop keeps the epoch
  // alive, then reconnect with a cursor whose missing interval never contained
  // the sync envelopes it expects.
  private syncRequiredForGeneration = false
  private generation = newReplayGeneration()

  get active() {
    return this.subscribers > 0
  }

  get listenerCount() {
    return this.listeners
  }

  get syncRequired() {
    return this.syncRequiredForGeneration
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
      this.syncRequiredForGeneration = false
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

  /**
   * Track the actual GlobalBus listener owned by a response body. This is
   * intentionally separate from `subscribers`: the response scope can be alive
   * before its stream listener is installed, and subtracting subscriber count
   * from GlobalBus.listenerCount would then hide unrelated direct consumers.
   */
  listenerConnected(needsSync: boolean) {
    this.listeners += 1
    if (needsSync) this.syncRequiredForGeneration = true
    let released = false
    return () => {
      if (released) return
      released = true
      this.listeners = Math.max(0, this.listeners - 1)
    }
  }
}

function eventData(data: object, sequence?: string): Sse.Event {
  const tracing = EventTrace.active()
  const started = tracing ? performance.now() : 0
  const frame = serializeLegacyEvent(data)
  if (tracing) {
    EventTrace.timing("global.serializeMs", performance.now() - started)
    EventTrace.sum("global.serializeBytes", frame.length)
  }
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
    const initialInterest = eventStreamInterestFromHeaders(request.headers)
    // Opening a connected range must happen BEFORE the replay read below so
    // capture is live for the whole window this client's cursor covers.
    const { generation, release } = gate.connect()
    yield* Effect.addFinalizer(() => Effect.sync(release))
    const replay = generation.replay
    const sequences = generation.sequences
    yield* Effect.logInfo("global event connected", { subscriber: initialInterest?.subscriber })
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
        const interest = registerEventStreamInterest(
          initialInterest?.subscriber,
          initialInterest?.sessions,
          initialInterest?.generation,
        )
        yield* Effect.addFinalizer(() => Effect.sync(() => unregisterEventStreamInterest(interest)))
        const subscriber = yield* EventV2.makeByteBoundedSubscriberQueue<SequencedGlobalEvent>({
          // Replay bypasses this queue and is pulled directly by the response
          // stream. This capacity is therefore a live-backlog bound only. Keep
          // the existing count conservatively large while byte accounting is
          // the primary memory guard.
          capacity: MAX_REPLAY_FRAMES + SUBSCRIBER_HEADROOM,
          maxBytes: RING_MAX_BYTES,
          maxSingleFrameBytes: SUBSCRIBER_FRAME_MAX_BYTES,
          // The replay ring measures the GlobalBus envelope itself before the
          // subscriber listener sees it. For normal live events this is an O(1)
          // WeakMap hit instead of recursively rescanning a jumbo payload through
          // the fresh `{ sequence, event }` wrapper once per subscriber.
          sizeOf: (item) => SUBSCRIBER_ENVELOPE_BYTES + estimateEventBytes(item.event),
          typeOf: (item) => (typeof item.event.payload?.type === "string" ? item.event.payload.type : "unknown"),
        })
        let pendingProgress: number | undefined
        let progressTimer: ReturnType<typeof setTimeout> | undefined
        let closed = false
        const flushProgress = () => {
          const sequence = pendingProgress
          if (sequence === undefined || closed) return
          pendingProgress = undefined
          const accepted = subscriber.offer(streamProgressGlobalEvent(sequence))
          EventTrace.count(accepted ? "global.interestProgressOffered" : "global.interestProgressFailed")
        }
        const scheduleProgress = () => {
          if (progressTimer !== undefined || closed) return
          progressTimer = setTimeout(() => {
            progressTimer = undefined
            flushProgress()
          }, 100)
        }
        const recordProgress = (sequence: number) => {
          pendingProgress = pendingProgress === undefined ? sequence : Math.max(pendingProgress, sequence)
          scheduleProgress()
        }
        const recordSuppressed = (sessionID: string, sequence: number) => {
          recordProgress(sequence)
          EventTrace.count("global.interestSuppressed")
          if (markEventStreamSessionSuppressed(interest, sessionID)) {
            const accepted = subscriber.offer(streamStaleGlobalEvent(sessionID))
            EventTrace.count(accepted ? "global.interestStaleOffered" : "global.interestStaleFailed")
          }
        }
        const recordSyncSuppressed = (sequence: number) => {
          recordProgress(sequence)
          EventTrace.count("global.interestSyncSuppressed")
        }
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            closed = true
            if (progressTimer !== undefined) clearTimeout(progressTimer)
            progressTimer = undefined
          }),
        )
        const coalescer = createEventCoalescer<SequencedGlobalEvent>(
          (item) => {
            if (suppressGlobalSync(interest, item.event) && item.sequence !== undefined) {
              recordSyncSuppressed(item.sequence)
              return
            }
            const sessionID = suppressedGlobalSession(interest, item.event)
            if (sessionID && item.sequence !== undefined) {
              recordSuppressed(sessionID, item.sequence)
              return
            }
            flushProgress()
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
          if (suppressGlobalSync(interest, item.event) && item.sequence !== undefined) {
            coalescer.flush()
            recordSyncSuppressed(item.sequence)
            return
          }
          const sessionID = suppressedGlobalSession(interest, item.event)
          if (sessionID && item.sequence !== undefined) {
            coalescer.flush()
            recordSuppressed(sessionID, item.sequence)
            return
          }
          flushProgress()
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
          Effect.sync(() => {
            // Header absence means an older/pass-through subscriber. It consumes
            // durable `sync` frames and therefore permanently marks this replay
            // generation sync-complete for reconnect safety.
            const releaseListener = gate.listenerConnected(initialInterest?.sessions === undefined)
            GlobalBus.on("event", listener)
            return releaseListener
          }),
          (releaseListener) =>
            Effect.sync(() => {
              GlobalBus.off("event", listener)
              releaseListener()
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
        let replayPrefix: SequencedGlobalEvent[]
        if (
          replayResult.kind === "gap" ||
          replayResult.frames.length > MAX_REPLAY_FRAMES ||
          replayResult.bytes > MAX_REPLAY_BYTES
        ) {
          // Deliberately sequence-free. `replayResult.latest` is the last
          // sequence already assigned to a real event, so using it here emitted a
          // duplicate, non-monotonic SSE id. A gap is a repair signal, not
          // replayable domain state, so it needs no cursor.
          replayPrefix = [
            {
              event: {
                directory: "global",
                payload: {
                  id: EventV2.ID.create(),
                  type: "server.stream.gap",
                  properties: {
                    requested: replayResult.kind === "gap" ? replayResult.requested : (cursor ?? 0),
                    oldest: replayResult.kind === "gap" ? replayResult.oldest : undefined,
                    latest: replayResult.latest,
                  },
                },
              },
            },
          ]
        } else {
          replayPrefix = []
          let segment: SequencedGlobalEvent[] = []
          let replayProgress: number | undefined
          const coalesceSegment = () => {
            if (segment.length === 0) return
            replayPrefix.push(
              ...coalesceEventBatch<SequencedGlobalEvent>(segment, {
                keyOf: (item) => eventDeltaKey(item.event.payload),
                orderBy: (item) => item.sequence ?? 0,
                merge: (previous, next) => {
                  const payload = mergeEventDeltas(previous.event.payload, next.event.payload)
                  return payload ? { sequence: next.sequence, event: { ...next.event, payload } } : undefined
                },
              }),
            )
            segment = []
          }
          const flushReplayProgress = () => {
            if (replayProgress === undefined) return
            replayPrefix.push(streamProgressGlobalEvent(replayProgress))
            replayProgress = undefined
          }
          for (const frame of replayResult.frames) {
            const item: SequencedGlobalEvent = { sequence: frame.sequence, event: frame.event }
            if (suppressGlobalSync(interest, item.event)) {
              coalesceSegment()
              EventTrace.count("global.interestReplaySyncSuppressed")
              replayProgress = item.sequence
              continue
            }
            const sessionID = suppressedGlobalSession(interest, item.event)
            if (!sessionID) {
              flushReplayProgress()
              segment.push(item)
              continue
            }
            coalesceSegment()
            EventTrace.count("global.interestReplaySuppressed")
            if (markEventStreamSessionSuppressed(interest, sessionID))
              replayPrefix.push(streamStaleGlobalEvent(sessionID))
            replayProgress = item.sequence
          }
          coalesceSegment()
          flushReplayProgress()
        }
        // Replay is historical state and is streamed directly below. Keeping it
        // out of the live subscriber queue removes the reconnect failure mode
        // where replay consumed most of the 8 MiB byte budget before the body
        // could drain and a legal large live frame tipped the queue over.
        for (const item of pendingLive) {
          if ((item.sequence ?? 0) > replayLatest) offerCoalescer(item)
        }
        replaying = false
        coalescer.flush()
        flushProgress()

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
          Stream.map(() =>
            eventData({ payload: { id: EventV2.ID.create(), type: "server.heartbeat", properties: {} } }),
          ),
        )

        const replayEvents = Stream.fromIterable(replayPrefix).pipe(
          Stream.map(({ event, sequence }) =>
            eventData(event, sequence === undefined ? undefined : `${replay.epoch}:${sequence}`),
          ),
        )
        const domain = replayEvents.pipe(Stream.concat(events))

        return Stream.make(
          eventData(
            { payload: { id: EventV2.ID.create(), type: "server.connected", properties: { epoch: replay.epoch } } },
            cursor === undefined ? `${replay.epoch}:${replayLatest}` : undefined,
          ),
        ).pipe(Stream.concat(domain.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))))
      }),
    )

    return HttpServerResponse.stream(
      output.pipe(
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
        Stream.ensuring(Effect.logInfo("global event disconnected", { subscriber: initialInterest?.subscriber })),
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
    const gate = new GlobalReplayGate()
    const oxpActivity = yield* OxpActivity.Service
    const oxpInspection = yield* OxpActivityInspection.Service
    const oxpAttribution = yield* OxpAttribution.Service
    // Resolve Tier-0 status dependencies when constructing the served graph.
    // Request-time lookup hid a missing owner until the first project opened.
    const execution = yield* SessionExecutionOwner.Service
    const statuses = yield* SessionStatus.Service
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
    const unregisterTransport = registerLegacyTransport({
      isActive: () => gate.active,
      listenerCount: () => gate.listenerCount,
      needsSync: () => gate.syncRequired,
    })
    yield* Effect.addFinalizer(() => Effect.sync(unregisterTransport))

    const health = Effect.fn("GlobalHttpApi.health")(function* () {
      const version = localClientReportedVersion(InstallationVersion)
      if (isT3CodeCompatibilityProfile()) {
        return {
          healthy: true as const,
          version,
        }
      }
      const directory = FSUtil.resolve(process.cwd())
      return {
        healthy: true as const,
        version,
        path: {
          home: Global.Path.home,
          state: Global.Path.state,
          config: Global.Path.config,
          worktree: directory,
          directory,
        },
      }
    })

    const syncCapabilities = Effect.fn("SyncHttpApi.capabilities")(function* () {
      return { version: 1 as const, features: [SemanticCompactionFeature] }
    })

    const event = Effect.fn("GlobalHttpApi.event")(function* () {
      return yield* eventResponse(gate)
    })

    const eventInterest = Effect.fn("GlobalHttpApi.eventInterest")(function* (ctx: {
      payload: { readonly subscriber: string; readonly sessions: readonly string[]; readonly generation?: number }
    }) {
      const updated = updateEventStreamInterest(ctx.payload.subscriber, ctx.payload.sessions, ctx.payload.generation)
      const generation = eventStreamInterestGeneration(ctx.payload.subscriber)
      return { updated, ...(generation === undefined ? {} : { generation }) }
    })

    const sessionRoots = Effect.fn("GlobalHttpApi.sessionRoots")(function* (ctx: {
      query: typeof GlobalSessionRootsQuery.Type
    }) {
      const { readDb } = yield* Database.Service
      const rows = yield* readDb
        .select()
        .from(SessionTable)
        .where(
          and(
            ctx.query.projectID
              ? eq(SessionTable.project_id, ctx.query.projectID)
              : eq(SessionTable.directory, FSUtil.resolve(ctx.query.directory)),
            isNull(SessionTable.parent_id),
            isNull(SessionTable.time_archived),
            sql`json_extract(${SessionTable.metadata}, '$.workerDelegation.producer') IS NOT 'oxp' OR ${SessionTable.group_id} IS NULL`,
          ),
        )
        .orderBy(desc(SessionTable.time_updated), desc(SessionTable.id))
        .limit(ctx.query.limit ?? 50)
        .all()
        .pipe(Effect.orDie)
      return rows.map(Session.fromRow)
    })

    const sessionMetadata = Effect.fn("GlobalHttpApi.sessionMetadata")(function* (ctx: {
      payload: typeof GlobalSessionMetadataInput.Type
    }) {
      const sessions = [...new Set(ctx.payload.sessions)]
      if (sessions.length === 0) return []
      const { readDb } = yield* Database.Service
      const rows = yield* readDb
        .select()
        .from(SessionTable)
        .where(inArray(SessionTable.id, sessions))
        .all()
        .pipe(Effect.orDie)
      const byID = new Map(rows.map((row) => [row.id, row]))
      // Preserve caller order while omitting IDs deleted between status
      // snapshot and metadata resolution.
      return sessions.flatMap((sessionID) => {
        const row = byID.get(sessionID)
        return row ? [Session.fromRow(row)] : []
      })
    })

    const archivedSessionRoots = Effect.fn("GlobalHttpApi.archivedSessionRoots")(function* (ctx: {
      payload: typeof GlobalArchivedSessionRootsInput.Type
    }) {
      const { readDb } = yield* Database.Service
      const directories = [...new Set(ctx.payload.directories.map((directory) => FSUtil.resolve(directory)))]
      const limit = ctx.payload.limit ?? 50
      const cursor = ctx.payload.before
      const cursorCondition = cursor
        ? or(
            lt(SessionTable.time_archived, cursor.archivedAt),
            and(eq(SessionTable.time_archived, cursor.archivedAt), lt(SessionTable.id, cursor.id)),
          )
        : undefined
      const rows = yield* readDb
        .select()
        .from(SessionTable)
        .where(
          and(
            inArray(SessionTable.directory, directories),
            isNull(SessionTable.parent_id),
            sql`${SessionTable.time_archived} IS NOT NULL`,
            sql`json_extract(${SessionTable.metadata}, '$.workerDelegation.producer') IS NOT 'oxp' OR ${SessionTable.group_id} IS NULL`,
            cursorCondition,
          ),
        )
        .orderBy(desc(SessionTable.time_archived), desc(SessionTable.id))
        .limit(limit + 1)
        .all()
        .pipe(Effect.orDie)
      const more = rows.length > limit
      const page = more ? rows.slice(0, limit) : rows
      const last = page.at(-1)
      return {
        items: page.map(Session.fromRow),
        more,
        ...(more && last?.time_archived != null ? { before: { archivedAt: last.time_archived, id: last.id } } : {}),
      }
    })

    const sessionGet = Effect.fn("GlobalHttpApi.sessionGet")(function* (ctx: { params: { sessionID: SessionID } }) {
      const sessions = yield* Session.Service
      return yield* sessions
        .get(ctx.params.sessionID)
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(null)))
    })

    const sessionTelemetry = Effect.fn("GlobalHttpApi.sessionTelemetry")(function* (ctx: {
      payload: typeof GlobalSessionTelemetryInput.Type
    }) {
      const telemetry = yield* SessionTelemetry.Service
      return yield* telemetry.snapshot(ctx.payload.sessions)
    })

    const sessionStatus = Effect.fn("GlobalHttpApi.sessionStatus")(function* (ctx: {
      query: typeof GlobalSessionStatusQuery.Type
    }) {
      const directory = ctx.query.directory ?? ctx.query.workspace
      if (directory !== undefined) {
        const resolved = FSUtil.resolve(directory)
        const current = yield* statuses.list()
        const candidates = [...current.keys()]
        const sessionIDs = yield* execution.listSessionIDsByDirectory(resolved, candidates)
        const currentByDirectory = yield* statuses.listForSessionIDs(sessionIDs)
        const result = Object.fromEntries(currentByDirectory)
        for (const [sessionID] of yield* execution.listWorkingByDirectory(resolved)) {
          result[sessionID] ??= { type: "busy" }
        }
        return result
      }
      const result = Object.fromEntries(yield* statuses.list())
      for (const [sessionID] of yield* execution.listWorking()) {
        result[sessionID] ??= { type: "busy" }
      }
      return result
    })

    const oxpActivities = Effect.fn("GlobalHttpApi.oxpActivities")(function* (ctx: {
      query: typeof GlobalOxpActivityListQuery.Type
    }) {
      const before =
        ctx.query.beforeLastSeenAt !== undefined && ctx.query.beforeID
          ? {
              lastSeenAt: ctx.query.beforeLastSeenAt,
              id: ctx.query.beforeID,
            }
          : undefined
      const rows = yield* oxpInspection.list({
        limit: ctx.query.limit,
        includeArchived: ctx.query.includeArchived === "true",
        ...(before ? { before } : {}),
      })
      return rows.map(projectOxpActivity)
    })

    const oxpActivityGet = Effect.fn("GlobalHttpApi.oxpActivityGet")(function* (ctx: {
      params: { activityID: Parameters<typeof oxpInspection.get>[0] }
    }) {
      const row = yield* oxpInspection.get(ctx.params.activityID)
      return row ? projectOxpActivity(row) : null
    })

    const oxpAttributionSnapshot = Effect.fn("GlobalHttpApi.oxpAttribution")(function* (ctx: {
      query: typeof GlobalOxpAttributionQuery.Type
    }) {
      return yield* oxpAttribution.snapshot(ctx.query)
    })

    const oxpInvocations = Effect.fn("GlobalHttpApi.oxpInvocations")(function* (ctx: {
      params: { activityID: Parameters<typeof oxpInspection.get>[0] }
      query: typeof GlobalOxpInvocationQuery.Type
    }) {
      const before =
        ctx.query.beforeStartedAt !== undefined && ctx.query.beforeID
          ? {
              startedAt: ctx.query.beforeStartedAt,
              id: ctx.query.beforeID,
            }
          : undefined
      const page = yield* oxpInspection.invocations({
        activityID: ctx.params.activityID,
        limit: ctx.query.limit,
        ...(before ? { before } : {}),
      })
      const links = new Map<string, OxpActivityInspection.InvocationLink[]>()
      for (const link of page.links) {
        const rows = links.get(link.invocation_id)
        if (rows) rows.push(link)
        else links.set(link.invocation_id, [link])
      }
      return {
        items: page.items.map((row) => projectOxpInvocation(row, links.get(row.id) ?? [])),
        more: page.more,
        ...(page.before ? { before: page.before } : {}),
      }
    })

    const oxpInvocationDetail = Effect.fn("GlobalHttpApi.oxpInvocationDetail")(function* (ctx: {
      params: { invocationID: Parameters<typeof oxpInspection.invocationDetail>[0] }
    }) {
      const row = yield* oxpInspection.invocationDetail(ctx.params.invocationID)
      if (!row) return null
      return {
        invocationID: row.invocation_id,
        ...(row.request ? { request: row.request } : {}),
        ...(row.outcome ? { outcome: row.outcome } : {}),
      }
    })

    const oxpResource = Effect.fn("GlobalHttpApi.oxpResource")(function* (ctx: {
      query: typeof GlobalOxpResourceQuery.Type
    }) {
      return yield* oxpInspection.resource({
        kind: ctx.query.kind,
        ref: ctx.query.ref,
        limit: ctx.query.limit,
      })
    })

    const oxpActivityUpdate = Effect.fn("GlobalHttpApi.oxpActivityUpdate")(function* (ctx: {
      params: { activityID: Parameters<typeof oxpInspection.get>[0] }
      payload: typeof GlobalOxpActivityPatch.Type
    }) {
      let changed = false
      if (ctx.payload.title !== undefined || ctx.payload.clearTitle === true) {
        const title =
          ctx.payload.clearTitle === true || !ctx.payload.title?.trim() ? undefined : ctx.payload.title.trim()
        changed = (yield* oxpActivity.rename(ctx.params.activityID, title)) || changed
      }
      if (ctx.payload.archived !== undefined) {
        changed = (yield* oxpActivity.archive(ctx.params.activityID, ctx.payload.archived)) || changed
      }
      return changed
    })

    const oxpActivityDelete = Effect.fn("GlobalHttpApi.oxpActivityDelete")(function* (ctx: {
      params: { activityID: Parameters<typeof oxpInspection.get>[0] }
    }) {
      return {
        deleted: yield* oxpActivity.deleteHistory(ctx.params.activityID),
      }
    })

    const projectList = Effect.fn("GlobalHttpApi.projects")(function* () {
      const projects = yield* Project.Service
      return yield* projects.list()
    })

    const configGet = Effect.fn("GlobalHttpApi.configGet")(function* () {
      const config = yield* Config.Service
      return yield* config.getGlobal()
    })

    const configUpdate = Effect.fn("GlobalHttpApi.configUpdate")(function* (ctx) {
      const config = yield* Config.Service
      const bridge = yield* EffectBridge.make()
      const result = yield* config.updateGlobal(ctx.payload)
      if (result.changed) bridge.fork(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }))
      return result.info
    })

    const configAgentSet = Effect.fn("GlobalHttpApi.configAgentSet")(function* (ctx) {
      const config = yield* Config.Service
      const bridge = yield* EffectBridge.make()
      const result = yield* config.updateGlobalAgent({ id: ctx.params.agentID, value: ctx.payload })
      if (result.changed) bridge.fork(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }))
      return result.info
    })

    const configAgentDelete = Effect.fn("GlobalHttpApi.configAgentDelete")(function* (ctx) {
      const config = yield* Config.Service
      const bridge = yield* EffectBridge.make()
      const result = yield* config.updateGlobalAgent({ id: ctx.params.agentID, value: null })
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

    const resetData = Effect.fn("GlobalHttpApi.resetLocalData")(function* () {
      const instances = yield* InstanceStore.Service
      return yield* Effect.gen(function* () {
        yield* instances.disposeAll()
        const result = yield* resetLocalData()
        resetUsageSummaryCache()
        bumpUsageCache()
        return result
      }).pipe(Effect.ensuring(emitGlobalDisposed), Effect.uninterruptible)
    })

    const upgrade = Effect.fn("GlobalHttpApi.upgrade")(function* (ctx: { payload: typeof GlobalUpgradeInput.Type }) {
      const installation = yield* Installation.Service
      const method = yield* installation.method()
      if (method === "unknown") {
        return HttpServerResponse.jsonUnsafe(
          {
            success: false as const,
            error: `This OpenFork executable is externally managed. Install the matching OpenFork release from ${PRODUCT_RELEASES_URL}.`,
          },
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
      .handle("syncCapabilities", syncCapabilities)
      .handle("health", health)
      .handleRaw("event", event)
      .handle("eventInterest", eventInterest)
      .handle("sessionRoots", sessionRoots)
      .handle("sessionMetadata", sessionMetadata)
      .handle("archivedSessionRoots", archivedSessionRoots)
      .handle("sessionGet", sessionGet)
      .handle("sessionTelemetry", sessionTelemetry)
      .handle("sessionStatus", sessionStatus)
      .handle("oxpActivities", oxpActivities)
      .handle("oxpActivityGet", oxpActivityGet)
      .handle("oxpInvocations", oxpInvocations)
      .handle("oxpAttribution", oxpAttributionSnapshot)
      .handle("oxpInvocationDetail", oxpInvocationDetail)
      .handle("oxpResource", oxpResource)
      .handle("oxpActivityUpdate", oxpActivityUpdate)
      .handle("oxpActivityDelete", oxpActivityDelete)
      .handle("projects", projectList)
      .handle("configGet", configGet)
      .handle("configUpdate", configUpdate)
      .handle("configAgentSet", configAgentSet)
      .handle("configAgentDelete", configAgentDelete)
      .handle("preferencesGet", preferencesGet)
      .handle("preferencesUpdate", preferencesUpdate)
      .handle("dispose", dispose)
      .handle("resetLocalData", resetData)
      .handle("upgrade", upgrade)
  }),
)
