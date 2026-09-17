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
  "create derives project/workspace ownership from the current Session, focuses the new Goal, starts it by default, and defaults continuation to auto_continue. Supply a concrete objective and at least one acceptance criterion.",
  "Use start=false when the user asks for a draft or explicitly says not to start it. Use continuationMode=unattended only when the user explicitly requests unattended Goal mode; the host rejects unattended escalation otherwise.",
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
