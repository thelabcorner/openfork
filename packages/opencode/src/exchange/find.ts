import { Effect } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { ToolOutputProjection } from "@opencode-ai/core/tool-output-projection"
import { FileSearch } from "@/search/filesystem"
import { ExchangeError } from "./error"

const OUTPUT_BYTES = 96 * 1024
const OUTPUT_LINES = 500

export interface Input {
  readonly path: string
  readonly rootLabel: string
  readonly glob?: string
  readonly grep?: string
  readonly include?: string
  /** Literal by default; regex is an explicit opt-in for model-facing search. */
  readonly syntax?: "literal" | "regex"
  readonly signal?: AbortSignal
  readonly projectionMarker?: string
  readonly toDisplayPath: (canonicalPath: string) => string
}

export interface Result {
  readonly title: string
  readonly output: string
  readonly metadata: Readonly<Record<string, unknown>>
}

export interface Hooks<E> {
  readonly revalidate: () => Effect.Effect<unknown, E>
}

function select(input: Input) {
  const hasGlob = typeof input.glob === "string" && input.glob.length > 0
  const hasGrep = typeof input.grep === "string" && input.grep.length > 0
  if (hasGlob === hasGrep) throw new ExchangeError.InvalidArgument({ detail: "find requires exactly one non-empty glob or grep" })
  if (hasGlob && input.include !== undefined) {
    throw new ExchangeError.InvalidArgument({ detail: "include is only valid with grep" })
  }
  return hasGlob ? ("glob" as const) : ("grep" as const)
}

function mapSearchError(error: FileSearch.InvalidInput | Ripgrep.Error | Ripgrep.InvalidPatternError): ExchangeError.Error {
  if (error instanceof FileSearch.InvalidInput || error instanceof Ripgrep.InvalidPatternError) {
    return new ExchangeError.InvalidArgument({ detail: error.message.slice(0, 1024) })
  }
  if (error.cause instanceof globalThis.Error && error.cause.name === "AbortError") {
    return new ExchangeError.Cancelled({ detail: "File search was cancelled" })
  }
  return new ExchangeError.DependencyUnavailable({ detail: "File search is unavailable" })
}

export function execute<E>(
  dependencies: { readonly fs: FSUtil.Interface; readonly ripgrep: Ripgrep.Interface },
  input: Input,
  hooks: Hooks<E>,
): Effect.Effect<Result, ExchangeError.Error | E> {
  return Effect.gen(function* () {
    const selected = yield* Effect.try({
      try: () => select(input),
      catch: (cause) =>
        cause instanceof ExchangeError.InvalidArgument
          ? cause
          : new ExchangeError.InvalidArgument({ detail: "Invalid find request" }),
    })
    const abort = input.signal ?? AbortSignal.any([])
    let result: FileSearch.GlobResult | FileSearch.GrepResult
    if (selected === "glob") {
      result = yield* FileSearch.glob(dependencies, { path: input.path, pattern: input.glob!, signal: abort }).pipe(
        Effect.mapError(mapSearchError),
      )
    } else {
      result = yield* FileSearch.grep(dependencies, {
        path: input.path,
        pattern: input.grep!,
        include: input.include,
        literal: input.syntax !== "regex",
        signal: abort,
      }).pipe(Effect.mapError(mapSearchError))
    }

    yield* hooks.revalidate().pipe(Effect.asVoid)

    const display = (value: string) =>
      Effect.try({
        try: () => input.toDisplayPath(value),
        catch: () => new ExchangeError.InvalidArgument({ detail: "Search returned a path outside the authorized projection" }),
      })

    let output: string
    let count: number
    if (result.kind === "glob") {
      const rows = yield* Effect.forEach(result.rows, display)
      count = rows.length
      output = rows.length ? rows.join("\n") : "No files found"
    } else {
      count = result.rows.length
      const rows = yield* Effect.forEach(result.rows, (row) => display(row.path).pipe(Effect.map((path) => ({ ...row, path }))))
      if (rows.length === 0) {
        output = "No files found"
      } else {
        const lines = [`Found ${rows.length} matches${result.truncated ? " (more matches available)" : ""}`]
        let current = ""
        for (const row of rows) {
          if (current !== row.path) {
            if (current) lines.push("")
            current = row.path
            lines.push(`${row.path}:`)
          }
          lines.push(`  Line ${row.line}: ${row.text}`)
        }
        if (result.truncated) lines.push("", "(Results truncated. Narrow the path or pattern.)")
        output = lines.join("\n")
      }
    }

    const projected = ToolOutputProjection.project(output, {
      maxLines: OUTPUT_LINES,
      maxBytes: OUTPUT_BYTES,
      strategy: "head",
      marker: input.projectionMarker ?? "<note>Find output truncated; narrow the path or pattern</note>",
    })
    return {
      title: selected === "glob" ? input.glob! : input.grep!,
      output: projected.content,
      metadata: {
        action: selected,
        ...(selected === "grep" ? { syntax: input.syntax ?? "literal" } : {}),
        root: input.rootLabel,
        count,
        producerTruncated: result.truncated,
        projectionTruncated: projected.truncated,
        truncated: result.truncated || projected.truncated,
      },
    }
  })
}

export * as ExchangeFind from "./find"
