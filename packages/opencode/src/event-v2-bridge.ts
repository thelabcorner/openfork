// Opencode publish boundary for core events. Attach routed instance location
// so direct EventV2 consumers can isolate directory/workspace streams.
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { GlobalBus } from "@/bus/global"
import { EventV2 } from "@opencode-ai/core/event"
import { EventReplayBuffer, estimateEventBytes, type EventReplayResult } from "@opencode-ai/core/event-replay"
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
}

export class Service extends Context.Service<Service, Interface>()("@opencode/EventV2Bridge") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const replay = new EventReplayBuffer<EventV2.Payload>(4096, {
      maxBytes: 8 * 1024 * 1024,
      sizeOf: estimateEventBytes,
    })
    const sequences = new WeakMap<object, number>()

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
        // Record before the legacy bridge can early-return. Native SSE
        // subscribers use this same sequence map, so every published event has
        // a stable cursor even when no legacy GlobalBus listener is installed.
        sequences.set(event, replay.append(event))
        // Native /api/event subscribers do not consume the legacy GlobalBus.
        // Avoid constructing and synchronously broadcasting a second payload
        // for every token when no legacy listener is present. Instance
        // disposal uses its dedicated lifecycle channel.
        if (GlobalBus.listenerCount("event") === 0 && GlobalBus.listenerCount("event.replay") === 0) return
        const ctx = yield* InstanceRef
        const workspaceID = (yield* WorkspaceRef) ?? event.location?.workspaceID
        GlobalBus.emit("event", {
          directory: event.location?.directory ?? ctx?.directory,
          project: ctx?.project.id,
          workspace: workspaceID,
          payload: { id: event.id, type: event.type, properties: event.data },
        })
        if (event.durable === undefined) return
        GlobalBus.emit("event", {
          directory: event.location?.directory ?? ctx?.directory,
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
      replaySince: (after, filter) => replay.since(after, filter),
      replayLatest: () => replay.latest(),
      replayEpoch: replay.epoch,
      sequenceOf: (event) => sequences.get(event),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2.node] })

export * as EventV2Bridge from "./event-v2-bridge"
