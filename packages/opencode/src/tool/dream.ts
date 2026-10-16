import { Effect, Schema, Scope } from "effect"
import * as Tool from "./tool"
import { DreamerRuntime } from "@/special-agent/dreamer-runtime"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Database } from "@opencode-ai/core/database/database"
import type { SessionPromptOps } from "@/session/prompt-contract"
import DESCRIPTION from "./dream.txt"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["start", "resume", "status", "cancel"]).annotate({
    description: "Start, resume, inspect or cancel an owned background investigation; status and cancel launch no provider turns.",
  }),
  focus: Schema.optional(Schema.String.check(Schema.isMaxLength(6000))).annotate({
    description: "Historical question or consolidation focus; required for start.",
  }),
  task_id: Schema.optional(Schema.String).annotate({
    description: "Existing Dreamer child Session ID; required for resume, status and cancel.",
  }),
})

export type Metadata = {
  readonly action: "start" | "resume" | "status" | "cancel"
  readonly agent: "dreamer"
  readonly background: boolean
  readonly sessionId: SessionID
  readonly jobId?: string
  readonly status?: string
  readonly [key: string]: unknown
}

export const DreamTool = Tool.define<
  typeof Parameters,
  Metadata,
  Agent.Service | BackgroundJob.Service | Config.Service | Session.Service | Scope.Scope | Database.Service
>(
  "dream",
  Effect.gen(function* () {
    const dreamerRuntime = yield* DreamerRuntime.make
    const sessions = yield* Session.Service
    const jobs = yield* BackgroundJob.Service
    return {
      exposure: "lazy" as const,
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (ctx.agent === "dreamer")
            return yield* new Tool.InvalidArgumentsError({
              tool: "dream", detail: "Dreamer cannot spawn or resume other Dreamer agents",
            })
          const focus = params.focus?.trim()
          if (params.action === "start" && (!focus || params.task_id))
            return yield* new Tool.InvalidArgumentsError({
              tool: "dream", detail: "start requires nonempty focus and no task_id",
            })
           if (params.action === "resume" && !params.task_id)
             return yield* new Tool.InvalidArgumentsError({
               tool: "dream", detail: "resume requires task_id",
             })
            if (params.action === "status" || params.action === "cancel") {
              if (!params.task_id || focus)
                return yield* new Tool.InvalidArgumentsError({
                  tool: "dream", detail: `${params.action} requires task_id and cannot accept focus`,
               })
             const parent = yield* sessions.get(ctx.sessionID)
             const child = yield* sessions.get(SessionID.make(params.task_id)).pipe(
               Effect.catchCause(() => Effect.succeed(undefined)),
             )
             if (!child || child.parentID !== parent.id || child.projectID !== parent.projectID ||
                 child.workspaceID !== parent.workspaceID || child.agent !== "dreamer")
               return yield* new Tool.InvalidArgumentsError({
                 tool: "dream", detail: "No Dreamer child owned by this calling Session has that task_id",
               })
             // BackgroundJob is a process-local registry. A persisted child
             // without a live job record is NOT evidence of completion.
             const live = yield* jobs.get(child.id)
             const job = live?.type === "task" &&
               live.metadata?.sessionId === child.id &&
               live.metadata?.parentSessionId === parent.id ? live : undefined
              // Cancellation goes through the existing Task BackgroundJob
              // cancellation owner. A missing process-local handle is NOT
              // permission to fabricate a successful cancellation.
              const cancelled = params.action === "cancel" && job?.status === "running"
                ? yield* jobs.cancel(child.id)
                : undefined
              const observed = params.action === "cancel" ? (cancelled ?? (yield* jobs.get(child.id))) : job
              const current = observed?.type === "task" && observed.metadata?.sessionId === child.id &&
                observed.metadata?.parentSessionId === parent.id ? observed : undefined
              const status = current?.status ?? "not_in_process"
               const result = {
                 task_id: child.id,
                 status,
                 // These are producer-owned, durable Session metadata. They
                 // remain useful after a process restart, but are not a live
                 // worker heartbeat or evidence that an investigation finished.
                 persistedSession: {
                   createdAt: child.time.created,
                   recordUpdatedAt: child.time.updated,
                   recordUpdatedAtBasis: "session_record" as const,
                   note: "Session-record updates can reflect metadata changes, not completed model work.",
                 },
                ...(params.action === "cancel" ? { cancellation: status === "cancelled" ? "cancelled" : "not_cancelled" } : {}),
                ...(current ? {
                  started_at: current.started_at,
                  ...(current.completed_at ? { completed_at: current.completed_at } : {}),
                  ...(current.generation !== undefined ? { generation: current.generation } : {}),
                  ...(current.error ? { error: current.error.slice(0, 2000) } : {}),
                  ...(current.status === "completed" ? { resultAvailableInChildSession: true } : {}),
                } : {
                  explanation: "The child Session persists, but no job exists in this process. Its execution outcome cannot be inferred or cancelled here. Inspect child Session history before resuming.",
                }),
              }
              return {
                title: `Dreamer ${params.action}: ${status}`,
                output: JSON.stringify(result),
                 metadata: { action: params.action, agent: "dreamer" as const, sessionId: child.id, background: status === "running", status },
             }
           }
           const promptOps = ctx.extra?.promptOps as SessionPromptOps | undefined
          if (!promptOps)
            return yield* new Tool.InvalidArgumentsError({
              tool: "dream", detail: "Requires the real calling Session's prompt-control context",
            })
          const rawAuthorized = ctx.extra?.authorizedAgentNames
          const authorizedAgentNames =
            rawAuthorized instanceof Set && [...rawAuthorized].every((item) => typeof item === "string")
              ? rawAuthorized as ReadonlySet<string>
              : undefined
          const result = yield* dreamerRuntime.launch(
            {
              focus,
              taskID: params.action === "resume" ? params.task_id : undefined,
            },
            {
              parentSessionID: ctx.sessionID,
              assistantMessageID: ctx.messageID,
              toolCallID: ctx.callID,
              parentAgent: ctx.agent,
              abort: ctx.abort,
              messages: ctx.messages,
              authorizedAgentNames,
              promptOps,
              metadata: ctx.metadata,
              ask: ctx.ask,
            },
          )
          return {
            title: result.title,
            output: result.output,
            metadata: {
              ...result.metadata,
              sessionId: SessionID.make(result.metadata.sessionId),
              action: params.action,
              agent: "dreamer" as const,
              background: true as const,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)