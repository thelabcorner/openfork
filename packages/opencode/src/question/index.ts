import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Deferred, Effect, Layer, Schema, Context } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { SessionID } from "@/session/schema"
import { QuestionID } from "./schema"
import { EventV2Bridge } from "@/event-v2-bridge"
import { QuestionV1 } from "@opencode-ai/schema/question-v1"
import { QuestionV2 } from "@opencode-ai/core/question"
import type { ExternalActor } from "@/session/external-actor"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { PendingResponseRegistry } from "@/server/pending-response-registry"

export const Option = QuestionV1.Option
export type Option = typeof Option.Type
export const Info = QuestionV1.Info
export type Info = typeof Info.Type
export const Prompt = QuestionV1.Prompt
export type Prompt = typeof Prompt.Type
export const Tool = QuestionV1.Tool
export type Tool = typeof Tool.Type
export const Request = QuestionV1.Request
export type Request = typeof Request.Type
export const Answer = QuestionV1.Answer
export type Answer = typeof Answer.Type
export const Reply = QuestionV1.Reply
export type Reply = typeof Reply.Type
export const Replied = QuestionV1.Replied
export const Rejected = QuestionV1.Rejected
export const Event = QuestionV1.Event
export type Resolved = QuestionV2.Resolved

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("QuestionRejectedError", {}) {
  override get message() {
    return "The user dismissed this question"
  }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Question.NotFoundError", {
  requestID: QuestionID,
}) {}

interface PendingEntry {
  info: Request
  deferred: Deferred.Deferred<Resolved, RejectedError>
  settling?: boolean
}

interface State {
  pending: Map<QuestionID, PendingEntry>
}

// Service

export interface Interface {
  readonly ask: (input: {
    sessionID: SessionID
    questions: ReadonlyArray<Info>
    tool?: Tool
  }) => Effect.Effect<ReadonlyArray<Answer>, RejectedError>
  readonly askDetailed: (input: {
    sessionID: SessionID
    questions: ReadonlyArray<Info>
    tool?: Tool
  }) => Effect.Effect<Resolved, RejectedError>
  readonly reply: (input: {
    requestID: QuestionID
    answers: ReadonlyArray<Answer>
    details?: ReadonlyArray<string>
    actor?: ExternalActor.Ref
  }) => Effect.Effect<void, NotFoundError>
  readonly reject: (
    requestID: QuestionID,
    actor?: ExternalActor.Ref,
  ) => Effect.Effect<void, NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Question") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const responses = yield* PendingResponseRegistry.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Question.state")(function* () {
        const state = {
          pending: new Map<QuestionID, PendingEntry>(),
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new RejectedError())
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    const askDetailed = Effect.fn("Question.askDetailed")(function* (input: {
      sessionID: SessionID
      questions: ReadonlyArray<Info>
      tool?: Tool
    }) {
      if (input.questions.length === 0) return { answers: [], details: [] } satisfies Resolved
      const pending = (yield* InstanceState.get(state)).pending
      const id = QuestionID.ascending()
      yield* Effect.logInfo("asking", { id, questions: input.questions.length })

      const deferred = yield* Deferred.make<Resolved, RejectedError>()
      const info: Request = {
        id,
        sessionID: input.sessionID,
        questions: input.questions,
        tool: input.tool,
      }
      const entry = { info, deferred }
      pending.set(id, entry)
      const context = yield* InstanceState.context
      const unregister = yield* responses.register({
        kind: "question",
        requestID: id,
        sessionID: info.sessionID,
        directory: FSUtil.resolve(context.directory),
        snapshot: info,
        settle: (payload) => {
          const action = payload as
            | { type: "reply"; input: Parameters<Interface["reply"]>[0] }
            | { type: "reject"; actor?: ExternalActor.Ref }
          return (action.type === "reply"
            ? reply(action.input)
            : reject(id, action.actor)
          ).pipe(
            Effect.provideService(InstanceRef, context),
            Effect.catchTag("Question.NotFoundError", () =>
              Effect.fail(new PendingResponseRegistry.NotFoundError({ requestID: id })),
            ),
          )
        },
      })

      return yield* Effect.ensuring(
        events.publish(Event.Asked, info).pipe(Effect.andThen(Deferred.await(deferred))),
        Effect.sync(() => {
            if (pending.get(id) === entry) pending.delete(id)
          }).pipe(Effect.andThen(unregister)),
      )
    })

    const ask = Effect.fn("Question.ask")((input: {
      sessionID: SessionID
      questions: ReadonlyArray<Info>
      tool?: Tool
    }) => askDetailed(input).pipe(Effect.map(QuestionV2.flattenResolved)))

    const reply = Effect.fn("Question.reply")(function* (input: {
      requestID: QuestionID
      answers: ReadonlyArray<Answer>
      details?: ReadonlyArray<string>
      actor?: ExternalActor.Ref
    }) {
      const pending = (yield* InstanceState.get(state)).pending
      const context = yield* InstanceState.context
      const workspaceID = yield* WorkspaceRef
      const notify = (effect: Effect.Effect<void, unknown>) =>
        responses.notify(
          effect.pipe(Effect.provideService(InstanceRef, context), Effect.provideService(WorkspaceRef, workspaceID)),
          FSUtil.resolve(context.directory),
        )
      const existing = pending.get(input.requestID)
      if (!existing) {
        yield* Effect.logWarning("reply for unknown request", { requestID: input.requestID })
        return yield* new NotFoundError({ requestID: input.requestID })
      }
      if (existing.settling) return yield* new NotFoundError({ requestID: input.requestID })
      existing.settling = true
      const resolved = QuestionV2.normalizeReply(existing.info.questions, input)
      yield* Effect.logInfo("replied", { requestID: input.requestID, answers: resolved.answers, details: resolved.details })
      pending.delete(input.requestID)
      yield* Deferred.succeed(existing.deferred, resolved)
      yield* notify(events
        .publish(Event.Replied, {
          sessionID: existing.info.sessionID,
          requestID: existing.info.id,
          answers: QuestionV2.flattenResolved(resolved).map((answer) => [...answer]),
          details: [...resolved.details],
        }, input.actor ? { metadata: { actor: input.actor } } : undefined))
    })

    const reject = Effect.fn("Question.reject")(function* (
      requestID: QuestionID,
      actor?: ExternalActor.Ref,
    ) {
      const pending = (yield* InstanceState.get(state)).pending
      const context = yield* InstanceState.context
      const workspaceID = yield* WorkspaceRef
      const notify = (effect: Effect.Effect<void, unknown>) =>
        responses.notify(
          effect.pipe(Effect.provideService(InstanceRef, context), Effect.provideService(WorkspaceRef, workspaceID)),
          FSUtil.resolve(context.directory),
        )
      const existing = pending.get(requestID)
      if (!existing) {
        yield* Effect.logWarning("reject for unknown request", { requestID })
        return yield* new NotFoundError({ requestID })
      }
      if (existing.settling) return yield* new NotFoundError({ requestID })
      existing.settling = true
      yield* Effect.logInfo("rejected", { requestID })
      pending.delete(requestID)
      yield* Deferred.fail(existing.deferred, new RejectedError())
      yield* notify(events
        .publish(Event.Rejected, {
          sessionID: existing.info.sessionID,
          requestID: existing.info.id,
        }, actor ? { metadata: { actor } } : undefined))
    })

    const list = Effect.fn("Question.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (x) => x.info)
    })

    return Service.of({ ask, askDetailed, reply, reject, list })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [EventV2Bridge.node, PendingResponseRegistry.node],
})

export * as Question from "."
