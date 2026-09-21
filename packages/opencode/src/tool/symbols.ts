import { Effect } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { Symbols } from "@/symbols/service"
import { assertExternalDirectoryEffect } from "./external-directory"
import * as Tool from "./tool"
import * as Truncate from "./truncate"
import DESCRIPTION from "./symbols.txt"

export const Parameters = Symbols.Parameters

export const SymbolsTool = Tool.define<typeof Parameters, Symbols.Metadata, Symbols.Service | Truncate.Service>(
  "symbols",
  Effect.gen(function* () {
    const symbols = yield* Symbols.Service
    const truncate = yield* Truncate.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const action = params.action ?? "search"
          yield* ctx.ask({
            permission: "grep",
            patterns: [params.query ?? "outline", params.path ?? "."],
            always: ["*"],
            metadata: { action, query: params.query, file: params.file, path: params.path },
          })

          return yield* symbols.execute(params, {
            directory: instance.directory,
            worktree: instance.worktree,
            abort: ctx.abort,
            authorize: (target, kind) =>
              assertExternalDirectoryEffect(ctx, target, { kind }).pipe(Effect.asVoid),
            writeOverflow: (content) => truncate.write(content),
          })
        }).pipe(Effect.orDie),
    }
  }),
)

export * as SymbolsToolModule from "./symbols"
