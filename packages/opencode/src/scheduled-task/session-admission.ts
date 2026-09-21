import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { ScheduledTask } from "@opencode-ai/core/scheduled-task"
import { ScheduledTaskSchema } from "@opencode-ai/core/scheduled-task/schema"
import { SessionInput, type RevokeResult } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionTurnProvenance } from "@opencode-ai/core/session/turn-provenance"
import { SessionID } from "@opencode-ai/schema/session-id"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionPrompt, HostOwnedSessionError } from "@/session/prompt"

export interface DispatchInput {
  readonly runID: ScheduledTask.RunID
  readonly attempt: number
  readonly sessionID: SessionID
  readonly content: SessionInput.SyntheticContent
  readonly execution: SessionInput.SyntheticExecution
  readonly delegated?: SessionInput.DelegatedTurnAuthority
  /**
   * Presence means admission is conditional on this exact semantic User
   * frontier. The value may itself be undefined, meaning "still no User input".
   */
  readonly userFence?: { readonly expectedLatestUserSeq: number | undefined }
}

export type DispatchError =
  | SessionInput.AdmissionFenceConflict
  | ScheduledTaskSchema.RunNotFoundError
  | ScheduledTaskSchema.RunAttemptConflictError
  | ScheduledTaskSchema.ValidationError
  | HostOwnedSessionError

export interface Interface {
  readonly admit: (input: DispatchInput) => Effect.Effect<SessionInput.Entry, DispatchError>
  readonly run: (sessionID: SessionID) => Effect.Effect<SessionV1.WithParts>
  readonly revoke: (input: {
    readonly runID: ScheduledTask.RunID
    readonly attempt: number
  }) => Effect.Effect<RevokeResult | undefined>
  readonly dispatch: (input: DispatchInput) => Effect.Effect<SessionV1.WithParts, DispatchError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ScheduledTaskSessionAdmission") {}

export function inputID(runID: ScheduledTask.RunID, attempt: number) {
  return SessionMessage.ID.make(`msg_scheduled_${runID}_attempt_${attempt}`)
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const tasks = yield* ScheduledTask.Service
    const prompt = yield* SessionPrompt.Service

    const recoverTrustedAdmissionDefect = (defect: unknown) => {
      if (
        defect instanceof SessionInput.AdmissionFenceConflict ||
        defect instanceof ScheduledTaskSchema.RunNotFoundError ||
        defect instanceof ScheduledTaskSchema.RunAttemptConflictError ||
        defect instanceof ScheduledTaskSchema.ValidationError
      ) {
        return Effect.fail(defect)
      }
      return Effect.die(defect)
    }

    const revokeAttempt = Effect.fn("ScheduledTaskSessionAdmission.revokeAttempt")(function* (
      runID: ScheduledTask.RunID,
      attempt: number,
    ) {
      const id = inputID(runID, attempt)
      const existing = yield* SessionInput.findEntry(db, id)
      if (
        !existing ||
        existing.kind !== "synthetic" ||
        existing.item.type !== "synthetic" ||
        existing.item.origin.producer !== SessionTurnProvenance.Source.ScheduledTaskRun ||
        existing.item.origin.ref !== runID
      ) {
        return undefined
      }
      return (yield* SessionInput.revokeSynthetic(db, events, {
        sessionID: existing.sessionID,
        id,
        reason: "cancelled",
      })) as RevokeResult
    })

    const admit: Interface["admit"] = Effect.fn("ScheduledTaskSessionAdmission.admit")(function* (input) {
      // Cheap preflight gives the executor a normal typed failure. The commit
      // hook below repeats the same fence transactionally with Session admission.
      yield* tasks.authorizeRunSession({
        runID: input.runID,
        attempt: input.attempt,
        sessionID: input.sessionID,
      })

      // A retry owns the same logical run but a new attempt fence. Remove any
      // still-pending predecessor input before admitting this attempt so a
      // crash between admission and execution cannot surface stale work later.
      for (let attempt = 1; attempt < input.attempt; attempt++) {
        yield* revokeAttempt(input.runID, attempt).pipe(Effect.ignore)
      }

      return yield* prompt
        .admitSynthetic({
          id: inputID(input.runID, input.attempt),
          sessionID: input.sessionID,
          content: input.content,
          execution: input.execution,
          ...(input.delegated === undefined ? {} : { delegated: input.delegated }),
          origin: {
            producer: SessionTurnProvenance.Source.ScheduledTaskRun,
            actor: { type: "host" },
            ref: input.runID,
          },
          admissionClass: "host",
          delivery: "queue",
          userPreemptible: true,
          ...(input.userFence
            ? { expectedLatestUserSeq: input.userFence.expectedLatestUserSeq }
            : {}),
          // SessionInput projection and this scheduler fence commit in one
          // EventV2 IMMEDIATE transaction. A retry ownership change therefore
          // cannot land between authorization and durable admission.
          commit: () =>
            ScheduledTask.authorizeRunSessionIn(db, {
              runID: input.runID,
              attempt: input.attempt,
              sessionID: input.sessionID,
            }).pipe(
              Effect.asVoid,
              Effect.catch((error) => Effect.die(error)),
            ),
          resume: false,
        })
        .pipe(Effect.catchDefect(recoverTrustedAdmissionDefect))
    })

    const run: Interface["run"] = Effect.fn("ScheduledTaskSessionAdmission.run")((sessionID) =>
      prompt.loop({ sessionID }),
    )

    const revoke: Interface["revoke"] = Effect.fn("ScheduledTaskSessionAdmission.revoke")((input) =>
      revokeAttempt(input.runID, input.attempt),
    )

    const dispatch: Interface["dispatch"] = Effect.fn("ScheduledTaskSessionAdmission.dispatch")(function* (input) {
      yield* admit(input)
      return yield* run(input.sessionID)
    })

    return Service.of({ admit, run, revoke, dispatch })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, ScheduledTask.node, SessionPrompt.node],
})

export * as ScheduledTaskSessionAdmission from "./session-admission"
