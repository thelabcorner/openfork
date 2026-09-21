import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { OxpAuthority } from "./authority"
import { OxpError } from "./error"
import { OxpRequestControl } from "./request-control"
import { OxpResult } from "./result"
import { OxpSchema } from "./schema"
import { OxpSupervision } from "./supervision"

const ID = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))
const ReplyMessage = Schema.String.check(Schema.isMaxLength(4 * 1024))
const Answer = Schema.Array(
  Schema.String.check(Schema.isMaxLength(2 * 1024)),
).check(Schema.isMaxLength(32))
const Answers = Schema.Array(Answer).check(Schema.isMaxLength(32))
const Details = Schema.Array(
  Schema.String.check(Schema.isMaxLength(4 * 1024)),
).check(Schema.isMaxLength(32))

export const Parameters = Schema.Struct({
  action: Schema.Literals([
    "list",
    "reply_permission",
    "answer_question",
    "reject_question",
  ]),
  sessionID: Schema.optional(ID),
  rootID: Schema.optional(OxpSchema.RootID),
  requestID: Schema.optional(ID),
  reply: Schema.optional(Schema.Literals(["once", "always", "reject"])),
  message: Schema.optional(ReplyMessage),
  answers: Schema.optional(Answers),
  details: Schema.optional(Details),
})
export type Input = Schema.Schema.Type<typeof Parameters>

export interface Interface {
  readonly execute: (
    input: Input,
    signal?: AbortSignal,
  ) => Effect.Effect<OxpResult.CapabilityResult, OxpError.Error>
}

export class Service extends Context.Service<Service, Interface>()(
  "@opencode/OxpRequest",
) {}
export const use = serviceUse(Service)

function cancelled(signal?: AbortSignal) {
  return signal?.aborted
    ? Effect.fail<OxpError.Error>(
        new OxpError.Cancelled({
          detail: "OXP request-supervision call was cancelled",
        }),
      )
    : Effect.void
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const authority = yield* OxpAuthority.Service
    const supervision = yield* OxpSupervision.Service
    const control = yield* OxpRequestControl.Service

    const mapControlError = (error: Error): OxpError.Error => {
      if (OxpError.isError(error)) return error
      if (error instanceof OxpRequestControl.RequestNotFound) {
        return new OxpError.NotFound({
          detail: "Native Session request is not available to OXP supervision",
        })
      }
      if (error instanceof OxpRequestControl.ExternalDirectoryBlocked) {
        return new OxpError.AuthDenied({ detail: OxpError.boundDetail(error.message) })
      }
      return new OxpError.DependencyUnavailable({
        detail: "Native Permission/Question supervision failed",
      })
    }

    const executeRaw = Effect.fn("OxpRequest.execute")(function* (
      input: Input,
      signal?: AbortSignal,
    ) {
      yield* cancelled(signal)
      const operation = "request." + input.action
      const visible = yield* authority.discover({
        plane: "supervision",
        operation,
      })
      if (!visible) {
        return yield* new OxpError.AuthDenied({
          detail: "OXP request supervision is not enabled",
        })
      }
      if (!input.sessionID) {
        return yield* new OxpError.InvalidArgument({
          detail: "openfork_request requires sessionID",
        })
      }

      const target = yield* supervision.resolve(
        input.sessionID,
        operation,
        input.rootID,
      )
      const admitted = yield* authority.revalidate(
        target.admission,
        "supervise",
      )
      const runtimeTarget = supervision.runtimeTarget({
        row: target.row,
        admission: admitted,
      })
      const actorRef = supervision.actorRef(admitted)

      if (input.action === "list") {
        const snapshot = yield* control
          .list(runtimeTarget)
          .pipe(Effect.mapError(mapControlError))
        yield* authority.revalidate(admitted, "egress")
        const result = {
          sessionID: input.sessionID,
          permissions: snapshot.permissions,
          questions: snapshot.questions,
        }
        return {
          title: "OpenFork Session requests",
          output: JSON.stringify(result),
          structured: result,
          metadata: {
            permissions: snapshot.permissions.length,
            questions: snapshot.questions.length,
          },
        } satisfies OxpResult.CapabilityResult
      }

      if (!input.requestID) {
        return yield* new OxpError.InvalidArgument({
          detail: "openfork_request " + input.action + " requires requestID",
        })
      }

      if (input.action === "reply_permission") {
        if (!input.reply) {
          return yield* new OxpError.InvalidArgument({
            detail: "reply_permission requires reply",
          })
        }
        yield* control
          .replyPermission(runtimeTarget, {
            requestID: input.requestID,
            reply: input.reply,
            ...(input.message ? { message: input.message } : {}),
            actorRef,
          })
          .pipe(Effect.mapError(mapControlError))
      } else if (input.action === "answer_question") {
        if (!input.answers) {
          return yield* new OxpError.InvalidArgument({
            detail: "answer_question requires answers",
          })
        }
        yield* control
          .answerQuestion(runtimeTarget, {
            requestID: input.requestID,
            answers: input.answers,
            ...(input.details ? { details: input.details } : {}),
            actorRef,
          })
          .pipe(Effect.mapError(mapControlError))
      } else {
        yield* control
          .rejectQuestion(runtimeTarget, {
            requestID: input.requestID,
            actorRef,
          })
          .pipe(Effect.mapError(mapControlError))
      }

      return {
        title: "OpenFork Session request " + input.action,
        output: JSON.stringify({
          sessionID: input.sessionID,
          requestID: input.requestID,
          action: input.action,
        }),
        structured: {
          sessionID: input.sessionID,
          requestID: input.requestID,
          action: input.action,
        },
        mutation: { attempted: true, committed: true },
      } satisfies OxpResult.CapabilityResult
    })

    const execute: Interface["execute"] = (input, signal) =>
      executeRaw(input, signal).pipe(
        Effect.catch((error) =>
          OxpError.isError(error)
            ? Effect.fail(error)
            : Effect.fail(
                new OxpError.DependencyUnavailable({
                  detail: "OXP request-supervision operation failed",
                }),
              ),
        ),
      )

    return Service.of({ execute })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [OxpAuthority.node, OxpSupervision.node, OxpRequestControl.node],
})

export * as OxpRequest from "./request"
