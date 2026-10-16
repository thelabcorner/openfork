import { Effect, Schema } from "effect"
import { Tool } from "./tool"
import DESCRIPTION from "./task.txt"
import { ToolJsonSchema } from "./json-schema"
import * as SubagentDelegation from "../session/subagent-delegation"
import type { SessionPromptOps } from "../session/prompt-contract"

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
  attachments: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Optional symbolic handles for user uploads to deliver to this subagent's first model request. Only handles shown in the current attachment manifest, returned by an explicit session-index lookup, or already granted to a resumed worker are accepted; omitted or empty means no attachments.",
  }),
  model: Schema.optional(
    Schema.Struct({
      providerID: Schema.String.annotate({ description: "Provider ID exactly as shown in the model selector." }),
      modelID: Schema.String.annotate({ description: "Model ID exactly as shown in the model selector." }),
      accountID: Schema.optional(Schema.String).annotate({
        description: "Optional connected account ID when this provider has multiple accounts.",
      }),
      variant: Schema.optional(Schema.String).annotate({ description: "Optional model variant, such as high." }),
    }).annotate({
      description:
        "Optional model override for this subagent. Omit to inherit the model currently running the parent session turn.",
    }),
  ),
}

export const Parameters = Schema.Struct({
  ...BaseParameterFields,
  mode: Schema.optional(Schema.Literals(["foreground", "background", "supervisor"])).annotate({
    description:
      'Execution mode. "foreground" (default) blocks until the subagent finishes. "background" detaches and returns immediately; you are notified on completion and should not poll. "supervisor" also detaches but you REMAIN RESPONSIBLE: inspect progress and meaningful state changes, audit evidence rather than trusting final responses, steer blocked/drifting/duplicating workers, then own final integration and verification. Do not combine with `background`.',
  }),
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Legacy compatibility alias for mode. Omit/false to block in foreground; true to detach in background. Do not pass together with `mode`; prefer `mode`. This never creates a different kind of session.",
  }),
})

export const TaskTool = Tool.define(
  SubagentDelegation.ID,
  Effect.gen(function* () {
    const delegation = yield* SubagentDelegation.make

    return {
      description: [DESCRIPTION, SubagentDelegation.BACKGROUND_DESCRIPTION].join("\n\n"),
      parameters: Parameters,
      jsonSchema: ToolJsonSchema.fromSchema(Parameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) => {
        const promptOps = ctx.extra?.promptOps as SessionPromptOps | undefined
        if (!promptOps) {
          return Effect.die(new Error("TaskTool requires Session prompt control in ctx.extra"))
        }
        const rawAuthorized = ctx.extra?.authorizedAgentNames
        const authorizedAgentNames =
          rawAuthorized instanceof Set && [...rawAuthorized].every((value) => typeof value === "string")
            ? (rawAuthorized as ReadonlySet<string>)
            : undefined

        return delegation
          .execute(
            {
              description: params.description,
              prompt: params.prompt,
              subagentType: params.subagent_type,
              taskID: params.task_id,
              command: params.command,
              attachments: params.attachments,
              model: params.model,
              background: params.background,
              mode: params.mode,
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
          .pipe(Effect.orDie)
      },
    }
  }),
)
