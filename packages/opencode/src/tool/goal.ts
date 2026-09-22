import { Effect } from "effect"
import { GoalAgent } from "@opencode-ai/core/goal/agent"
import * as Tool from "./tool"
import { currentWithHistory as currentUserActionTurn } from "./user-action-turn"

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
        "Use create when the current or a recent unrevoked human user turn explicitly asked for Goal creation/setup/start, or confirmed your Goal-creation proposal. You do not need to wait for the exact turn containing the Goal request; the host carries bounded human authorization history forward. A newer explicit rejection revokes older consent. If the user never requested a Goal, ask first.",
        "create derives project/workspace ownership from the Session, focuses the Goal, starts it by default, and requires an objective plus at least one acceptance criterion. Goal Mode has one execution behavior: after each settled worker cycle the host runs an independent audit and continues automatically until the Goal is verified complete, explicitly blocked, cancelled, failed, or an opt-in execution bound is reached.",
        "Use start=false only for an explicitly requested draft/no-start Goal.",
        "Use update when the current human user turn explicitly asks to revise, strengthen, extend, or otherwise change the focused Goal. For update, title/objective replace those scalar fields while constraints/criteria/steps are append-only additions; duplicates are ignored and existing child IDs, progress, assignments, and evidence are preserved. Never call create merely to update an existing Goal.",
        "Current Goal specification/progress is already projected into the conversation. Do not call status as routine refresh or after ordinary work. Use progress/add_evidence only for meaningful durable milestones, preferably batched; claim_step/release_step only when ownership matters; block only for a real external/user dependency; request_verification only when acceptance criteria are actually ready.",
        "Do not call this tool just because a turn starts or ends. Goal Mode automatically runs independent audits after settled worker cycles; request_verification is not required as end-of-turn bookkeeping.",
        "A genuine new user turn automatically reactivates a focused blocked Goal; do not call this tool just to resume it.",
        "Goal cancellation, completion bypasses, and execution-bound changes remain user-owned and unavailable here. Specification edits are available only through update with explicit current-turn human direction.",
      ].join(" "),
      parameters: GoalAgent.Input,
      execute: (input, ctx) =>
        goal.execute(ctx.sessionID, input, currentUserActionTurn(ctx.messages)).pipe(
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
