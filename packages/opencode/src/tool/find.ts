import { Effect, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import * as Truncate from "./truncate"
import DESCRIPTION from "./find.txt"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  glob: Schema.optional(Schema.String).annotate({
    description: "Glob pattern for finding files by path/name. Set exactly one of glob or grep.",
  }),
  grep: Schema.optional(Schema.String).annotate({
    description: "Regex pattern for searching file contents. Set exactly one of grep or glob.",
  }),
  path: Schema.optional(Schema.String).annotate({
    description: "Directory to search, or an exact file path for grep. Defaults to the current working directory.",
  }),
  include: Schema.optional(Schema.String).annotate({
    description: 'Grep-only file filter such as "*.js" or "*.{ts,tsx}".',
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = "glob" | "grep"

type Metadata = {
  action: Action
  delegatedTool: Action
  count?: number
  matches?: number
  truncated?: boolean
  [key: string]: unknown
}

const hasText = (value: string | undefined) => typeof value === "string" && value.trim().length > 0

const PATTERN_NOTE =
  "`pattern` is not a find parameter; pass `grep` for content search or `glob` for path matching."

function usageError(detail: string, note = false): Error {
  return new Error(
    [
      detail,
      "Accepted fields: glob | grep (exactly one), plus optional path and grep-only include.",
      '  glob — find files by path/name, e.g. {"glob":"**/*.ts","path":"packages/opencode/src"}',
      '  grep — search file contents with a regex, e.g. {"grep":"someRegex","include":"*.ts","path":"packages"}',
      ...(note ? [PATTERN_NOTE] : []),
    ].join("\n"),
  )
}

function resolveAction(params: Params): Action {
  const hasGlob = hasText(params.glob)
  const hasGrep = hasText(params.grep)
  const hasInclude = hasText(params.include)
  if (hasGlob && hasGrep) {
    if (hasInclude) return "grep"
    throw usageError("find received both glob and grep; pass exactly one search mode per call.")
  }
  if (!hasGlob && !hasGrep) {
    throw usageError("find received neither glob nor grep; one search mode is required.", true)
  }
  if (hasGlob && hasInclude) {
    throw usageError('"include" only filters grep results; it cannot be combined with glob.')
  }
  return hasGlob ? "glob" : "grep"
}

export const FindTool = Tool.define<
  typeof Parameters,
  Metadata,
  FSUtil.Service | Ripgrep.Service | Plugin.Service | Agent.Service | Truncate.Service
>(
  "find",
  Effect.gen(function* () {
    const plugin = yield* Plugin.Service
    const globInfo = yield* GlobTool
    const grepInfo = yield* GrepTool
    const glob = yield* Tool.init(globInfo)
    const grep = yield* Tool.init(grepInfo)

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const action = resolveAction(params)
          const target = (action === "glob" ? glob : grep) as Tool.Def
          const args: Record<string, unknown> =
            action === "glob"
              ? { pattern: params.glob, ...(hasText(params.path) ? { path: params.path } : {}) }
              : {
                  pattern: params.grep,
                  ...(hasText(params.path) ? { path: params.path } : {}),
                  ...(hasText(params.include) ? { include: params.include } : {}),
                }

          yield* plugin.trigger(
            "tool.execute.before",
            { tool: target.id, sessionID: ctx.sessionID, callID: ctx.callID },
            { args },
          )
          const result = yield* target.execute(args, ctx)
          const output = {
            ...result,
            metadata: {
              ...result.metadata,
              action,
              delegatedTool: target.id as Action,
            },
          } satisfies Tool.ExecuteResult<Metadata>
          yield* plugin.trigger(
            "tool.execute.after",
            { tool: target.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
            output,
          )
          return output
        }).pipe(Effect.orDie),
    }
  }),
)
