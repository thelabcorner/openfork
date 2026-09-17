// Opencode publish boundary for core events. Attach routed instance location
// so direct EventV2 consumers can isolate directory/workspace streams.
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { GlobalBus } from "@/bus/global"
import { EventV2 } from "@opencode-ai/core/event"
import { EventReplayBuffer, estimateEventBytes, type EventReplayResult } from "@opencode-ai/core/event-replay"
import { EventTrace } from "@opencode-ai/core/event-trace"
import { Location } from "@opencode-ai/core/location"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Context, Effect, Layer } from "effect"

export interface Interface extends EventV2.Interface {
  /**
   * Volatile transport replay. The cursor is intentionally separate from the
   * domain event id: one event id can be published by more than one transport,
   * while a monotonic cursor lets SSE reconnects prove what was delivered.
   */
  readonly replaySince: (
    after: number | undefined,
    filter?: (event: EventV2.Payload) => boolean,
  ) => EventReplayResult<EventV2.Payload>
  readonly replayLatest: () => number
  readonly replayEpoch: string
  readonly sequenceOf: (event: EventV2.Payload) => number | undefined
  /**
   * Open one compatibility `/event` replay range. The first subscriber after an
   * idle period starts a fresh epoch and returns the exact sequence boundary at
   * connect time. Fresh subscribers replay only events published after `after`,
   * which closes the capture-before-live-listener setup race without sending
   * unrelated pre-connect history.
   */
  readonly replayConnect: () => { readonly epoch: string; readonly after: number; readonly release: () => void }
}

export class Service extends Context.Service<Service, Interface>()("@opencode/EventV2Bridge") {}

// Keep the resumable legacy route's replay policy sourced from the bridge that
// actually owns the ring. Duplicating these literals in the HTTP handler let a
// 4 MiB replay guard silently reject half of an 8 MiB retained window.
export const REPLAY_CAPACITY = 4096
export const REPLAY_MAX_BYTES = 8 * 1024 * 1024

/**
 * Liveness probes for transports that can observe a legacy `GlobalBus`
 * envelope.
 *
 * `GlobalBus.listenerCount` is NOT a usable allocation gate on its own: the
 * global HTTP route installs a replay-capture listener for the whole process
 * lifetime, so a registration-count gate is permanently defeated and every
 * publish pays the legacy conversion and broadcast cost even with zero
 * clients. Registration is not consumption — a listener that is registered
 * while no SSE response is open cannot deliver anything to anybody.
 *
 * Each transport therefore registers a probe that reports whether it has at
 * least one CONNECTED subscriber. Probes are closures registered per handler
 * group, so several servers in one process stay independent.
 */
type LegacyTransportProbe = {
  readonly isActive: () => boolean
  /** Number of `GlobalBus("event")` listeners owned by this transport. */
  readonly listenerCount: () => number
  /** Whether this transport's current replay generation requires durable sync envelopes. */
  readonly needsSync: () => boolean
}

const legacyTransports = new Set<LegacyTransportProbe>()

type LegacyTransportInput = (() => boolean) | {
  readonly isActive: () => boolean
  readonly listenerCount?: () => number
  readonly needsSync?: () => boolean
}

function normalizeLegacyTransport(input: LegacyTransportInput): LegacyTransportProbe {
  if (typeof input === "function") {
    // Historical callers are conservatively treated as sync-capable. They do
    // not expose their listener count, so direct-listener accounting remains
    // conservative as well.
    return { isActive: input, listenerCount: () => 0, needsSync: input }
  }
  return {
    isActive: input.isActive,
    listenerCount: input.listenerCount ?? (() => 0),
    needsSync: input.needsSync ?? input.isActive,
  }
}

/**
 * Register a legacy transport liveness probe. Returns the unregister
 * function; call it when the owning handler group is released.
 */
export function registerLegacyTransport(input: LegacyTransportInput): () => void {
  const probe = normalizeLegacyTransport(input)
  legacyTransports.add(probe)
  return () => {
    legacyTransports.delete(probe)
  }
}

function directLegacyListenerCount() {
  let transportListeners = 0
  for (const probe of legacyTransports) {
    if (!probe.isActive()) continue
    transportListeners += Math.max(0, probe.listenerCount())
  }
  return Math.max(0, GlobalBus.listenerCount("event") - transportListeners)
}

/**
 * True when at least one legacy consumer can actually observe an emitted
 * envelope: either a real `GlobalBus("event")` listener (the TUI worker and
 * transient `waitEvent` callers), or a transport with a connected subscriber.
 *
 * The internal `"event.replay"` channel is deliberately excluded — it is a
 * capture sink, never a delivery path.
 */
export function hasLegacyConsumer(): boolean {
  if (directLegacyListenerCount() > 0) return true
  for (const probe of legacyTransports) if (probe.isActive()) return true
  return false
}

/**
 * Durable `sync` envelopes are a second representation of the same durable
 * event. Interest-aware desktop SSE clients explicitly do not consume them,
 * while control-plane/TUI/older subscribers still do. Keep compatibility
 * envelopes available to every legacy consumer, but manufacture the duplicate
 * durable envelope only when at least one real consumer needs it.
 */
export function hasLegacySyncConsumer(): boolean {
  // Direct in-process listeners cannot advertise capabilities, so fail safe.
  if (directLegacyListenerCount() > 0) return true
  for (const probe of legacyTransports) {
    if (probe.isActive() && probe.needsSync()) return true
  }
  return false
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const makeReplayGeneration = () => ({
      replay: new EventReplayBuffer<EventV2.Payload>(REPLAY_CAPACITY, {
        maxBytes: REPLAY_MAX_BYTES,
        sizeOf: estimateEventBytes,
      }),
      sequences: new WeakMap<object, number>(),
    })
    let replayGeneration = makeReplayGeneration()
    let replaySubscribers = 0

    const replayConnect = () => {
      if (replaySubscribers === 0) replayGeneration = makeReplayGeneration()
      replaySubscribers += 1
      const generation = replayGeneration
      const after = generation.replay.latest()
      let released = false
      return {
        epoch: generation.replay.epoch,
        after,
        release: () => {
          if (released) return
          released = true
          replaySubscribers = Math.max(0, replaySubscribers - 1)
        },
      }
    }

    const publish: EventV2.Interface["publish"] = (definition, data, options) =>
      Effect.gen(function* () {
        if (options?.location) return yield* events.publish(definition, data, options)
        const ctx = yield* InstanceRef
        if (!ctx) return yield* events.publish(definition, data, options)
        const workspaceID = yield* WorkspaceRef
        return yield* events.publish(definition, data, {
          ...options,
          location: new Location.Info({
            directory: AbsolutePath.make(ctx.directory),
            ...(workspaceID ? { workspaceID } : {}),
            project: { id: Project.ID.make(ctx.project.id), directory: AbsolutePath.make(ctx.worktree) },
          }),
        })
      })

    const unsubscribe = yield* events.listen((event) =>
      Effect.gen(function* () {
        // `/api/event` owns its own replay ring in packages/server. This bridge
        // ring exists only for the compatibility `/event` transport, so do not
        // duplicate byte estimation + retention for every token while no such
        // subscriber exists. A replay lease is opened before that transport's
        // live listener/replay handoff, preserving its reconnect window exactly.
        if (replaySubscribers > 0) {
          replayGeneration.sequences.set(event, replayGeneration.replay.append(event))
        }
        EventTrace.count("bridge.published")
        EventTrace.histogram("bridge.type", event.type)
        // Native /api/event subscribers do not consume the legacy GlobalBus.
        // Avoid resolving the instance context, constructing a second payload
        // and broadcasting it for every token when no legacy client can
        // observe it. Gate on connected SUBSCRIBERS plus real `event`
        // listeners: `listenerCount("event.replay")` is not evidence of
        // consumption, since the global route keeps a capture listener
        // registered for the whole process lifetime and would defeat the gate
        // permanently. Instance disposal uses its dedicated lifecycle channel.
        if (!hasLegacyConsumer()) {
          EventTrace.count("bridge.legacySkipped")
          return
        }
        const ctx = yield* InstanceRef
        const workspaceID = (yield* WorkspaceRef) ?? event.location?.workspaceID
        GlobalBus.emit("event", {
          // Truly process-global events (for example the compact batched
          // session telemetry projection) intentionally have neither a
          // Location nor an InstanceRef. Keep that ownership explicit instead
          // of leaking an undefined directory into the legacy transport.
          directory: event.location?.directory ?? ctx?.directory ?? "global",
          project: ctx?.project.id,
          workspace: workspaceID,
          payload: { id: event.id, type: event.type, properties: event.data },
        })
        if (event.durable === undefined) {
          EventTrace.count("bridge.legacyEnvelopes")
          return
        }
        if (!hasLegacySyncConsumer()) {
          EventTrace.count("bridge.syncSkipped")
          EventTrace.count("bridge.legacyEnvelopes")
          return
        }
        EventTrace.count("bridge.legacyEnvelopes", 2)
        GlobalBus.emit("event", {
          directory: event.location?.directory ?? ctx?.directory ?? "global",
          project: ctx?.project.id,
          workspace: workspaceID,
          payload: {
            type: "sync",
            syncEvent: {
              id: event.id,
              type: EventV2.versionedType(event.type, event.durable.version),
              seq: event.durable.seq,
              aggregateID: event.durable.aggregateID,
              data: event.data,
            },
          },
        })
      }),
    )
    yield* Effect.addFinalizer(() => unsubscribe)

    return Service.of({
      ...events,
      publish,
      replayConnect,
      replaySince: (after, filter) => replayGeneration.replay.since(after, filter),
      replayLatest: () => replayGeneration.replay.latest(),
      get replayEpoch() {
        return replayGeneration.replay.epoch
      },
      sequenceOf: (event) => replayGeneration.sequences.get(event),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2.node] })

export * as EventV2Bridge from "./event-v2-bridge"
