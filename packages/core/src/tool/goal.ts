export * as GoalTool from "./goal"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { GoalAgent } from "../goal/agent"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "goal"

export const description = [
  "Create, inspect, and advance durable Goals for this Session.",
  "Use create only when the current user explicitly asks you to create/set up/start a Goal, or has just confirmed your Goal-creation proposal. If you think a Goal would help but the user did not request one, ask first; the host enforces this boundary.",
  "create derives project/workspace ownership from the current Session, focuses the new Goal, and starts it by default. Goal Mode has one execution behavior: after each settled worker cycle the host runs an independent audit and continues automatically until the Goal is verified complete, explicitly blocked, cancelled, failed, or an opt-in execution bound is reached.",
  "Use start=false only when the user asks for a draft or explicitly says not to start it.",
  "Current Goal specification/progress is already projected into the conversation. Do not call status as routine refresh or after ordinary work. Use progress/add_evidence only for meaningful durable milestones, preferably batched; claim_step/release_step only when ownership matters; block only for a real external/user dependency; request_verification when acceptance criteria are actually ready.",
  "Do not call this tool just because a turn starts or ends. Goal Mode automatically runs independent audits after settled worker cycles; request_verification is not required as end-of-turn bookkeeping.",
  "A genuine new user turn automatically reactivates a focused blocked Goal; do not call this tool just to resume it.",
  "You cannot cancel Goals, rewrite their objective, change execution bounds, or directly mark them completed. verify is only accepted from a Session focused with verifier role.",
].join(" ")

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const goal = yield* GoalAgent.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description,
          input: GoalAgent.Input,
          output: GoalAgent.Output,
          toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output) }],
          execute: (input, context) =>
            permission
              .assert({
                action: name,
                resources: [input.action === "create" ? "create" : "*"],
                save: [input.action === "create" ? "create" : "*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              .pipe(
                Effect.mapError(() => new ToolFailure({ message: "Permission denied: goal" })),
                Effect.andThen(
                  goal
                    .execute(context.sessionID, input, context.userTurn)
                    .pipe(Effect.mapError((error) => new ToolFailure({ message: error.message }))),
                ),
              ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/goal",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, GoalAgent.node],
})
