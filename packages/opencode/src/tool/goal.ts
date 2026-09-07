import { Effect } from "effect"
import { GoalAgent } from "@opencode-ai/core/goal/agent"
import * as Tool from "./tool"

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
        "Inspect and advance the durable Goal focused on this Session.",
        "Use status, progress, add_evidence, block, request_verification, claim_step, release_step, or verifier-only verify.",
        "Goal cancellation, objective edits, completion bypasses, and automation-policy changes are user-owned and unavailable here.",
      ].join(" "),
      parameters: GoalAgent.Input,
      execute: (input, ctx) =>
        goal.execute(ctx.sessionID, input).pipe(
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
