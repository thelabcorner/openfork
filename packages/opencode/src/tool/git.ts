import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppProcess } from "@opencode-ai/core/process"
import { InstanceState } from "@/effect/instance-state"
import { GitTyped } from "@/git/typed"
import DESCRIPTION from "./git.txt"

export const Parameters = GitTyped.Parameters

type Metadata = GitTyped.Metadata

export const GitTool = Tool.define<typeof Parameters, Metadata, AppProcess.Service>(
  "git",
  Effect.gen(function* () {
    const app = yield* AppProcess.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const root = yield* GitTyped.resolveWorktreeRoot(app, instance.directory)
          const mode = params.mode ?? "status"
          const paths = params.paths?.map((item) => GitTyped.resolvePathInside(root, item)) ?? []
          const permPatterns =
            paths.length > 0
              ? paths.map((item) => `git:${mode}:${item}`)
              : mode === "commit"
                ? [`git:commit:${(params.message ?? "").slice(0, 60)}`]
                : [`git:${mode}:*`]

          yield* ctx.ask({
            permission: "git",
            patterns: permPatterns,
            always: mode === "commit" ? [`git:commit:${(params.message ?? "").slice(0, 60)}`] : permPatterns,
            metadata: { mode, ...(paths.length ? { paths } : {}) },
          })

          return yield* GitTyped.execute(app, params, root, ctx.abort)
        }).pipe(Effect.orDie),
    }
  }),
)

