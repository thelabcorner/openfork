import { Effect } from "effect"
import { Memory } from "@opencode-ai/core/memory"
import { MemorySchema } from "@opencode-ai/core/memory/schema"
import { ExchangeMemory } from "@/exchange/memory"
import { InstanceState } from "@/effect/instance-state"
import * as Tool from "./tool"
import DESCRIPTION from "./memory.txt"

export const Parameters = ExchangeMemory.Parameters
export type Metadata = ExchangeMemory.Metadata

export const MemoryTool = Tool.define<typeof Parameters, Metadata, Memory.Service>(
  "memory",
  Effect.gen(function* () {
    const memory = yield* Memory.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const workspaceID = yield* InstanceState.workspaceID
          const scope = MemorySchema.Context.make({
            projectID: instance.project.id,
            workspaceID: workspaceID ?? null,
          })
          const readOnly = params.action !== "remember" && params.action !== "forget"
          yield* ctx.ask({
            permission: "memory",
            patterns: [`memory:${params.action}:*`],
            always: readOnly ? [`memory:${params.action}:*`] : [],
            metadata: { action: params.action },
          })
          const result = yield* ExchangeMemory.execute(memory, scope, params)
          return {
            title: result.title,
            output: result.output,
            metadata: result.metadata,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
