import { Effect } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { ToolOutputProjection } from "@opencode-ai/core/tool-output-projection"
import { FileSearch } from "@/search/filesystem"
import { ExchangeError } from "./error"

const OUTPUT_BYTES = 96 * 1024
const OUTPUT_LINES = 500
const PAGE_OUTPUT_BYTES = OUTPUT_BYTES - 4 * 1024
const PAGE_OUTPUT_LINES = OUTPUT_LINES - 16
const MAX_OFFSET = 100_000
const MAX_LIMIT = 1_000

export interface Input {
  readonly path: string
  readonly rootLabel: string
  readonly glob?: string
  readonly grep?: string
  readonly include?: string
  /** Zero-based result offset for stable bounded pagination within one live search. */
  readonly offset?: number
  readonly limit?: number
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

  if (!hasGlob && !hasGrep) {
    throw new ExchangeError.InvalidArgument({
      detail: "find requires a non-empty glob, grep, or grep + glob combination",
    })
  }

  if (!hasGrep) {
    if (input.include !== undefined) {
      throw new ExchangeError.InvalidArgument({
        detail: "include is only valid with grep",
      })
    }
    return { selected: "glob" as const, fileFilter: undefined }
  }

  if (
    input.glob !== undefined &&
    input.include !== undefined &&
    input.glob !== input.include
  ) {
    throw new ExchangeError.InvalidArgument({
      detail:
        "grep glob/include filters conflict; use one file filter or provide the same pattern in both fields",
    })
  }

  return {
    selected: "grep" as const,
    fileFilter: input.glob ?? input.include,
  }
}

function page(input: Input) {
  const offset = input.offset ?? 0
  const limit = input.limit ?? FileSearch.DEFAULT_LIMIT
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_OFFSET) {
    throw new ExchangeError.InvalidArgument({ detail: `find offset must be an integer between 0 and ${MAX_OFFSET}` })
  }
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
    throw new ExchangeError.InvalidArgument({ detail: `find limit must be an integer between 1 and ${MAX_LIMIT}` })
  }
  return { offset, limit }
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
    const request = yield* Effect.try({
      try: () => ({ ...select(input), ...page(input) }),
      catch: (cause) =>
        cause instanceof ExchangeError.InvalidArgument
          ? cause
          : new ExchangeError.InvalidArgument({ detail: "Invalid find request" }),
    })
    const { selected, fileFilter, offset, limit } = request
    const abort = input.signal ?? AbortSignal.any([])
    let result: FileSearch.GlobResult | FileSearch.GrepResult
    if (selected === "glob") {
      result = yield* FileSearch.glob(dependencies, {
        path: input.path,
        pattern: input.glob!,
        offset,
        limit,
        signal: abort,
      }).pipe(
        Effect.mapError(mapSearchError),
      )
    } else {
      result = yield* FileSearch.grep(dependencies, {
        path: input.path,
        pattern: input.grep!,
        include: fileFilter,
        literal: input.syntax !== "regex",
        offset,
        limit,
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
    let count = 0
    let pageTruncated = false
    if (result.kind === "glob") {
      const rows = yield* Effect.forEach(result.rows, display)
      const emitted: string[] = []
      let bytes = 0
      for (const row of rows) {
        const addition = (emitted.length === 0 ? "" : "\n") + row
        const nextBytes = bytes + Buffer.byteLength(addition, "utf8")
        if (emitted.length + 1 > PAGE_OUTPUT_LINES || nextBytes > PAGE_OUTPUT_BYTES) break
        emitted.push(row)
        bytes = nextBytes
      }
      count = emitted.length
      pageTruncated = count < rows.length
      const hasMore = result.truncated || pageTruncated
      output = emitted.length
        ? emitted.join("\n") +
          (hasMore ? `\n\n(More files available. Use offset=${offset + count} to continue.)` : "")
        : "No files found"
    } else {
      const rows = yield* Effect.forEach(result.rows, (row) =>
        display(row.path).pipe(Effect.map((path) => ({ ...row, path }))),
      )
      if (rows.length === 0) {
        output = "No files found"
      } else {
        const body: string[] = []
        let current = ""
        let bytes = 0
        for (const row of rows) {
          const pieces: string[] = []
          if (current !== row.path) {
            if (current) pieces.push("")
            pieces.push(`${row.path}:`)
          }
          pieces.push(`  Line ${row.line}: ${row.text}`)
          const addition = (body.length === 0 ? "" : "\n") + pieces.join("\n")
          const nextLines = body.length + pieces.length
          const nextBytes = bytes + Buffer.byteLength(addition, "utf8")
          if (nextLines > PAGE_OUTPUT_LINES || nextBytes > PAGE_OUTPUT_BYTES) break
          body.push(...pieces)
          bytes = nextBytes
          current = row.path
          count++
        }
        pageTruncated = count < rows.length
        const hasMore = result.truncated || pageTruncated
        const lines = [`Found ${count} matches${hasMore ? " (more matches available)" : ""}`, ...body]
        if (hasMore) lines.push("", `(Use offset=${offset + count} to continue this live search page.)`)
        output = lines.join("\n")
      }
    }

    const hasMore = result.truncated || pageTruncated
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
        ...(selected === "grep"
          ? {
              syntax: input.syntax ?? "literal",
              ...(fileFilter === undefined ? {} : { fileFilter }),
            }
          : {}),
        root: input.rootLabel,
        count,
        offset,
        limit,
        hasMore,
        ...(hasMore && count > 0 ? { nextOffset: offset + count } : {}),
        producerTruncated: result.truncated,
        pageTruncated,
        projectionTruncated: projected.truncated,
        truncated: hasMore || projected.truncated,
        complete: !hasMore && !projected.truncated,
        pagination: "live" as const,
      },
    }
  })
}

export * as ExchangeFind from "./find"
