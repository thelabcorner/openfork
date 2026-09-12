import { Tool } from "./tool"
import DESCRIPTION from "./task.txt"
import { ToolJsonSchema } from "./json-schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { Effect, Exit, Schema, Scope } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { Database } from "@opencode-ai/core/database/database"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<SessionV1.WithParts>
  dispatch?(
    input: SessionPrompt.PromptInput,
    options?: { wait?: boolean },
  ): Effect.Effect<{ admitted: SessionV1.WithParts; paused: boolean; result?: SessionV1.WithParts }>
}

const id = "task"
const BACKGROUND_DESCRIPTION = [
  "Foreground and background use the same child session, history, tools, and permissions; only parent waiting behavior changes.",
  "Foreground is the default and blocks until the child finishes. background=true detaches and returns immediately.",
  "A running background task can be foregrounded by calling task again with its task_id and no prompt.",
  "A running task can be re-prompted in the same session by supplying task_id and prompt; choose background=true to keep it detached or omit background to wait for the queued continuation.",
  "Use background only for independent work that can run while you continue elsewhere.",
  "You will be notified automatically when it finishes.",
  "When launching several independent background subagents, call this tool several times in the SAME assistant message.",
].join(" ")
const BACKGROUND_STARTED = [
  "The task is working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work ΓÇö avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
].join("\n")
const BACKGROUND_UPDATED = [
  "Additional context sent to the running background task.",
  "The task is still working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work ΓÇö avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you sent and end your response.",
].join("\n")

const BaseParameterFields = {
  description: Schema.String.annotate({
    description: "A short (3-5 words) description. Use a distinct description for each parallel subagent.",
  }),
  prompt: Schema.optional(Schema.String).annotate({
    description:
      "A complete standalone task for this subagent. Required for new work. Omit only when task_id names a currently running task and you only want to attach/foreground/background that existing run.",
  }),
  subagent_type: Schema.String.annotate({
    description:
      "The specialized agent type. For independent work, call this tool multiple times in the same assistant message, once per subagent, so they run in parallel.",
  }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
}

export const Parameters = Schema.Struct({
  ...BaseParameterFields,
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Execution mode for this invocation. Omit/false to block in foreground; true to detach in background. This never creates a different kind of session",
  }),
})

function renderOutput(input: {
  sessionID: SessionID
  state: "running" | "completed" | "error"
  summary?: string
  text: string
}) {
  const tag = input.state === "error" ? "task_error" : "task_result"
  const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  const safeText = input.text.replace(/<\/?(?:task|task_result|task_error)(?:\s|>)/gi, (match) =>
    match.replace("<", "&lt;").replace(">", "&gt;"),
  )
  return [
    `<task id="${escapeXml(input.sessionID)}" state="${input.state}">`,
    ...(input.summary ? [`<summary>${escapeXml(input.summary)}</summary>`] : []),
    `<${tag}>`,
    safeText,
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

const MAX_PARTIAL_CHARS = 600

function truncatePartial(text: string) {
  const clean = text.trim()
  if (clean.length <= MAX_PARTIAL_CHARS) return clean
  return `${clean.slice(0, MAX_PARTIAL_CHARS)}… [truncated]`
}

function lastTextPart(parts: SessionV1.WithParts["parts"]) {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]
    if (part?.type === "text" && part.text.trim() !== "") return part.text
  }
  return undefined
}

function resumeHint(sessionID: SessionID) {
  return [
    `Work completed so far is preserved in session ${sessionID}; do not redo it from scratch.`,
    `Resume that session with full context by calling task again with task_id "${sessionID}" and a continuation prompt, or inspect it with the session tool (action "messages", sessionId "${sessionID}").`,
  ].join(" ")
}

function failRecoverable(sessionID: SessionID, error: string, parts: SessionV1.WithParts["parts"]) {
  const text = lastTextPart(parts)
  const partial = text ? `\n\nPartial progress before failure:\n${truncatePartial(text)}` : ""
  return Effect.fail(
    new Error(`Subagent failed (task_id: ${sessionID}): ${error}${partial}\n\n${resumeHint(sessionID)}`),
  )
}

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const database = yield* Database.Service

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      const runInBackground = params.background === true
      const promptText = params.prompt?.trim() ? params.prompt : undefined

      const parent = yield* sessions.get(ctx.sessionID)
      let depth = 0
      let current = parent
      const visited = new Set<SessionID>([parent.id])
      while (current.parentID && depth < 64 && !visited.has(current.parentID)) {
        visited.add(current.parentID)
        depth++
        current = yield* sessions.get(current.parentID)
      }
      if (depth >= (cfg.subagent_depth ?? 1)) {
        return yield* Effect.fail(
          new Error(
            `Subagent depth limit reached (${cfg.subagent_depth ?? 1}). Increase "subagent_depth" to allow nested subagents.`,
          ),
        )
      }

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const next = yield* agent.get(params.subagent_type)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
      }

      const session = params.task_id
        ? yield* sessions.get(SessionID.make(params.task_id)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      if (params.task_id && !session) {
        return yield* Effect.fail(
          new Error(`Unknown task_id "${params.task_id}". Omit task_id to start a new subagent instead of duplicating work.`),
        )
      }
      if (session && session.parentID !== ctx.sessionID) {
        return yield* Effect.fail(new Error(`Task ${session.id} does not belong to parent session ${ctx.sessionID}.`))
      }
      if (session?.agent && session.agent !== next.name) {
        return yield* Effect.fail(
          new Error(
            `Task ${session.id} belongs to @${session.agent}; resume it with subagent_type "${session.agent}" instead of "${next.name}".`,
          ),
        )
      }
      if (!session && !promptText) {
        return yield* Effect.fail(new Error("prompt is required when starting a new subagent task."))
      }

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))

      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
      const variant = msg.info.variant
      const model = next.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }
      const childPermission = deriveSubagentSessionPermission({
        parentSessionPermission: parent.permission ?? [],
        subagent: next,
        autoApproveAsks: parent.agent === "yolo" || ctx.agent === "yolo",
      })
      const childToolDenies = [
        ...(next.permission.some((rule) => rule.permission === "todowrite")
          ? []
          : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
        ...(next.permission.some((rule) => rule.permission === id)
          ? []
          : [{ permission: id, pattern: "*" as const, action: "deny" as const }]),
        ...(cfg.experimental?.primary_tools?.map((permission) => ({
          permission,
          pattern: "*" as const,
          action: "deny" as const,
        })) ?? []),
      ]
      const nextSession =
        session ??
        (yield* sessions.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${next.name} subagent)`,
          agent: next.name,
          permission: [
            ...childPermission,
            ...childToolDenies.filter(
              (deny) =>
                !childPermission.some(
                  (rule) =>
                    rule.permission === deny.permission && rule.pattern === deny.pattern && rule.action === deny.action,
                ),
            ),
          ],
        }))

      const metadata = {
        parentSessionId: ctx.sessionID,
        sessionId: nextSession.id,
        model,
        background: runInBackground,
      }

      yield* ctx.metadata({
        title: params.description,
        metadata,
      })

      const runTask = Effect.fn("TaskTool.runTask")(function* (prompt: string) {
        const parts = yield* ops.resolvePromptParts(prompt)
        const result = yield* ops.prompt({
          messageID: MessageID.ascending(),
          sessionID: nextSession.id,
          model: {
            modelID: model.modelID,
            providerID: model.providerID,
          },
          variant: next.model ? undefined : variant,
          agent: next.name,
          parts,
        })
        if (result.info.role === "assistant" && result.info.error) {
          const message =
            "message" in result.info.error.data && typeof result.info.error.data.message === "string"
              ? result.info.error.data.message
              : result.info.error.name
          return yield* failRecoverable(nextSession.id, message, result.parts)
        }
        const failed = result.parts.findLast((item) => item.type === "tool" && item.state.status === "error")
        if (failed?.type === "tool" && failed.state.status === "error") {
          return yield* failRecoverable(nextSession.id, failed.state.error ?? "unknown tool error", result.parts)
        }
        return result.parts.findLast((item) => item.type === "text")?.text ?? ""
      })

      const childTail = Effect.fn("TaskTool.childTail")(function* (sessionID: SessionID) {
        const history = yield* sessions
          .messages({ sessionID })
          .pipe(Effect.catch(() => Effect.succeed([] as SessionV1.WithParts[])))
        for (let i = history.length - 1; i >= 0; i--) {
          const text = history[i] ? lastTextPart(history[i]!.parts) : undefined
          if (text) return truncatePartial(text)
        }
        return undefined
      })

      const inject = Effect.fn("TaskTool.injectBackgroundResult")(function* (
        state: "completed" | "error",
        text: string,
      ) {
        const currentParent = yield* sessions.get(ctx.sessionID)
        yield* ops
          .prompt({
            sessionID: ctx.sessionID,
            agent: currentParent.agent ?? ctx.agent,
            variant,
            parts: [
              {
                type: "text",
                synthetic: true,
                text: renderOutput({
                  sessionID: nextSession.id,
                  state,
                  summary:
                    state === "completed"
                      ? `Background task completed: ${params.description}`
                      : `Background task failed: ${params.description}`,
                  text,
                }),
              },
            ],
          })
          .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
      })

      const notify = Effect.fn("TaskTool.notifyBackgroundResult")(function* (jobID: string) {
        yield* background.wait({ id: jobID }).pipe(
          Effect.flatMap((result) =>
            Effect.gen(function* () {
              const completed = result.info
              if (!completed) return
              const latest = yield* background.get(jobID)
              const stillSameGeneration =
                completed.generation !== undefined && latest?.generation === completed.generation
              const backgroundAtDelivery = stillSameGeneration
                ? latest?.metadata?.background === true
                : completed.metadata?.background === true
              if (!backgroundAtDelivery) return
              if (completed.status === "completed") return yield* inject("completed", completed.output ?? "")
              if (completed.status === "error") return yield* inject("error", completed.error ?? "")
            }),
          ),
          Effect.forkIn(scope, { startImmediately: true }),
        )
      })

      function backgroundResult(summary: string, text: string) {
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: nextSession.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary,
            text,
          }),
        }
      }

      const promotionMetadata = ctx.metadata({
        title: params.description,
        metadata: { ...metadata, background: true, jobId: nextSession.id },
      })

      const waitForeground = Effect.fn("TaskTool.waitForeground")(function* () {
        const runCancel = yield* EffectBridge.make()
        const cancel = ops.cancel(nextSession.id)

        function onAbort() {
          runCancel.fork(cancel)
        }

        return yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            ctx.abort.addEventListener("abort", onAbort)
            if (ctx.abort.aborted) onAbort()
          }),
          () =>
            Effect.gen(function* () {
              const result = yield* Effect.raceFirst(
                background.wait({ id: nextSession.id }).pipe(Effect.map((waited) => waited.info)),
                background.waitForPromotion(nextSession.id),
              )
              if (!result) return yield* Effect.fail(new Error(`Subagent job disappeared (task_id: ${nextSession.id}).`))
              if (result.metadata?.background === true) {
                return backgroundResult("Task moved to background", BACKGROUND_STARTED)
              }
              if (result.status === "error") return yield* Effect.fail(new Error(result.error ?? "Task failed"))
              if (result.status === "cancelled") {
                const tail = yield* childTail(nextSession.id)
                const partial = tail ? `\n\nPartial progress before cancellation:\n${tail}` : ""
                return yield* Effect.fail(
                  new Error(`Task cancelled (task_id: ${nextSession.id}).${partial}\n\n${resumeHint(nextSession.id)}`),
                )
              }
              return {
                title: params.description,
                metadata: { ...metadata, background: false },
                output: renderOutput({ sessionID: nextSession.id, state: "completed", text: result.output ?? "" }),
              }
            }),
          (_, exit) =>
            Effect.gen(function* () {
              if (Exit.hasInterrupts(exit))
                yield* Effect.all([cancel, background.cancel(nextSession.id)], { discard: true })
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  ctx.abort.removeEventListener("abort", onAbort)
                }),
              ),
            ),
        )
      })

      const existingJob = yield* background.get(nextSession.id)
      if (existingJob?.status === "running") {
        if (existingJob.type !== id) {
          return yield* Effect.fail(new Error(`Task session ${nextSession.id} is owned by running ${existingJob.type} job.`))
        }

        if (runInBackground) {
          const detached =
            existingJob.metadata?.background === true ? existingJob : yield* background.promote(nextSession.id)
          if (detached?.status === "running") {
            if (!promptText) return backgroundResult("Task running in background", BACKGROUND_STARTED)
            const extended = yield* background.extend({
              id: nextSession.id,
              run: runTask(promptText).pipe(Effect.onInterrupt(() => ops.cancel(nextSession.id))),
            })
            if (extended) return backgroundResult("Background task updated", BACKGROUND_UPDATED)
          }
        } else {
          const attached = yield* background.foreground(nextSession.id, promotionMetadata)
          if (attached?.status === "running") {
            if (!promptText) return yield* waitForeground()
            const extended = yield* background.extend({
              id: nextSession.id,
              run: runTask(promptText).pipe(Effect.onInterrupt(() => ops.cancel(nextSession.id))),
            })
            if (extended) return yield* waitForeground()
          }
        }
      }

      if (!promptText) {
        const previous = yield* background.get(nextSession.id)
        if (previous?.status === "completed") {
          if (previous.metadata?.background === true) yield* background.foreground(nextSession.id)
          return {
            title: params.description,
            metadata: { ...metadata, background: false },
            output: renderOutput({ sessionID: nextSession.id, state: "completed", text: previous.output ?? "" }),
          }
        }
        if (previous?.status === "error") {
          if (previous.metadata?.background === true) yield* background.foreground(nextSession.id)
          return yield* Effect.fail(new Error(previous.error ?? "Task failed"))
        }
        return yield* Effect.fail(
          new Error(
            params.task_id
              ? `Task ${nextSession.id} is not currently running; provide prompt to continue that child session.`
              : "prompt is required when starting a new subagent task.",
          ),
        )
      }

      const runPrompt = () => runTask(promptText).pipe(Effect.onInterrupt(() => ops.cancel(nextSession.id)))
      while (true) {
        const attempt = yield* background.tryStart({
          id: nextSession.id,
          type: id,
          title: params.description,
          metadata,
          onPromote: promotionMetadata,
          continueOnFailure: true,
          run: runPrompt(),
        })
        if (attempt.started) {
          yield* notify(attempt.info.id)
          if (runInBackground) return backgroundResult("Background task started", BACKGROUND_STARTED)
          return yield* waitForeground()
        }
        if (attempt.info.type !== id) {
          return yield* Effect.fail(
            new Error(`Task session ${nextSession.id} is owned by running ${attempt.info.type} job.`),
          )
        }

        if (runInBackground) {
          const detached =
            attempt.info.metadata?.background === true ? attempt.info : yield* background.promote(nextSession.id)
          if (detached?.status !== "running") continue
          if (yield* background.extend({ id: nextSession.id, run: runPrompt() })) {
            return backgroundResult("Background task updated", BACKGROUND_UPDATED)
          }
          continue
        }

        const attached = yield* background.foreground(nextSession.id, promotionMetadata)
        if (attached?.status !== "running") continue
        if (yield* background.extend({ id: nextSession.id, run: runPrompt() })) {
          return yield* waitForeground()
        }
      }
    })

    return {
      description: [DESCRIPTION, BACKGROUND_DESCRIPTION].join("\n\n"),
      parameters: Parameters,
      jsonSchema: ToolJsonSchema.fromSchema(Parameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
