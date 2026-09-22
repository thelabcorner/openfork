import path from "path"
import { Effect, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"

export const DEFAULT_LIMIT = 100

export class InvalidInput extends Schema.TaggedErrorClass<InvalidInput>()("FileSearch.InvalidInput", {
  message: Schema.String,
}) {}

export interface Dependencies {
  readonly fs: FSUtil.Interface
  readonly ripgrep: Ripgrep.Interface
}

export interface GlobInput {
  readonly path: string
  readonly pattern: string
  readonly limit?: number
  readonly signal?: AbortSignal
}

export interface GlobResult {
  readonly kind: "glob"
  readonly rows: readonly string[]
  readonly truncated: boolean
}

export interface GrepInput {
  readonly path: string
  readonly pattern: string
  readonly include?: string
  readonly literal?: boolean
  readonly limit?: number
  readonly signal?: AbortSignal
}

export interface GrepRow {
  readonly path: string
  readonly line: number
  readonly text: string
}

export interface GrepResult {
  readonly kind: "grep"
  readonly rows: readonly GrepRow[]
  readonly truncated: boolean
}

const limitOf = (value?: number) =>
  Number.isSafeInteger(value) && value !== undefined && value > 0 ? Math.min(value, 1_000) : DEFAULT_LIMIT

export const glob = Effect.fn("FileSearch.glob")(function* (deps: Dependencies, input: GlobInput) {
  const info = yield* deps.fs.stat(input.path).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (info?.type !== "Directory") {
    return yield* new InvalidInput({ message: `glob path must be a directory: ${input.path}` })
  }

  const limit = limitOf(input.limit)
  const files = yield* deps.ripgrep.find({
    cwd: input.path,
    pattern: input.pattern,
    limit: limit + 1,
    hidden: true,
    signal: input.signal,
  })
  const truncated = files.length > limit
  return {
    kind: "glob" as const,
    rows: files.slice(0, limit).map((file) => path.resolve(input.path, file.path)),
    truncated,
  }
})

export const grep = Effect.fn("FileSearch.grep")(function* (deps: Dependencies, input: GrepInput) {
  if (!input.pattern) return yield* new InvalidInput({ message: "pattern is required" })

  const requestedInfo = yield* deps.fs.stat(input.path).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (!requestedInfo || (requestedInfo.type !== "Directory" && requestedInfo.type !== "File")) {
    return yield* new InvalidInput({ message: `grep path does not exist: ${input.path}` })
  }

  // Canonicalize only the execution path. Output deliberately retains the caller's
  // approved spelling so native tools preserve aliases while OXP may independently
  // project the same rows into its virtual-root namespace.
  const search = yield* deps.fs.resolve(input.path)
  const searchInfo = yield* deps.fs.stat(search).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (!searchInfo || (searchInfo.type !== "Directory" && searchInfo.type !== "File")) {
    return yield* new InvalidInput({ message: `grep path does not exist: ${input.path}` })
  }

  const cwd = searchInfo.type === "Directory" ? search : path.dirname(search)
  const limit = limitOf(input.limit)
  const matches = yield* deps.ripgrep.grep({
    cwd,
    pattern: input.pattern,
    file: requestedInfo.type === "File" ? path.basename(search) : undefined,
    include: input.include,
    literal: input.literal,
    limit: limit + 1,
    signal: input.signal,
  })
  const truncated = matches.length > limit
  const displayBase = requestedInfo.type === "Directory" ? input.path : path.dirname(input.path)
  return {
    kind: "grep" as const,
    rows: matches.slice(0, limit).map((item) => ({
      path: path.resolve(displayBase, item.entry.path),
      line: item.line,
      text: item.text,
    })),
    truncated,
  }
})

export * as FileSearch from "./filesystem"
