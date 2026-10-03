import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionID } from "./schema"
import { Effect, Layer, Context } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"
import { SessionTelemetry } from "@opencode-ai/core/session/telemetry"

export const Info = SessionStatusEvent.Info
export type Info = SessionStatusEvent.Info

export const Event = SessionStatusEvent

export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Map<SessionID, Info>>
  readonly listForSessionIDs: (sessionIDs: readonly SessionID[]) => Effect.Effect<Map<SessionID, Info>>
  readonly set: (sessionID: SessionID, status: Info, reason?: "aborted") => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionStatus") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const telemetry = yield* SessionTelemetry.Service

    // Session IDs are process-global durable identities. Keeping this map in
    // InstanceState split delegated sessions across their caller's directory
    // and made a directory-scoped status endpoint miss active workers.
    const state = new Map<SessionID, Info>()

    const get = Effect.fn("SessionStatus.get")(function* (sessionID: SessionID) {
      return state.get(sessionID) ?? { type: "idle" as const }
    })

    const list = Effect.fn("SessionStatus.list")(function* () {
      return new Map(state)
    })

    const listForSessionIDs = Effect.fn("SessionStatus.listForSessionIDs")(function* (sessionIDs: readonly SessionID[]) {
      const result = new Map<SessionID, Info>()
      for (const sessionID of sessionIDs) {
        const status = state.get(sessionID)
        if (status) result.set(sessionID, status)
      }
      return result
    })

    const set = Effect.fn("SessionStatus.set")(function* (sessionID: SessionID, status: Info, reason?: "aborted") {
      yield* events.publish(Event.Status, { sessionID, status })
      if (status.type === "retry") yield* telemetry.retry(sessionID)
      if (status.type === "idle") {
        yield* telemetry.idle(sessionID)
        yield* events.publish(Event.Idle, reason ? { sessionID, reason } : { sessionID })
        state.delete(sessionID)
        return
      }
      state.set(sessionID, status)
    })

    return Service.of({ get, list, listForSessionIDs, set })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node, SessionTelemetry.node] })

export * as SessionStatus from "./status"
