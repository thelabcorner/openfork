export * as SwarmSessionAdmission from "./session-admission"

import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { SwarmRender } from "@opencode-ai/core/swarm/render"
import { SwarmSessionProjector } from "@opencode-ai/core/swarm-session-projector"
import { SwarmSchema } from "@opencode-ai/core/swarm/schema"
import { SessionSynthetic } from "@opencode-ai/schema/session-synthetic"
import { SessionTurnProvenance } from "@opencode-ai/schema/session-turn-provenance"
import { Swarm } from "@opencode-ai/schema/swarm"
import { SessionPrompt } from "@/session/prompt"
import { InstanceStore } from "@/project/instance-store"

export class TargetSessionMissingError extends Schema.TaggedErrorClass<TargetSessionMissingError>()(
  "SwarmSessionAdmission.TargetSessionMissingError",
  {
    sessionID: Schema.String,
  },
) {}

export class HumanFocusConflict extends Schema.TaggedErrorClass<HumanFocusConflict>()(
  "SwarmSessionAdmission.HumanFocusConflict",
  {
    sessionID: Schema.String,
    expectedLatestUserSeq: Schema.optional(Schema.Number),
    actualLatestUserSeq: Schema.optional(Schema.Number),
  },
) {}

export class AdmissionConflictError extends Schema.TaggedErrorClass<AdmissionConflictError>()(
  "SwarmSessionAdmission.AdmissionConflictError",
  {
    reason: Schema.String,
    code: Schema.optional(Schema.String),
  },
) {}

export interface AssignmentInput {
  readonly token: SwarmV2.LeaseToken
  readonly runID: Swarm.TaskRunID
  readonly sessionInputID: Swarm.TaskRun["sessionInputID"]
  readonly task: Swarm.Task
  readonly admittedAt?: number
}

export interface PeerInput {
  readonly delivery: Swarm.Delivery
  readonly message: Swarm.Message
  readonly token: SwarmV2.DeliveryClaimToken
  readonly admittedAt?: number
}

export interface Interface {
  readonly assignment: (
    input: AssignmentInput,
  ) => Effect.Effect<SessionInput.Entry, TargetSessionMissingError | HumanFocusConflict | AdmissionConflictError>
  readonly peer: (
    input: PeerInput,
  ) => Effect.Effect<SessionInput.Entry, TargetSessionMissingError | HumanFocusConflict | AdmissionConflictError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SwarmSessionAdmission") {}

function defectText(defect: unknown) {
  if (defect instanceof Error) return defect.message
  if (typeof defect === "object" && defect !== null && "reason" in defect) return String((defect as { reason: unknown }).reason)
  return String(defect)
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const { db, readDb } = database
    const sessions = yield* SessionStore.Service
    const prompt = yield* SessionPrompt.Service
    const instances = yield* InstanceStore.Service
    const swarm = yield* SwarmV2.Service

    const targetDirectory = Effect.fn("SwarmSessionAdmission.targetDirectory")(function* (sessionID: string) {
      const session = yield* sessions.get(sessionID as never)
      if (!session) return yield* new TargetSessionMissingError({ sessionID })
      return session.location.directory
    })

    const latestFence = (sessionID: Swarm.TaskLease["ownerSessionID"]) =>
      SessionInput.latestUserSeq(readDb, sessionID as never)

    const translateDefect = (
      defect: unknown,
    ): Effect.Effect<never, HumanFocusConflict | AdmissionConflictError> => {
      if (defect instanceof SessionInput.AdmissionFenceConflict) {
        return Effect.fail(
          new HumanFocusConflict({
            sessionID: defect.sessionID,
            ...(defect.expectedLatestUserSeq === undefined
              ? {}
              : { expectedLatestUserSeq: defect.expectedLatestUserSeq }),
            ...(defect.actualLatestUserSeq === undefined ? {} : { actualLatestUserSeq: defect.actualLatestUserSeq }),
          }),
        )
      }
      if (
        defect instanceof SwarmSchema.StaleFenceError ||
        defect instanceof SwarmSchema.ConflictError ||
        defect instanceof SwarmSchema.InvalidTransitionError ||
        defect instanceof SwarmSchema.NotFoundError ||
        defect instanceof SwarmSchema.ValidationError ||
        defect instanceof SessionInput.LifecycleConflict
      ) {
        const code =
          defect instanceof SwarmSchema.ConflictError
            ? defect.code
            : defect instanceof SwarmSchema.StaleFenceError
              ? "swarm.stale_fence"
              : defect instanceof SwarmSchema.InvalidTransitionError
                ? "swarm.invalid_transition"
                : defect instanceof SwarmSchema.NotFoundError
                  ? "swarm.not_found"
                  : defect instanceof SwarmSchema.ValidationError
                    ? "swarm.validation"
                    : "session.lifecycle_conflict"
        return Effect.fail(new AdmissionConflictError({ reason: defectText(defect), code }))
      }
      return Effect.die(defect)
    }

    const assignment: Interface["assignment"] = Effect.fn("SwarmSessionAdmission.assignment")(function* (input) {
      const directory = yield* targetDirectory(input.token.sessionID)
      const expectedLatestUserSeq = yield* latestFence(input.token.sessionID)
      const admittedAt = input.admittedAt ?? Date.now()
      // Bounded host-generated predecessor handoff. Reads Swarm collaboration
      // rows only; predecessor Session history is never hydrated. A task with
      // no declared dependencies renders exactly as before.
      const handoff = yield* swarm.taskHandoff(input.task.id)
      const origin = SessionSynthetic.Origin.make({
        producer: SessionTurnProvenance.Source.SwarmAssignment,
        actor: { type: "host" },
        ref: input.runID,
      })
      return yield* instances
        .provide(
          { directory },
          prompt.admitSynthetic({
            id: input.sessionInputID,
            sessionID: input.token.sessionID as never,
            content: { text: SwarmRender.assignment(input.task, handoff) },
            origin,
            admissionClass: "host",
            delivery: "queue",
            userPreemptible: true,
            // Property presence is intentional even when undefined: it means
            // there must still be no semantic User admitted after this read.
            expectedLatestUserSeq,
            commit: () =>
              SwarmV2.commitTaskRunAdmission(db, {
                token: input.token,
                id: input.runID,
                sessionInputID: input.sessionInputID,
                admittedAt,
              }).pipe(Effect.asVoid, Effect.catch((error) => Effect.die(error))),
          }),
        )
        .pipe(
          Effect.mapError((error) => new AdmissionConflictError({ reason: defectText(error), code: "session.host_admission" })),
          Effect.catchDefect(translateDefect),
        )
    })

    const peer: Interface["peer"] = Effect.fn("SwarmSessionAdmission.peer")(function* (input) {
      const directory = yield* targetDirectory(input.token.recipientSessionID)
      const expectedLatestUserSeq = yield* latestFence(input.token.recipientSessionID)
      const admittedAt = input.admittedAt ?? Date.now()
      const origin = SessionSynthetic.Origin.make({
        producer: SessionTurnProvenance.Source.SwarmPeer,
        actor: { type: "session", sessionID: input.message.senderSessionID },
        ref: input.delivery.id,
      })
      return yield* instances
        .provide(
          { directory },
          prompt.admitSynthetic({
            id: input.delivery.sessionInputID,
            sessionID: input.token.recipientSessionID as never,
            content: { text: SwarmRender.peer(input.message) },
            origin,
            admissionClass: "host",
            delivery: input.message.priority === "urgent" ? "steer" : "queue",
            userPreemptible: false,
            expectedLatestUserSeq,
            commit: (seq) =>
              SwarmV2.commitDeliveryAdmission(db, {
                token: input.token,
                admittedSessionID: input.token.recipientSessionID,
                admittedSeq: seq,
                admittedAt,
              }).pipe(Effect.asVoid, Effect.catch((error) => Effect.die(error))),
          }),
        )
        .pipe(
          Effect.mapError((error) => new AdmissionConflictError({ reason: defectText(error), code: "session.host_admission" })),
          Effect.catchDefect(translateDefect),
        )
    })

    return Service.of({ assignment, peer })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [
    Database.node,
    SessionStore.node,
    SessionPrompt.node,
    InstanceStore.node,
    SwarmV2.node,
    SwarmSessionProjector.node,
  ],
})
