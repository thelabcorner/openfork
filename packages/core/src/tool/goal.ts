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
  "Inspect and advance the durable Goal focused on this Session.",
  "Use status to refresh Goal state, progress/add_evidence to record concrete progress, claim_step/release_step for scoped work, block when genuinely blocked, and request_verification when acceptance criteria are ready to be checked.",
  "You cannot cancel Goals, rewrite their objective, change automation policy, or directly mark them completed. verify is only accepted from a Session focused with verifier role.",
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
                resources: ["*"],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              .pipe(
                Effect.mapError(() => new ToolFailure({ message: "Permission denied: goal" })),
                Effect.andThen(goal.execute(context.sessionID, input).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message })))),
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
