/**
 * Bootstrap-free durable Memory reader (Tier 1).
 *
 * OXP and other Exchange clients have already established their own authority.
 * A memory read needs only project identity, the durable DB, and the Memory
 * service; it must not load an Instance or execute workspace plugins.
 *
 * Share the process-global memoMap with AppRuntime so Database/Memory retain
 * their singleton ownership instead of competing over a second SQLite handle.
 */
import { Effect, ManagedRuntime } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { Memory } from "@opencode-ai/core/memory"
import { MemorySchema } from "@opencode-ai/core/memory/schema"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Database, type DatabaseShape } from "@opencode-ai/core/database/database"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { ExchangeMemory } from "./memory"
import { ExchangeMemorySession } from "./memory-session"

const runtime = ManagedRuntime.make(
  AppNodeBuilder.build(LayerNode.group([Memory.node, ProjectV2.node, Database.node])),
  { memoMap },
)

/** Allows isolated test hosts to close this scoped runtime before DB teardown. */
export const dispose = () => runtime.dispose()

export async function execute(
  input: ExchangeMemory.Input,
  context: ExchangeMemory.RuntimeContext,
): Promise<ExchangeMemory.Result> {
  const result = await runtime.runPromise(
    Effect.gen(function* () {
      const started = performance.now()
      const project = yield* ProjectV2.Service
      const resolved = yield* project.resolve(AbsolutePath.make(context.rootPath))
      const resolvedAt = performance.now()

      // V1 owns legacy ID migration. A stale cached repo identity must go
      // through its canonical path rather than silently returning no memories.
      if (resolved.previous && resolved.previous !== resolved.id) {
        return { kind: "legacy" as const }
      }

      const memory = yield* Memory.Service
      const { scanDb, withScanDb } = yield* Database.Service
      const readSearch = withScanDb ?? (<A, E, R>(
        run: (reader: DatabaseShape) => Effect.Effect<A, E, R>,
      ) => Effect.flatMap(scanDb(), run))
      const scope = MemorySchema.Context.make({
        projectID: resolved.id,
        workspaceID: WorkspaceContext.workspaceID ?? null,
      })
      const data = yield* ExchangeMemory.execute(memory, scope, input, {
        // A durable read must never enqueue background access-counter writes.
        trackAccess: false,
        sessionSearchStatus: context.sessionSearchAuthorized ? undefined : "not_authorized",
        ...(context.sessionSearchAuthorized
          ? {
              searchSessions: (query: string, limit: number, ranking: "recent" | "relevance") =>
                readSearch((reader) => ExchangeMemorySession.search(reader, {
                  query,
                  limit,
                  ranking,
                  directoryPrefixes: [context.rootPath],
                })),
            }
          : {}),
      }, context.signal)
      return {
        kind: "result" as const,
        data: {
          ...data,
          metadata: {
            ...data.metadata,
            runtimeTimingMs: {
              identity: Math.round(resolvedAt - started),
              operation: Math.round(performance.now() - resolvedAt),
            },
          },
        },
      }
    }),
    context.signal ? { signal: context.signal } : undefined,
  )

  if (result.kind === "result") return result.data
  // Read-only fallback on genuine identity drift. This is not a general
  // fallback on empty results, which would reintroduce the bootstrap cost.
  return Effect.runPromise(
    ExchangeMemory.executeRuntimeLegacy(input, context),
    context.signal ? { signal: context.signal } : undefined,
  )
}
