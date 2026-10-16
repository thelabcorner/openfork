import { Effect } from "effect"
import { Memory } from "@opencode-ai/core/memory"
import { MemorySchema } from "@opencode-ai/core/memory/schema"
import { ExchangeMemory } from "@/exchange/memory"
import { ExchangeMemorySession } from "@/exchange/memory-session"
import { Database } from "@opencode-ai/core/database/database"
import { InstanceState } from "@/effect/instance-state"
import * as Tool from "./tool"
import DESCRIPTION from "./memory.txt"
import { MemoryEvidence } from "@/exchange/memory-evidence"

export const Parameters = ExchangeMemory.Parameters
export type Metadata = ExchangeMemory.Metadata

export const MemoryTool = Tool.define<typeof Parameters, Metadata, Memory.Service | Database.Service>(
  "memory",
  Effect.gen(function* () {
    const memory = yield* Memory.Service
    const { db, scanDb } = yield* Database.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
       execute: (params, ctx) =>
         Effect.gen(function* () {
          if (ctx.agent === "dreamer" && !["search", "get", "timeline"].includes(params.action)) {
            return yield* new Tool.InvalidArgumentsError({
              tool: "memory",
              detail: "Dreamer is inspection-only: use search, get, or timeline; map/open may materialize projections and remember/forget mutate memory.",
            })
          }
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
           const result = yield* ExchangeMemory.execute(memory, scope, params, {
              trackAccess: ctx.agent !== "dreamer",
              verifySessionEvidence: (evidence, entryScope) => MemoryEvidence.verify(db, scope, evidence, entryScope),
             searchSessions: (query, limit, ranking) =>
               Effect.flatMap(scanDb(), (reader) => ExchangeMemorySession.search(reader, {
                query,
                limit,
                ranking,
                 project: String(instance.project.id),
               })),
          })
          return {
            title: result.title,
            output: result.output,
            metadata: result.metadata,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
