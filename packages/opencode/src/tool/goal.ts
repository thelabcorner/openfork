import { Effect } from "effect"
import { GoalAgent } from "@opencode-ai/core/goal/agent"
import * as Tool from "./tool"

function turnProvenance(messages: readonly import("@opencode-ai/core/v1/session").SessionV1.WithParts[]) {
  const userIndex = messages.findLastIndex((message) => message.info.role === "user")
  if (userIndex < 0) return undefined
  const user = messages[userIndex]
  if (!user || user.info.role !== "user") return undefined
  const userText = user.parts
    .filter((part) => part.type === "text" && part.synthetic !== true)
    .map((part) => part.text)
    .join("\n")
    .trim()
  const previous = messages.slice(0, userIndex).findLast((message) => message.info.role === "assistant")
  const previousAssistantText = previous
    ? previous.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim()
    : ""
  return {
    userMessageID: String(user.info.id),
    userText,
    ...(previousAssistantText ? { previousAssistantText } : {}),
  }
}

type Metadata = {
  action: string
  goalID?: string
  revision?: number
  status?: string
}

export const GoalTool = Tool.define<
  typeof GoalAgent.Input,
  Metadata,
  GoalAgent.Service
>(
  "goal",
  Effect.gen(function* () {
    const goal = yield* GoalAgent.Service
    return {
      description: [
        "Create, inspect, and advance durable Goals for this Session.",
        "Use create only when the current user explicitly asks for Goal creation/setup/start, or has just confirmed your Goal-creation proposal. If you think a Goal would help but the user did not request one, ask first; the host enforces this boundary.",
        "create derives project/workspace ownership from the Session, focuses the Goal, starts it by default, defaults to auto_continue, and requires an objective plus at least one acceptance criterion.",
        "Use start=false for an explicitly requested draft/no-start Goal. Use continuationMode=unattended only when the user explicitly requests unattended Goal mode; the host rejects unattended escalation otherwise.",
        "Use status, progress, add_evidence, block, request_verification, claim_step, release_step, or verifier-only verify for an existing Goal.",
        "Goal cancellation, objective edits, completion bypasses, and automation-policy changes are user-owned and unavailable here.",
      ].join(" "),
      parameters: GoalAgent.Input,
      execute: (input, ctx) =>
        goal.execute(ctx.sessionID, input, turnProvenance(ctx.messages)).pipe(
          Effect.map((result) => ({
            title: `Goal ${input.action}`,
            output: JSON.stringify(result),
            metadata: {
              action: input.action,
              goalID: result.goal.goal.id,
              revision: result.goal.goal.revision,
              status: result.goal.goal.status,
            },
          })),
          Effect.orDie,
        ),
    }
  }),
)
