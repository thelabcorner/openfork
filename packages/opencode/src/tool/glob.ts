import path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { assertExternalDirectoryEffect } from "./external-directory"
import { FileSearch } from "@/search/filesystem"
import DESCRIPTION from "./glob.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "The glob pattern to match files against" }),
  path: Schema.optional(Schema.String).annotate({
    description: `The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.`,
  }),
})

export const GlobTool = Tool.define(
  "glob",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { pattern: string; path?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          yield* ctx.ask({
            permission: "glob",
            patterns: [params.pattern],
            always: ["*"],
            metadata: {
              pattern: params.pattern,
              path: params.path,
            },
          })

          let search = params.path ?? ins.directory
          search = path.isAbsolute(search) ? search : path.resolve(ins.directory, search)
          yield* assertExternalDirectoryEffect(ctx, search, {
            bypass: false,
            kind: "directory",
          })

          const result = yield* FileSearch.glob(
            { fs, ripgrep },
            { path: search, pattern: params.pattern, signal: ctx.abort },
          )
          const final = result.rows
          const truncated = result.truncated

          const output = []
          if (final.length === 0) output.push("No files found")
          if (final.length > 0) {
            output.push(...final)
            if (truncated) {
              output.push("")
              output.push(
                `(Results are truncated: showing first ${FileSearch.DEFAULT_LIMIT} results. Consider using a more specific path or pattern.)`,
              )
            }
          }

          return {
            title: path.relative(ins.worktree, search),
            metadata: {
              count: final.length,
              truncated,
            },
            output: output.join("\n"),
            // Structured owner: an internal caller composes over `data` instead of
            // reparsing the model-facing rendering.
            data: { files: final, count: final.length, truncated },
          }
        }),
    }
  }),
)
