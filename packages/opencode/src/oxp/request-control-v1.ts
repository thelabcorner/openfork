import { Effect, Layer } from "effect"
import { SessionTurnProvenance } from "@opencode-ai/schema/session-turn-provenance"
import { OxpRequestControl } from "./request-control"
import { OxpRuntimeV1 } from "./runtime-v1"

async function runtimeModules() {
  const [{ Permission }, { PermissionV1 }, { Question }, { QuestionID }] =
    await Promise.all([
      import("@/permission"),
      import("@opencode-ai/core/v1/permission"),
      import("@/question"),
      import("@/question/schema"),
    ])
  return { Permission, PermissionV1, Question, QuestionID }
}

const enter = <A>(
  target: OxpRequestControl.Target,
  build: (
    runtime: Awaited<ReturnType<typeof runtimeModules>>,
  ) => Effect.Effect<A, unknown, any>,
) =>
  OxpRuntimeV1.enter(
    target,
    async () => build(await runtimeModules()),
    "Native Permission/Question supervision failed",
  )

const actor = (ref: string) => ({
  type: "external" as const,
  source: SessionTurnProvenance.Source.OxpSupervisor,
  ref,
})

const list: OxpRequestControl.Interface["list"] = (target) =>
  enter(
    target,
    (runtime) =>
      Effect.gen(function* () {
        const permissions = yield* runtime.Permission.Service
        const questions = yield* runtime.Question.Service
        const [permissionRows, questionRows] = yield* Effect.all(
          [permissions.list(), questions.list()],
          { concurrency: 2 },
        )
        return {
          permissions: permissionRows
            .filter((row) => row.sessionID === target.sessionID)
            .map((row) => ({
              type: "permission" as const,
              id: String(row.id),
              permission: row.permission,
              // external_directory is by definition outside the addressed
              // Session root. Do not leak that native path over OXP.
              patterns:
                row.permission === "external_directory"
                  ? []
                  : [...row.patterns],
              externalDirectory: row.permission === "external_directory",
              ...(row.tool
                ? {
                    tool: {
                      messageID: String(row.tool.messageID),
                      callID: row.tool.callID,
                    },
                  }
                : {}),
            })),
          questions: questionRows
            .filter((row) => row.sessionID === target.sessionID)
            .map((row) => ({
              type: "question" as const,
              id: String(row.id),
              questions: row.questions.map((question) => ({
                question: question.question,
                header: question.header,
                options: question.options.map((option) => ({
                  label: option.label,
                  description: option.description,
                })),
                ...(question.multiple !== undefined
                  ? { multiple: question.multiple }
                  : {}),
                ...(question.custom !== undefined
                  ? { custom: question.custom }
                  : {}),
              })),
              ...(row.tool
                ? {
                    tool: {
                      messageID: String(row.tool.messageID),
                      callID: row.tool.callID,
                    },
                  }
                : {}),
            })),
        }
      }),
  )

const replyPermission: OxpRequestControl.Interface["replyPermission"] = (
  target,
  input,
) =>
  enter(
    target,
    (runtime) =>
      Effect.gen(function* () {
        const permission = yield* runtime.Permission.Service
        const request = (yield* permission.list()).find(
          (row) =>
            row.id === input.requestID && row.sessionID === target.sessionID,
        )
        if (!request) {
          return yield* Effect.fail(new OxpRequestControl.RequestNotFound())
        }
        if (
          request.permission === "external_directory" &&
          input.reply !== "reject"
        ) {
          return yield* Effect.fail(
            new OxpRequestControl.ExternalDirectoryBlocked(),
          )
        }
        yield* OxpRuntimeV1.commitGuard(
          target,
          "OXP request-supervision authority revalidation failed",
        )
        yield* permission.reply({
          requestID: runtime.PermissionV1.ID.make(input.requestID),
          reply: input.reply,
          ...(input.message ? { message: input.message } : {}),
          actor: actor(input.actorRef),
        }).pipe(
          Effect.catchIf(
            (error) => error instanceof runtime.PermissionV1.NotFoundError,
            () => Effect.fail(new OxpRequestControl.RequestNotFound()),
          ),
        )
      }),
  )

const answerQuestion: OxpRequestControl.Interface["answerQuestion"] = (
  target,
  input,
) =>
  enter(
    target,
    (runtime) =>
      Effect.gen(function* () {
        const question = yield* runtime.Question.Service
        const request = (yield* question.list()).find(
          (row) =>
            row.id === input.requestID && row.sessionID === target.sessionID,
        )
        if (!request) {
          return yield* Effect.fail(new OxpRequestControl.RequestNotFound())
        }
        yield* OxpRuntimeV1.commitGuard(
          target,
          "OXP request-supervision authority revalidation failed",
        )
        yield* question.reply({
          requestID: runtime.QuestionID.ascending(input.requestID),
          answers: input.answers.map((answer) => [...answer]),
          ...(input.details ? { details: [...input.details] } : {}),
          actor: actor(input.actorRef),
        }).pipe(
          Effect.catchIf(
            (error) => error instanceof runtime.Question.NotFoundError,
            () => Effect.fail(new OxpRequestControl.RequestNotFound()),
          ),
        )
      }),
  )

const rejectQuestion: OxpRequestControl.Interface["rejectQuestion"] = (
  target,
  input,
) =>
  enter(
    target,
    (runtime) =>
      Effect.gen(function* () {
        const question = yield* runtime.Question.Service
        const request = (yield* question.list()).find(
          (row) =>
            row.id === input.requestID && row.sessionID === target.sessionID,
        )
        if (!request) {
          return yield* Effect.fail(new OxpRequestControl.RequestNotFound())
        }
        yield* OxpRuntimeV1.commitGuard(
          target,
          "OXP request-supervision authority revalidation failed",
        )
        yield* question.reject(
          runtime.QuestionID.ascending(input.requestID),
          actor(input.actorRef),
        ).pipe(
          Effect.catchIf(
            (error) => error instanceof runtime.Question.NotFoundError,
            () => Effect.fail(new OxpRequestControl.RequestNotFound()),
          ),
        )
      }),
  )

export const layer = Layer.succeed(
  OxpRequestControl.Service,
  OxpRequestControl.Service.of({
    list,
    replyPermission,
    answerQuestion,
    rejectQuestion,
  }),
)

export * as OxpRequestControlV1 from "./request-control-v1"
