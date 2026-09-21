export * as ExchangePatch from "./patch"

import { createTwoFilesPatch } from "diff"
import { Effect, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { parsePatch } from "@/patch"
import * as Bom from "@/util/bom"
import * as Core from "@/tool/patch/core"
import { deriveContent } from "@/tool/patch/resolve"
import { ExchangeError } from "./error"
import { ExchangeFileMutation } from "./file-mutation"

const MAX_PATCH_BYTES = 2 * 1024 * 1024

export const Parameters = Schema.Struct({
  patchText: Schema.String,
  format: Schema.optional(Schema.Literals(["auto", "opencode", "git"])),
  apply: Schema.optional(Schema.Union([Schema.Boolean, Schema.Literal("if-clean")])),
  showDiff: Schema.optional(Schema.Boolean),
})
export type Input = Schema.Schema.Type<typeof Parameters>

export interface ResolvedPath {
  readonly path: string
  readonly displayPath: string
}

export interface Hooks<E> {
  readonly resolve: (relativePath: string, allowMissing: boolean) => Effect.Effect<ResolvedPath, ExchangeError.Error | E>
  readonly revalidate: () => Effect.Effect<void, ExchangeError.Error | E>
  readonly beforeCommit: () => Effect.Effect<void, ExchangeError.Error | E>
}

type Planned = {
  readonly type: "add" | "update" | "delete" | "move"
  readonly path: string
  readonly displayPath: string
  readonly movePath?: string
  readonly moveDisplayPath?: string
  readonly beforeExists: boolean
  readonly before: Uint8Array
  readonly after?: Uint8Array
  readonly diff: string
  readonly additions: number
  readonly deletions: number
}

export interface Touched {
  readonly type: Planned["type"]
  readonly sourcePath: string
  readonly targetPath?: string
}

export interface Result {
  readonly result: {
    readonly title: string
    readonly output: string
    readonly metadata: Readonly<Record<string, unknown>>
    readonly mutation: { readonly attempted: boolean; readonly committed: boolean }
  }
  readonly touched: readonly Touched[]
}

function sameBytes(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false
  return true
}

function decode(bytes: Uint8Array) {
  return Bom.split(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes))
}

function parseInput(input: Input) {
  if (Buffer.byteLength(input.patchText, "utf8") > MAX_PATCH_BYTES) {
    throw new ExchangeError.InvalidArgument({ detail: "Patch exceeds the 2 MiB input limit" })
  }
  const detected = Core.detectFormat(input.patchText)
  const requested = input.format ?? "auto"
  const format = requested === "auto" ? detected : requested
  if (!format) throw new ExchangeError.InvalidArgument({ detail: Core.instructiveParseError(null, undefined, input.patchText) })
  try {
    const hunks = format === "git" ? Core.translateGitDiff(input.patchText) : parsePatch(input.patchText).hunks
    if (!hunks?.length) throw new Error("patch contains no applicable file hunks")
    return { format, hunks }
  } catch (error) {
    if (error instanceof ExchangeError.InvalidArgument) throw error
    throw new ExchangeError.InvalidArgument({ detail: Core.instructiveParseError(format, error, input.patchText) })
  }
}

function relativePatchPath(value: string) {
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\")) {
    throw new ExchangeError.InvalidArgument({ detail: "Patch file paths must be relative to the explicit approved root" })
  }
  return value
}

function exists(fs: FSUtil.Interface, filePath: string) {
  return fs.exists(filePath).pipe(
    Effect.mapError(() => new ExchangeError.DependencyUnavailable({ detail: "Unable to inspect patch target state" })),
  )
}

export function execute<E>(
  fs: FSUtil.Interface,
  input: Input,
  hooks: Hooks<E>,
  signal?: AbortSignal,
): Effect.Effect<Result, ExchangeError.Error | E> {
  return Effect.gen(function* () {
    if (signal?.aborted) return yield* new ExchangeError.Cancelled({ detail: "Patch was cancelled" })
    const parsed = yield* Effect.try({
      try: () => parseInput(input),
      catch: (error) =>
        error instanceof ExchangeError.InvalidArgument
          ? error
          : new ExchangeError.InvalidArgument({ detail: error instanceof Error ? error.message : String(error) }),
    })

    const planned: Planned[] = []
    const seen = new Set<string>()
    for (const hunk of parsed.hunks) {
      if (signal?.aborted) return yield* new ExchangeError.Cancelled({ detail: "Patch was cancelled" })
      const source = yield* hooks.resolve(relativePatchPath(hunk.path), hunk.type === "add")
      if (seen.has(FSUtil.normalizePath(source.path))) {
        return yield* new ExchangeError.Conflict({ detail: `Patch addresses ${source.displayPath} more than once; combine its hunks` })
      }
      seen.add(FSUtil.normalizePath(source.path))

      if (hunk.type === "add") {
        if (yield* exists(fs, source.path)) {
          return yield* new ExchangeError.Conflict({ detail: `Patch add target already exists: ${source.displayPath}` })
        }
        const after = new TextEncoder().encode(hunk.contents)
        const diff = Core.trimDiff(createTwoFilesPatch(source.displayPath, source.displayPath, "", hunk.contents))
        planned.push({
          type: "add",
          path: source.path,
          displayPath: source.displayPath,
          beforeExists: false,
          before: new Uint8Array(),
          after,
          diff,
          ...Core.countPatchChanges(diff),
        })
        continue
      }

      const before = yield* fs.readFile(source.path).pipe(
        Effect.mapError(() => new ExchangeError.Conflict({ detail: `Patch source is unavailable: ${source.displayPath}` })),
      )
      const old = decode(before)
      yield* Effect.try({
        try: () => Core.assertTextContent(old.text, source.displayPath),
        catch: (error) => new ExchangeError.Conflict({ detail: error instanceof Error ? error.message : String(error) }),
      })
      if (hunk.type === "delete") {
        const diff = Core.trimDiff(createTwoFilesPatch(source.displayPath, source.displayPath, old.text, ""))
        planned.push({
          type: "delete",
          path: source.path,
          displayPath: source.displayPath,
          beforeExists: true,
          before,
          diff,
          ...Core.countPatchChanges(diff),
        })
        continue
      }

      const derived = yield* Effect.try({
        try: () => deriveContent(Bom.join(old.text, old.bom), hunk.chunks, source.displayPath),
        catch: (error) =>
          new ExchangeError.Conflict({
            detail: `Patch hunk does not match ${source.displayPath}: ${error instanceof Error ? error.message : String(error)}`,
          }),
      })
      const next = Bom.split(derived.content)
      const after = new TextEncoder().encode(Bom.join(next.text, next.bom || old.bom))
      let move: ResolvedPath | undefined
      if (hunk.move_path) {
        move = yield* hooks.resolve(relativePatchPath(hunk.move_path), true)
        if (yield* exists(fs, move.path)) {
          return yield* new ExchangeError.Conflict({ detail: `Patch move destination already exists: ${move.displayPath}` })
        }
      }
      const diff = Core.trimDiff(
        createTwoFilesPatch(source.displayPath, move?.displayPath ?? source.displayPath, old.text, next.text),
      )
      planned.push({
        type: move ? "move" : "update",
        path: source.path,
        displayPath: source.displayPath,
        ...(move ? { movePath: move.path, moveDisplayPath: move.displayPath } : {}),
        beforeExists: true,
        before,
        after,
        diff,
        ...Core.countPatchChanges(diff),
      })
    }

    const actionable = planned.filter(
      (item) => item.type === "delete" || item.type === "move" || !item.after || !sameBytes(item.before, item.after),
    )
    const mode = input.apply ?? "if-clean"
    const files = planned.map((item) => ({
      type: item.type,
      path: item.displayPath,
      ...(item.moveDisplayPath ? { movePath: item.moveDisplayPath } : {}),
      additions: item.additions,
      deletions: item.deletions,
    }))
    if (mode === false) {
      return {
        result: {
          title: "patch plan",
          output: Core.formatPlan({
            format: parsed.format,
            files,
            showDiff: input.showDiff ?? false,
            diffs: planned.map((item) => item.diff),
            mode: "dry-run",
          }),
          metadata: { format: parsed.format, fileCount: actionable.length, applied: false, files },
          mutation: { attempted: false, committed: false },
        },
        touched: [],
      }
    }
    if (actionable.length === 0) {
      return {
        result: {
          title: "patch",
          output: Core.noChangesMessage(true),
          metadata: { format: parsed.format, fileCount: 0, applied: false, files: [] },
          mutation: { attempted: false, committed: false },
        },
        touched: [],
      }
    }

    const changes: ExchangeFileMutation.Change[] = actionable.map((item) => {
      if (item.type === "add") {
        return {
          type: "add",
          path: item.path,
          displayPath: item.displayPath,
          beforeExists: false,
          before: item.before,
          after: item.after!,
        }
      }
      if (item.type === "delete") {
        return {
          type: "delete",
          path: item.path,
          displayPath: item.displayPath,
          beforeExists: true,
          before: item.before,
        }
      }
      if (item.type === "move") {
        return {
          type: "move",
          path: item.path,
          displayPath: item.displayPath,
          movePath: item.movePath!,
          moveDisplayPath: item.moveDisplayPath!,
          beforeExists: true,
          before: item.before,
          after: item.after!,
        }
      }
      return {
        type: "update",
        path: item.path,
        displayPath: item.displayPath,
        beforeExists: true,
        before: item.before,
        after: item.after!,
      }
    })
    const targets = changes.flatMap((change) => (change.type === "move" ? [change.path, change.movePath] : [change.path]))
    yield* ExchangeFileMutation.commit(
      fs,
      targets,
      {
        prepare: () => Effect.succeed({ changes, value: undefined }),
        revalidate: hooks.revalidate,
        beforeCommit: hooks.beforeCommit,
      },
      signal,
    )

    return {
      result: {
        title: `patch: applied ${actionable.length} changes`,
        output: Core.formatApplySummary({ format: parsed.format, files, mode: mode === true ? "apply" : "if-clean" }),
        metadata: {
          format: parsed.format,
          fileCount: actionable.length,
          applied: true,
          files,
          ...(input.showDiff ? { diff: planned.map((item) => item.diff).join("\n") } : {}),
        },
        mutation: { attempted: true, committed: true },
      },
      touched: actionable.map((item) => ({
        type: item.type,
        sourcePath: item.path,
        ...(item.movePath ? { targetPath: item.movePath } : item.type === "delete" ? {} : { targetPath: item.path }),
      })),
    }
  })
}

