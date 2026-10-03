export * as ExchangePatch from "./patch"

import { createTwoFilesPatch } from "diff"
import { Effect, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { parsePatch, type UpdateFileChunk } from "@/patch"
import * as Bom from "@/util/bom"
import * as Core from "@/tool/patch/core"
import { deriveContent } from "@/tool/patch/resolve"
import { ExchangeAttribution } from "./attribution"
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

type Satisfied = {
  readonly type: Planned["type"]
  readonly path: string
  readonly displayPath: string
  readonly moveDisplayPath?: string
  readonly reason: "desired-state-already-present" | "file-already-absent" | "no-change"
}

type Resolution =
  | { readonly status: "planned"; readonly item: Planned }
  | { readonly status: "satisfied"; readonly item: Satisfied }

type ConflictReceipt = {
  readonly path: string
  readonly detail: string
  readonly phase: "preflight" | "commit"
}

type ResolutionStatus = "planned" | "applied" | "satisfied" | "partial" | "conflict"

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

function desiredUpdateSatisfied(content: string, chunks: readonly UpdateFileChunk[], filePath: string) {
  if (chunks.length === 0 || chunks.some((chunk) => chunk.new_lines.length === 0)) return false
  try {
    const identity = chunks.map((chunk) => ({ ...chunk, old_lines: chunk.new_lines, new_lines: chunk.new_lines }))
    return deriveContent(content, identity, filePath).content === content
  } catch {
    return false
  }
}

function statusOf(input: {
  readonly dryRun: boolean
  readonly ready: number
  readonly applied: number
  readonly satisfied: number
  readonly conflicted: number
}): ResolutionStatus {
  const successful = input.applied + input.satisfied
  if (input.conflicted > 0) return successful > 0 || input.ready > 0 ? "partial" : "conflict"
  if (input.dryRun && input.ready > 0) return "planned"
  if (input.applied > 0) return "applied"
  return "satisfied"
}

function resolutionSummary(input: {
  readonly requested: number
  readonly ready: number
  readonly applied: number
  readonly satisfied: number
  readonly conflicted: number
  readonly dryRun: boolean
}) {
  return {
    status: statusOf(input),
    requested: input.requested,
    preflightReady: input.ready,
    applied: input.applied,
    satisfied: input.satisfied,
    conflicted: input.conflicted,
  }
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
  attribution?: ExchangeAttribution.Attribution,
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
    const satisfied: Satisfied[] = []
    const conflicts: ConflictReceipt[] = []
    const seen = new Set<string>()
    for (const hunk of parsed.hunks) {
      if (signal?.aborted) return yield* new ExchangeError.Cancelled({ detail: "Patch was cancelled" })
      let conflictPath = hunk.path

      const outcome = yield* Effect.gen(function* () {
        const source = yield* hooks.resolve(relativePatchPath(hunk.path), hunk.type === "add" || hunk.type === "delete")
        conflictPath = source.displayPath
        if (seen.has(FSUtil.normalizePath(source.path))) {
          return yield* new ExchangeError.Conflict({ detail: `Patch addresses ${source.displayPath} more than once; combine its hunks` })
        }
        seen.add(FSUtil.normalizePath(source.path))

        if (hunk.type === "add") {
          const after = new TextEncoder().encode(hunk.contents)
          if (yield* exists(fs, source.path)) {
            const current = yield* fs.readFile(source.path).pipe(
              Effect.mapError(() => new ExchangeError.Conflict({ detail: `Patch add target is unavailable: ${source.displayPath}` })),
            )
            if (sameBytes(current, after)) {
              return {
                status: "satisfied" as const,
                item: {
                  type: "add" as const,
                  path: source.path,
                  displayPath: source.displayPath,
                  reason: "desired-state-already-present" as const,
                },
              } satisfies Resolution
            }
            return yield* new ExchangeError.Conflict({ detail: `Patch add target already exists with different content: ${source.displayPath}` })
          }
          const diff = Core.trimDiff(createTwoFilesPatch(source.displayPath, source.displayPath, "", hunk.contents))
          return {
            status: "planned" as const,
            item: {
              type: "add" as const,
              path: source.path,
              displayPath: source.displayPath,
              beforeExists: false as const,
              before: new Uint8Array(),
              after,
              diff,
              ...Core.countPatchChanges(diff),
            },
          } satisfies Resolution
        }

        if (hunk.type === "delete" && !(yield* exists(fs, source.path))) {
          return {
            status: "satisfied" as const,
            item: {
              type: "delete" as const,
              path: source.path,
              displayPath: source.displayPath,
              reason: "file-already-absent" as const,
            },
          } satisfies Resolution
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
          return {
            status: "planned" as const,
            item: {
              type: "delete" as const,
              path: source.path,
              displayPath: source.displayPath,
              beforeExists: true as const,
              before,
              diff,
              ...Core.countPatchChanges(diff),
            },
          } satisfies Resolution
        }

        const currentContent = Bom.join(old.text, old.bom)
        const derivedAttempt = yield* Effect.try({
          try: () => deriveContent(currentContent, hunk.chunks, source.displayPath),
          catch: (error) => error,
        }).pipe(
          Effect.match({
            onFailure: (error) => ({ ok: false as const, error }),
            onSuccess: (value) => ({ ok: true as const, value }),
          }),
        )
        if (!derivedAttempt.ok) {
          if (!hunk.move_path && desiredUpdateSatisfied(currentContent, hunk.chunks, source.displayPath)) {
            return {
              status: "satisfied" as const,
              item: {
                type: "update" as const,
                path: source.path,
                displayPath: source.displayPath,
                reason: "desired-state-already-present" as const,
              },
            } satisfies Resolution
          }
          return yield* new ExchangeError.Conflict({
            detail: `Patch hunk does not match ${source.displayPath}: ${derivedAttempt.error instanceof Error ? derivedAttempt.error.message : String(derivedAttempt.error)}`,
          })
        }
        const derived = derivedAttempt.value
        const next = Bom.split(derived.content)
        const after = new TextEncoder().encode(Bom.join(next.text, next.bom || old.bom))
        if (!hunk.move_path && sameBytes(before, after)) {
          return {
            status: "satisfied" as const,
            item: {
              type: "update" as const,
              path: source.path,
              displayPath: source.displayPath,
              reason: "no-change" as const,
            },
          } satisfies Resolution
        }
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
        return {
          status: "planned" as const,
          item: {
            type: move ? ("move" as const) : ("update" as const),
            path: source.path,
            displayPath: source.displayPath,
            ...(move ? { movePath: move.path, moveDisplayPath: move.displayPath } : {}),
            beforeExists: true as const,
            before,
            after,
            diff,
            ...Core.countPatchChanges(diff),
          },
        } satisfies Resolution
      }).pipe(
        Effect.match({
          onFailure: (error) => ({ ok: false as const, error }),
          onSuccess: (value) => ({ ok: true as const, value }),
        }),
      )

      if (outcome.ok) {
        if (outcome.value.status === "planned") planned.push(outcome.value.item)
        else satisfied.push(outcome.value.item)
        continue
      }
      if (outcome.error instanceof ExchangeError.Conflict) {
        conflicts.push({ path: conflictPath, detail: outcome.error.detail, phase: "preflight" })
        continue
      }
      return yield* Effect.fail(outcome.error)
    }

    const mode = input.apply ?? "if-clean"
    if (conflicts.length > 0 && mode === true) {
      return yield* new ExchangeError.Conflict({
        detail: conflicts.map((conflict) => `${conflict.path}: ${conflict.detail}`).join("\n"),
      })
    }
    if (planned.length === 0 && satisfied.length === 0 && conflicts.length > 0) {
      return yield* new ExchangeError.Conflict({
        detail: conflicts.map((conflict) => `${conflict.path}: ${conflict.detail}`).join("\n"),
      })
    }

    const actionable = planned
    const files = planned.map((item) => ({
      type: item.type,
      path: item.displayPath,
      ...(item.moveDisplayPath ? { movePath: item.moveDisplayPath } : {}),
      additions: item.additions,
      deletions: item.deletions,
    }))
    const conflictSummary =
      conflicts.length === 0
        ? ""
        : [
            "",
            `${conflicts.length} conflicting file operation${conflicts.length === 1 ? "" : "s"} ${conflicts.length === 1 ? "requires" : "require"} targeted retry; independently classified siblings are preserved:`,
            ...conflicts.map((conflict) => `- ${conflict.path}: ${conflict.detail}`),
          ].join("\n")
    const satisfiedSummary =
      satisfied.length === 0
        ? ""
        : [
            "",
            `Already satisfied ${satisfied.length} file operation${satisfied.length === 1 ? "" : "s"}; no write was needed:`,
            ...satisfied.map((item) => `- ${item.displayPath}: ${item.reason}`),
          ].join("\n")
    const satisfiedFiles = satisfied.map((item) => ({
      type: item.type,
      path: item.displayPath,
      ...(item.moveDisplayPath ? { movePath: item.moveDisplayPath } : {}),
      reason: item.reason,
    }))
    const plannedResolutions = files.map((item) => ({ ...item, status: "ready" as const }))
    const satisfiedResolutions = satisfiedFiles.map((item) => ({ ...item, status: "satisfied" as const }))
    if (mode === false) {
      const resolution = resolutionSummary({
        requested: parsed.hunks.length,
        ready: actionable.length,
        applied: 0,
        satisfied: satisfied.length,
        conflicted: conflicts.length,
        dryRun: true,
      })
      return {
        result: {
          title: "patch plan",
          output:
            Core.formatPlan({
              format: parsed.format,
              files,
              showDiff: input.showDiff ?? false,
              diffs: planned.map((item) => item.diff),
              mode: "dry-run",
            }) + conflictSummary + satisfiedSummary,
          metadata: {
            format: parsed.format,
            fileCount: actionable.length,
            applied: false,
            files,
            conflicts,
            satisfied: satisfiedFiles,
            resolution,
            resolutions: [
              ...plannedResolutions,
              ...satisfiedResolutions,
              ...conflicts.map((item) => ({ ...item, status: "conflict" as const })),
            ],
          },
          mutation: { attempted: false, committed: false },
        },
        touched: [],
      }
    }
    if (actionable.length === 0) {
      const resolution = resolutionSummary({
        requested: parsed.hunks.length,
        ready: 0,
        applied: 0,
        satisfied: satisfied.length,
        conflicted: conflicts.length,
        dryRun: false,
      })
      return {
        result: {
          title: "patch",
          output: Core.noChangesMessage(true) + conflictSummary + satisfiedSummary,
          metadata: {
            format: parsed.format,
            fileCount: 0,
            applied: false,
            files,
            conflicts,
            satisfied: satisfiedFiles,
            resolution,
            resolutions: [
              ...satisfiedResolutions,
              ...conflicts.map((item) => ({ ...item, status: "conflict" as const })),
            ],
          },
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
    const transaction =
      mode === true
        ? yield* ExchangeFileMutation.commit(
            fs,
            targets,
            {
              prepare: () => Effect.succeed({ changes, value: undefined }),
              revalidate: hooks.revalidate,
              beforeCommit: hooks.beforeCommit,
            },
            signal,
            attribution,
          ).pipe(Effect.map((result) => ({ ...result, conflicts: [] as const })))
        : yield* ExchangeFileMutation.commitIndependent(
            fs,
            targets,
            {
              prepare: () => Effect.succeed({ changes, value: undefined }),
              revalidate: hooks.revalidate,
              beforeCommit: hooks.beforeCommit,
            },
            signal,
            attribution,
          )
    for (const conflict of transaction.conflicts) {
      conflicts.push({ path: conflict.change.displayPath, detail: conflict.detail, phase: "commit" })
    }
    const committed = new Set(transaction.changes.map((change) => FSUtil.normalizePath(change.path)))
    const applied = actionable.filter((item) => committed.has(FSUtil.normalizePath(item.path)))
    const appliedFiles = applied.map((item) => ({
      type: item.type,
      path: item.displayPath,
      ...(item.moveDisplayPath ? { movePath: item.moveDisplayPath } : {}),
      additions: item.additions,
      deletions: item.deletions,
    }))
    const finalConflictSummary =
      conflicts.length === 0
        ? ""
        : [
            "",
            `Skipped ${conflicts.length} conflicting file operation${conflicts.length === 1 ? "" : "s"}; independently safe siblings were preserved/applied:`,
            ...conflicts.map((conflict) => `- ${conflict.path}: ${conflict.detail}`),
          ].join("\n")
    const finalSatisfiedSummary = satisfiedSummary
    const resolution = resolutionSummary({
      requested: parsed.hunks.length,
      ready: actionable.length,
      applied: applied.length,
      satisfied: satisfied.length,
      conflicted: conflicts.length,
      dryRun: false,
    })

    return {
      result: {
        title: transaction.committed ? `patch: applied ${applied.length} changes` : "patch: no changes applied",
        output:
          (transaction.committed
            ? Core.formatApplySummary({
                format: parsed.format,
                files: appliedFiles,
                mode: mode === true ? "apply" : "if-clean",
              })
            : "patch: no independently safe changes remained at commit time") + finalConflictSummary + finalSatisfiedSummary,
        metadata: {
          format: parsed.format,
          fileCount: applied.length,
          applied: transaction.committed,
          files: appliedFiles,
          conflicts,
          satisfied: satisfiedFiles,
          resolution,
          resolutions: [
            ...appliedFiles.map((item) => ({ ...item, status: "applied" as const })),
            ...satisfiedResolutions,
            ...conflicts.map((item) => ({ ...item, status: "conflict" as const })),
          ],
          ...(input.showDiff ? { diff: applied.map((item) => item.diff).join("\n") } : {}),
        },
        mutation: { attempted: true, committed: transaction.committed },
      },
      touched: applied.map((item) => ({
        type: item.type,
        sourcePath: item.path,
        ...(item.movePath ? { targetPath: item.movePath } : item.type === "delete" ? {} : { targetPath: item.path }),
      })),
    }
  })
}

