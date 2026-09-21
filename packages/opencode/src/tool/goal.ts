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
        "create derives project/workspace ownership from the Session, focuses the Goal, starts it by default, defaults to auto_continue, and requires an objective plus at least one acceptance criterion.",
        "Use start=false for an explicitly requested draft/no-start Goal. Use continuationMode=unattended only when the user explicitly requests unattended Goal mode; the host rejects unattended escalation otherwise.",
        "Use update when the current human user turn explicitly asks to revise, strengthen, extend, or otherwise change the focused Goal. For update, title/objective replace those scalar fields while constraints/criteria/steps are append-only additions; duplicates are ignored and existing child IDs, progress, assignments, and evidence are preserved. Never call create merely to update an existing Goal.",
        "Use status, progress, add_evidence, block, request_verification, claim_step, release_step, or verifier-only verify for other existing-Goal work.",
        "Goal cancellation, completion bypasses, and automation-policy changes remain user-owned and unavailable here. Specification edits are available only through update with explicit current-turn human direction.",
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
