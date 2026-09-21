import { Effect } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ExchangeSqlite } from "@/exchange/sqlite"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import * as Tool from "./tool"
import DESCRIPTION from "./sqlite.txt"

export const Parameters = ExchangeSqlite.Parameters
export type Metadata = ExchangeSqlite.Metadata
export type SqliteAccess = ExchangeSqlite.SqliteAccess
export const executeSqlite = ExchangeSqlite.execute

const nativeAccess = (ctx: Tool.Context): ExchangeSqlite.SqliteAccess => ({
  read: (resolved) =>
    Effect.gen(function* () {
      yield* ctx.ask({
        permission: "read",
        patterns: [resolved.rel],
        always: ["*"],
        metadata: { filepath: resolved.abs },
      })
      yield* assertExternalDirectoryEffect(ctx, resolved.abs, { kind: "file" })
    }),
  write: (resolved, metadata) =>
    Effect.gen(function* () {
      yield* ctx.ask({
        permission: "edit",
        patterns: [resolved.rel],
        always: ["*"],
        metadata: { filepath: resolved.abs, ...metadata },
      })
      yield* assertExternalDirectoryEffect(ctx, resolved.abs, { kind: "file" })
    }),
})

export const SqliteTool = Tool.define<typeof Parameters, Metadata, ChildProcessSpawner>(
  "sqlite",
  Effect.gen(function* () {
    yield* ChildProcessSpawner
    return {
      exposure: "lazy" as const,
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          return yield* ExchangeSqlite.execute(params, instance, nativeAccess(ctx))
        }).pipe(Effect.orDie),
    }
  }),
)

export * as SqliteCore from "@/exchange/sqlite/core"
