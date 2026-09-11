import * as path from "path"
import { Effect } from "effect"
import { createTwoFilesPatch, diffLines } from "diff"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { EventV2 } from "@opencode-ai/core/event"
import { LSP } from "@/lsp/lsp"
import { Format } from "../../format"
import * as Bom from "@/util/bom"
import * as Core from "./../patch/core"
import * as Fingerprint from "./fingerprint"
import type { EditPlan } from "./plan"
import type * as Tool from "./../tool"
import { withLock } from "./../file-lock"
import { globalReadCache, noteWrite as noteSessionWrite } from "./prior-read"

const NUL_SCAN_BYTES = 512

/**
 * Binary gate (D9). The read paths scan too; it lives here as well so no
 * future write path can bypass it.
 */
export function looksBinary(text: string): boolean {
  const limit = Math.min(text.length, NUL_SCAN_BYTES)
  for (let i = 0; i < limit; i++) if (text.charCodeAt(i) === 0) return true
  return false
}

/**
 * Containment check with symlink resolution (D10). The previous
 * `isAbsolute ? p : join(dir, p)` neither normalized nor resolved links, so an
 * in-worktree symlink pointing outside resolved as in-worktree and the write
 * followed the link out of the project. Callers feed `real` into the existing
 * external-directory permission flow, so an escaping link triggers the same
 * approval as a directly-external path.
 */
export const resolveWithin = Effect.fn("EditCommit.resolveWithin")(function* (
  afs: FSUtil.Interface,
  worktree: string,
  candidate: string,
) {
  const normalized = path.normalize(path.resolve(candidate))
  const real = yield* afs.realPath(normalized).pipe(Effect.catch(() => Effect.succeed(normalized)))
  const realWorktree = yield* afs.realPath(worktree).pipe(Effect.catch(() => Effect.succeed(worktree)))
  const relative = path.relative(realWorktree, real)
  const inside = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
  return { resolved: normalized, real, inside }
})

let tempCounter = 0

/**
 * Atomic write: temp file in the same directory, then rename. Rename is atomic
 * within a filesystem, so a reader never observes a partially written file and
 * a crash mid-write cannot truncate the original.
 */
export const atomicWrite = Effect.fn("EditCommit.atomicWrite")(function* (afs: FSUtil.Interface, filePath: string, bytes: string) {
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${tempCounter++}.tmp`)
  yield* afs.writeWithDirs(temp, bytes)
  yield* afs.rename(temp, filePath).pipe(
    Effect.catch((error) =>
      afs.remove(temp).pipe(
        Effect.catch(() => Effect.void),
        Effect.andThen(Effect.fail(error)),
      ),
    ),
  )
})

export type CommitServices = {
  lsp: LSP.Interface
  afs: FSUtil.Interface
  format: Format.Interface
  events: EventV2.Interface
}

export type CommitResult = {
  title: string
  output: string
  metadata: Record<string, unknown>
}

/**
 * The single write path. Order matters and is load-bearing:
 *   plan -> ask -> lock -> re-read -> re-validate-or-rebuild -> atomic write
 *   -> format -> resync -> events -> scoped diagnostics -> metadata.
 *
 * The re-validation step is what closes D6 without breaking concurrent edits
 * to different regions: the plan is rebuilt against current bytes when the
 * file moved under us, and only refused when the target no longer resolves —
 * never a blind overwrite, never a spurious failure.
 */
export const commitPlan = Effect.fn("EditCommit.commit")(function* (
  services: CommitServices,
  plan: EditPlan,
  ctx: Tool.Context,
  instance: { directory: string; worktree: string },
  options: {
    fingerprint?: Fingerprint.Fingerprint
    rebuild?: () => Effect.Effect<EditPlan>
    runTypecheckBlock?: () => Effect.Effect<string | undefined>
  } = {},
) {
  const { afs, format, events, lsp } = services
  const relative = path.relative(instance.worktree, plan.filePath)

  // R1 no-op: never ask, never write.
  if (plan.applied === 0 || plan.spans.length === 0) {
    const message =
      `No changes to apply: the target content already matches (strategy=${plan.strategy}). applied=0.` + renderWarnings(plan.warnings)
    const metadata = {
      diff: "",
      filediff: { file: plan.filePath, patch: "", additions: 0, deletions: 0 },
      diagnostics: {},
      applied: 0,
      strategy: plan.strategy,
      ...(plan.oldPreview !== undefined ? { oldPreview: plan.oldPreview } : {}),
    }
    yield* ctx.metadata({ metadata })
    return { title: relative, output: message, metadata } satisfies CommitResult
  }

  // True patch for revert/replay; trimmed copy only for display (D32).
  const truePatch = createTwoFilesPatch(plan.filePath, plan.filePath, plan.contentOld, plan.contentNew)
  const displayDiff = Core.trimDiff(truePatch)

  yield* ctx.ask({
    permission: "edit",
    patterns: [relative],
    always: ["*"],
    metadata: {
      filepath: plan.filePath,
      diff: displayDiff,
      applied: plan.applied,
      strategy: plan.strategy,
    },
  })

  const final = yield* commitLocked(services, plan, ctx, instance, options).pipe(Effect.orDie)

  let output = `Edit applied successfully (strategy=${final.plan.strategy}, applied=${final.plan.applied}, +${final.additions}/-${final.deletions} lines).`
  output += renderWarnings(final.plan.warnings)

  // D37 — the formatter can move every line in the file. Without this the
  // model's line-number model is silently stale and the NEXT line-targeted
  // call misfires.
  if (final.reformatted) {
    output +=
      `\n\nNOTE: the formatter changed this file after the edit was applied, so old line coordinates may have shifted. ` +
      `This is still a same-session change and does NOT require a re-read for freshness. Prefer exact/nearText targeting for a follow-up edit, ` +
      `or re-read only if you specifically need refreshed line numbers.`
  }

  yield* lsp.touchFile(plan.filePath, "document")
  const all = yield* lsp.diagnostics()
  const key = FSUtil.normalizePath(plan.filePath)
  // D36 — scope diagnostics metadata to this file instead of shipping the
  // whole project map on every edit.
  const scoped = { [key]: all[key] ?? [] }
  const block = LSP.Diagnostic.report(plan.filePath, all[key] ?? [])
  if (block) output += `\n\nLSP errors detected in this file, please fix:\n${block}`

  if (options.runTypecheckBlock) {
    const extra = yield* options.runTypecheckBlock()
    if (extra) output += extra
  }

  const metadata = {
    diff: displayDiff,
    filediff: final.filediff,
    diagnostics: scoped,
    applied: final.plan.applied,
    strategy: final.plan.strategy,
    ...(final.plan.oldPreview !== undefined ? { oldPreview: final.plan.oldPreview } : {}),
    ...(final.reformatted ? { reformatted: true } : {}),
  }
  yield* ctx.metadata({ metadata })
  return { title: relative, output, metadata } satisfies CommitResult
})

const commitLocked = Effect.fn("EditCommit.locked")(function* (
  services: CommitServices,
  plan: EditPlan,
  ctx: Tool.Context,
  _instance: { directory: string; worktree: string },
  options: {
    fingerprint?: Fingerprint.Fingerprint
    rebuild?: () => Effect.Effect<EditPlan>
  },
) {
  const { afs, format, events } = services
  // The permission prompt above stays outside the lock: never hold it across
  // a human approval wait. Re-read inside the lock instead.
  return yield* withLock(
    plan.filePath,
    Effect.gen(function* () {
      let active = plan
      let revalidated = false

      if (!plan.isNew) {
        const source = yield* Bom.readFile(afs, plan.filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!source) {
          throw new Error(`File ${plan.filePath} disappeared after it was read. Re-read it and reissue the edit.`)
        }
        const same =
          options.fingerprint !== undefined &&
          Fingerprint.hashContent(source.text) === options.fingerprint.hash &&
          source.text.length === options.fingerprint.size
        if (!same) {
          if (!options.rebuild) {
            throw new Error(
              `File ${plan.filePath} changed on disk after it was read (and after this edit was planned), so applying the ` +
                `edit would discard those changes. Nothing was written. Re-read the file and reissue the edit against ` +
                `its current contents.`,
            )
          }
          // Re-resolve against current bytes. A concurrent edit elsewhere in
          // the file re-validates cleanly; a moved target fails with a
          // match error telling the model to re-read. Either way nothing is
          // silently discarded.
          active = yield* options.rebuild()
          revalidated = true
        }
      } else {
        const existed = yield* afs.existsSafe(plan.filePath)
        if (existed) {
          if (!options.rebuild) {
            throw new Error(`File ${plan.filePath} was created after this edit was planned. Re-read it and reissue the edit.`)
          }
          active = yield* options.rebuild()
          revalidated = true
        }
      }

      if (looksBinary(active.contentNew)) {
        throw new Error(`Refusing to write binary content to ${plan.filePath}: NUL byte detected. This tool only edits text files.`)
      }

      yield* atomicWrite(afs, active.filePath, Bom.join(active.contentNew, active.bom))

      let finalContent = active.contentNew
      let reformatted = false
      if (yield* format.file(active.filePath)) {
        finalContent = yield* Bom.syncFile(afs, active.filePath, active.bom)
        reformatted = finalContent !== active.contentNew
      }
      yield* noteSessionWrite(globalReadCache, afs, ctx.sessionID, active.filePath)
      yield* events.publish(FileSystem.Event.Edited, { file: active.filePath })
      yield* events.publish(Watcher.Event.Updated, { file: active.filePath, event: active.isNew ? "add" : "change" })

      let additions = 0
      let deletions = 0
      for (const change of diffLines(active.contentOld, finalContent)) {
        if (change.added) additions += change.count || 0
        if (change.removed) deletions += change.count || 0
      }
      const finalPatch = createTwoFilesPatch(active.filePath, active.filePath, active.contentOld, finalContent)
      return {
        plan: revalidated
          ? { ...active, warnings: [...active.warnings, "File changed between plan and apply; re-validated against current contents."] }
          : active,
        additions,
        deletions,
        reformatted,
        filediff: { file: active.filePath, patch: finalPatch, additions, deletions },
      }
    }),
  )
})

function renderWarnings(warnings: readonly string[]): string {
  if (warnings.length === 0) return ""
  return `\n\nWarnings:\n${warnings.map((w) => `  - ${w}`).join("\n")}`
}

export * as EditCommit from "./commit"
