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
  "Create a durable autonomous Goal from a single objective when the user explicitly requests Goal Mode or confirms a proposal.",
  "Provide only the objective. Never call this tool for progress, criteria, status, evidence, verification, or at the end of a task.",
  "The host starts and independently audits Goal execution; changing a focused objective requires fresh, explicit user direction.",
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
          input: GoalAgent.ObjectiveInput,
          output: GoalAgent.Output,
          toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify({ goalID: output.goal.goal.id, objective: output.goal.goal.objective, status: output.goal.goal.status }) }],
          execute: (input, context) =>
            permission
              .assert({
                action: name,
                resources: ["create"],
                save: ["create"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              .pipe(
                Effect.mapError(() => new ToolFailure({ message: "Permission denied: goal" })),
                Effect.andThen(
                  goal
                    .submit(context.sessionID, input, context.userTurn)
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
