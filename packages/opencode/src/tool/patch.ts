import * as path from "path"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { InstanceState } from "@/effect/instance-state"
import { Patch } from "../patch"
import { createTwoFilesPatch } from "diff"
import { assertExternalDirectoryEffect } from "./external-directory"
import { Conflict } from "./conflict"
import { withFileLocks } from "./file-lock"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { EventV2 } from "@opencode-ai/core/event"
import { Format } from "../format"
import * as Bom from "@/util/bom"
import * as Core from "./patch/core"
import { deriveContent } from "./patch/resolve"
import { withRollback, type Restorable } from "./patch/rollback"
import {
  enforce as enforcePriorReadEffect,
  globalReadCache,
  noteDelete as noteSessionDelete,
  noteMove as noteSessionMove,
  noteWrite as noteSessionWrite,
} from "./edit/prior-read"
import { Option } from "effect"
import DESCRIPTION from "./patch.txt"

export const Parameters = Schema.Struct({
  patchText: Schema.String.annotate({
    description:
      "The patch text: either the opencode format (*** Begin Patch / *** Add File: / *** Update File: + @@ hunks / *** Delete File: / *** End Patch) or a git-style unified diff (--- a/x, +++ b/x, @@ hunks). PREFERRED over multiple edit calls for any bulk/multi-file/multi-hunk work.",
  }),
  apply: Schema.optional(Schema.Union([Schema.Boolean, Schema.Literal("if-clean")])).annotate({
    description:
      "Apply the patchText: true = apply (fail hard on conflicts), false = dry-run plan only (never writes or asks), 'if-clean' (default) = ask once with the full diff and apply when zero conflicts, else return the plan.",
  }),
  format: Schema.optional(Schema.Literals(["auto", "opencode", "git"])).annotate({
    description: "Patch format hint. 'auto' detects from the patch text (default).",
  }),
  showDiff: Schema.optional(Schema.Boolean).annotate({
    description: "Include the per-file diffs in the plan output (default false — the plan is intentionally token-lean).",
  }),
})

type FileChange = {
  filePath: string
  relPath: string
  oldContent: string
  newContent: string
  type: "add" | "update" | "delete" | "move"
  movePath?: string
  diff: string
  additions: number
  deletions: number
  bom: boolean
  warnings: string[]
  conflict?: string
}

export type PatchExecutorServices = {
  lsp: LSP.Interface
  afs: FSUtil.Interface
  format: Format.Interface
  events: EventV2.Interface
}

// Shared bulk-edit executor: parses both patch formats, validates EVERY hunk
// before ANY write (atomic), dry-run plan by default. Used by the `patch`
// tool AND by the unified `edit` tool's patchText branch, so multi-location
// work costs ONE tool call (one context processing) instead of an
// edit-in-a-loop (n calls, n reprocessings).
export const runPatchEffect = Effect.fn("PatchExecutor.run")(function* (
  services: PatchExecutorServices,
  params: Schema.Schema.Type<typeof Parameters>,
  ctx: Tool.Context,
) {
  const { lsp, afs, format, events } = services
      if (!params.patchText) {
        return yield* Effect.fail(new Error("patchText is required"))
      }

      // ── Parse: opencode format or git-style unified diff (auto-detected) ──
      const want = params.format ?? "auto"
      const detected = Core.detectFormat(params.patchText)
      let hunks: Patch.Hunk[] = []
      let fmt: Core.PatchFormat

      const parseNative = (): Patch.Hunk[] => Patch.parsePatch(params.patchText).hunks
      const parseGit = (): Patch.Hunk[] => {
        const h = Core.translateGitDiff(params.patchText)
        if (!h) throw new Error("not a translatable git-style diff")
        return h
      }

      try {
        if (want === "opencode" || (want === "auto" && detected === "opencode")) {
          fmt = "opencode"
          hunks = parseNative()
          if (hunks.length === 0) {
            if (params.patchText.trim() === "*** Begin Patch\n*** End Patch") {
              return yield* Effect.fail(new Error("patch rejected: empty patch"))
            }
            return yield* Effect.fail(new Error(Core.noOpsError("opencode")))
          }
        } else if (want === "git" || (want === "auto" && detected === "git")) {
          fmt = "git"
          hunks = parseGit()
          if (hunks.length === 0) return yield* Effect.fail(new Error(Core.noOpsError("git")))
        } else {
          return yield* Effect.fail(new Error(Core.instructiveParseError(null, null, params.patchText)))
        }
      } catch (error) {
        const errFmt: Core.PatchFormat | null =
          want === "auto" ? detected : want === "opencode" ? "opencode" : "git"
        return yield* Effect.fail(new Error(Core.instructiveParseError(errFmt, error, params.patchText)))
      }

      const instance = yield* InstanceState.context
      const rel = (p: string) => path.relative(instance.worktree, p).replaceAll("\\", "/")

      // ── Build per-file changes, validating EVERY hunk before any write ──
      const fileChanges: FileChange[] = []
      const planWarnings: string[] = []
      const conflict = (filePath: string, type: FileChange["type"], reason: string): FileChange => ({
        filePath,
        relPath: rel(filePath),
        oldContent: "",
        newContent: "",
        type,
        diff: "",
        additions: 0,
        deletions: 0,
        bom: false,
        warnings: [],
        conflict: `${type}: ${reason}`,
      })
      // Prior-read staleness surfaces as a conflict, not a throw: the bulk
      // pathway validates everything first, and a file that moved under the
      // model belongs in the plan alongside hunk mismatches.
      const checkFresh = (filePath: string) =>
        enforcePriorReadEffect(Option.some(globalReadCache), afs, ctx.sessionID, filePath, "patch")

      // Merge repeated sections for one path. Every update hunk derives from
      // on-disk bytes independently, so without merging the last write would
      // silently discard the earlier ones. Add+update composes (the update
      // applies to the added contents); duplicate adds, renames that
      // disagree, deletes combined with anything, and updates landing on a
      // rename destination are explicit conflicts instead of silent loss.
      const mergedHunks: Patch.Hunk[] = []
      const earlyConflicts: Array<{ path: string; reason: string }> = []
      const updateIndexByPath = new Map<string, number>()
      const seedByPath = new Map<string, { text: string; bom: boolean }>()
      const deletedPaths = new Set<string>()
      const moveDestinations = new Set<string>()
      for (const hunk of hunks) {
        if (hunk.type === "add") {
          if (seedByPath.has(hunk.path)) {
            earlyConflicts.push({
              path: hunk.path,
              reason: "duplicate *** Add File: sections for one path in a single patch",
            })
            continue
          }
          // Mirrors the add branch below: seeds carry the trailing newline.
          const raw = hunk.contents.length === 0 || hunk.contents.endsWith("\n") ? hunk.contents : `${hunk.contents}\n`
          const next = Bom.split(raw)
          seedByPath.set(hunk.path, { text: next.text, bom: next.bom })
          mergedHunks.push(hunk)
          continue
        }
        if (hunk.type === "delete") {
          deletedPaths.add(hunk.path)
          mergedHunks.push(hunk)
          continue
        }
        if (hunk.move_path) moveDestinations.add(hunk.move_path)
        const at = updateIndexByPath.get(hunk.path)
        const prior = at === undefined ? undefined : mergedHunks[at]
        if (prior === undefined || prior.type !== "update") {
          updateIndexByPath.set(hunk.path, mergedHunks.length)
          mergedHunks.push(hunk)
        } else if ((prior.move_path ?? null) !== (hunk.move_path ?? null)) {
          earlyConflicts.push({
            path: hunk.path,
            reason: `conflicting renames in one patch (${prior.move_path ?? "(no rename)"} vs ${hunk.move_path ?? "(no rename)"})`,
          })
        } else {
          prior.chunks.push(...hunk.chunks)
        }
      }
      // Chunk resolution (order-independent, uniqueness-arbitrated) happens in
      // ./patch/resolve at derive time below — every chunk is located against
      // the original bytes without assuming input order, so no pre-sorting
      // pass is needed here. Merged sections flow through untouched.
      const orderedHunks: Patch.Hunk[] = mergedHunks
      for (const hunk of orderedHunks) {
        const filePath = path.resolve(instance.directory, hunk.path)
        yield* assertExternalDirectoryEffect(ctx, filePath)

        if (hunk.type === "add") {
          const raw =
            hunk.contents.length === 0 || hunk.contents.endsWith("\n") ? hunk.contents : `${hunk.contents}\n`
          const next = Bom.split(raw)
          Core.assertTextContent(next.text, filePath)
          const diff = Core.trimDiff(createTwoFilesPatch(filePath, filePath, "", next.text))
          const { additions, deletions } = Core.countPatchChanges(diff)
          fileChanges.push({
            filePath,
            relPath: rel(filePath),
            oldContent: "",
            newContent: next.text,
            type: "add",
            diff,
            additions,
            deletions,
            bom: next.bom,
            warnings: [],
          })
        } else if (hunk.type === "update") {
          if (deletedPaths.has(hunk.path)) {
            fileChanges.push(conflict(filePath, "update", "path is also deleted in this same patch; drop one of the two sections"))
            continue
          }
          if (moveDestinations.has(hunk.path)) {
            fileChanges.push(conflict(filePath, "update", "path is the destination of a rename in this same patch; retarget the update at the renamed path in a follow-up call"))
            continue
          }
          const stats = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (stats?.type === "Directory") {
            fileChanges.push(conflict(filePath, "update", "path is a directory, not a file"))
            continue
          }
          const seed = seedByPath.get(hunk.path)
          if (!stats && seed === undefined) {
            const hint = yield* Conflict.missingFileHint(afs, filePath)
            fileChanges.push(conflict(filePath, "update", hint ? `file not found; ${hint}` : "file not found"))
            continue
          }
          let baseText: string
          let diffBase: string
          let baseBom: boolean
          if (seed === undefined) {
            const fresh = yield* checkFresh(filePath)
            if (fresh.refusal) {
              fileChanges.push(conflict(filePath, "update", fresh.refusal))
              continue
            }
            if (fresh.warning) planWarnings.push(`${rel(filePath)}: ${fresh.warning}`)
            const onDisk = yield* Bom.readFile(afs, filePath)
            try {
              Core.assertTextContent(onDisk.text, filePath)
            } catch (error) {
              fileChanges.push(
                conflict(filePath, "update", error instanceof Error ? error.message : String(error)),
              )
              continue
            }
            baseText = Bom.join(onDisk.text, onDisk.bom)
            diffBase = onDisk.text
            baseBom = onDisk.bom
          } else {
            baseText = Bom.join(seed.text, seed.bom)
            diffBase = seed.text
            baseBom = seed.bom
          }
          try {
            // Two-pass, order-independent, uniqueness-arbitrated resolution
            // (./patch/resolve): replaces the cursor resolver + pre-sort.
            const derived = deriveContent(baseText, hunk.chunks, filePath)
            const next = Bom.split(derived.content)
            const diff = Core.trimDiff(createTwoFilesPatch(filePath, filePath, diffBase, next.text))
            const { additions, deletions } = Core.countPatchChanges(diff)
            const movePath = hunk.move_path ? path.resolve(instance.directory, hunk.move_path) : undefined
            if (movePath) yield* assertExternalDirectoryEffect(ctx, movePath)
            for (const w of derived.warnings) planWarnings.push(`${rel(filePath)}: ${w}`)
            fileChanges.push({
              filePath,
              relPath: rel(movePath ?? filePath),
              oldContent: diffBase,
              newContent: next.text,
              type: movePath ? "move" : "update",
              movePath,
              diff,
              additions,
              deletions,
              bom: next.bom || baseBom,
              warnings: derived.warnings,
            })
          } catch (error) {
            fileChanges.push(
              conflict(
                filePath,
                "update",
                Conflict.patchConflictDetail({ content: diffBase, chunks: hunk.chunks, error }),
              ),
            )
          }
        } else {
          if (seedByPath.has(hunk.path) || updateIndexByPath.has(hunk.path)) {
            fileChanges.push(conflict(filePath, "delete", "path is also added or updated in this same patch; drop one of the sections"))
            continue
          }
          const fresh = yield* checkFresh(filePath)
          if (fresh.refusal) {
            fileChanges.push(conflict(filePath, "delete", fresh.refusal))
            continue
          }
          if (fresh.warning) planWarnings.push(`${rel(filePath)}: ${fresh.warning}`)
          const source = yield* Bom.readFile(afs, filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (source === undefined) {
            const hint = yield* Conflict.missingFileHint(afs, filePath)
            fileChanges.push(conflict(filePath, "delete", hint ? `file not found; ${hint}` : "file not found"))
            continue
          }
          const diff = Core.trimDiff(createTwoFilesPatch(filePath, filePath, source.text, ""))
          const { additions, deletions } = Core.countPatchChanges(diff)
          fileChanges.push({
            filePath,
            relPath: rel(filePath),
            oldContent: source.text,
            newContent: "",
            type: "delete",
            diff,
            additions,
            deletions,
            bom: source.bom,
            warnings: [],
          })
        }
      }

      for (const early of earlyConflicts) {
        fileChanges.push(conflict(path.resolve(instance.directory, early.path), "update", early.reason))
      }

      const conflicts = fileChanges.filter((c) => c.conflict)
      const actionable = fileChanges.filter((c) => !c.conflict && (c.type !== "update" || c.oldContent !== c.newContent))

      const planFiles = (): Core.PlanFile[] =>
        fileChanges.map((c) => ({
          type: c.type,
          // For moves the plan reads `R <source> -> <dest>`, so path = source.
          path: c.type === "move" ? rel(c.filePath) : c.relPath,
          movePath: c.movePath ? rel(c.movePath) : undefined,
          additions: c.additions,
          deletions: c.deletions,
          conflict: c.conflict,
        }))
      const filesMeta = (list: FileChange[]) =>
        list.map((c) => ({
          filePath: c.filePath,
          relativePath: c.relPath,
          type: c.type,
          patch: c.diff,
          additions: c.additions,
          deletions: c.deletions,
          ...(c.movePath ? { movePath: c.movePath } : {}),
        }))

      // "if-clean" (default): validate; with zero conflicts, ask once with the
      // full diff and apply in this same call. Explicit apply:false always
      // returns the dry-run plan without writing or asking.
      const auto = params.apply ?? "if-clean"
      const warningsSuffix =
        planWarnings.length > 0 ? `\n\nWarnings:\n${planWarnings.map((w) => `  - ${w}`).join("\n")}` : ""
      const buildPlanResult = (mode: "dry-run" | "if-clean") => ({
        title: "patch plan",
        output:
          (conflicts.length === 0 && actionable.length === 0
            ? Core.noChangesMessage(false)
            : Core.formatPlan({
                mode,
                format: fmt,
                files: planFiles(),
                showDiff: params.showDiff ?? false,
                diffs: fileChanges.map((c) => c.diff),
              })) + warningsSuffix,
        metadata: {
          format: fmt,
          fileCount: actionable.length,
          conflicts: conflicts.length,
          applied: false,
          // D38 — diffs are available via showDiff; do not ship them by default.
          diff: params.showDiff ? fileChanges.map((c) => c.diff).join("\n") : "",
          files: params.showDiff
            ? filesMeta(fileChanges)
            : filesMeta(fileChanges).map((f) => ({ ...f, patch: "" })),
          diagnostics: {},
          warnings: planWarnings,
        },
      })
      // ── Dry-run (explicit review): compact plan, no writes, no permission ask ──
      if (auto === false) {
        return buildPlanResult("dry-run")
      }

      // ── Apply: conflicts abort everything (atomic — nothing written) ──
      if (conflicts.length > 0) {
        if (auto === "if-clean") {
          // Conflicted if-clean behaves like an explicit dry-run: return the
          // plan (nothing written, nothing asked) instead of failing.
          return buildPlanResult("if-clean")
        }
        const detail = conflicts.map((c) => `  ${c.relPath}: ${c.conflict}`).join("\n")
        return yield* Effect.fail(
          new Error(
            `patch verification failed for ${conflicts.length} file(s):\n${detail}\n\nNothing was applied. Fix the hunks and resubmit.`,
          ),
        )
      }
      if (actionable.length === 0) {
        return {
          title: "patch",
          output: Core.noChangesMessage(true),
          metadata: {
            format: fmt,
            fileCount: 0,
            conflicts: 0,
            applied: false,
            diff: "",
            files: filesMeta([]),
            diagnostics: {},
          },
        }
      }

      const totalDiff = actionable.map((c) => c.diff).join("\n")
      const rels = actionable.map((c) => c.relPath)
      yield* ctx.ask({
        permission: "edit",
        patterns: rels,
        always: ["*"],
        metadata: {
          filepath: rels.join(", "),
          diff: totalDiff,
          files: filesMeta(actionable),
          mode: auto === "if-clean" ? "if-clean-apply" : "apply",
        },
      })

      // Serialize the write loop against concurrent edit/patch writes to the
      // same paths (locks in sorted path order — deadlock-free). The
      // permission prompt above stays outside the locks: never hold them
      // across a human approval wait.
      const targets = actionable.flatMap((c) => (c.movePath ? [c.filePath, c.movePath] : [c.filePath]))
      // Journal for rollback: every write is either committed or unwound, so
      // a mid-loop failure can no longer leave a half-applied refactor.
      const journal: Restorable[] = []
      for (const change of actionable) {
        if (change.type === "move") {
          const destPrior = yield* Bom.readFile(afs, change.movePath!).pipe(Effect.catch(() => Effect.succeed(undefined)))
          journal.push({
            filePath: change.movePath!,
            existedBefore: destPrior !== undefined,
            contentBefore: destPrior?.text ?? "",
            bom: destPrior?.bom ?? change.bom,
          })
          journal.push({ filePath: change.filePath, existedBefore: true, contentBefore: change.oldContent, bom: change.bom })
        } else if (change.type === "add") {
          journal.push({ filePath: change.filePath, existedBefore: false, contentBefore: "", bom: change.bom })
        } else {
          journal.push({ filePath: change.filePath, existedBefore: true, contentBefore: change.oldContent, bom: change.bom })
        }
      }
      const applyAll = Effect.gen(function* () {
        // ── Apply (mirrors apply_patch: BOM, format sync, events, LSP) ──
        const updates: Array<{ file: string; event: "add" | "change" | "unlink" }> = []
        yield* withRollback(
          afs,
          journal,
          Effect.gen(function* () {
        for (const change of actionable) {
          const edited = change.type === "delete" ? undefined : (change.movePath ?? change.filePath)
          switch (change.type) {
            case "add":
            case "update":
              yield* afs.writeWithDirs(change.movePath ?? change.filePath, Bom.join(change.newContent, change.bom))
              updates.push({ file: change.movePath ?? change.filePath, event: change.type === "add" ? "add" : "change" })
              break
            case "move":
              yield* afs.writeWithDirs(change.movePath!, Bom.join(change.newContent, change.bom))
              yield* afs.remove(change.filePath)
              updates.push({ file: change.filePath, event: "unlink" })
              updates.push({ file: change.movePath!, event: "add" })
              break
            case "delete":
              yield* afs.remove(change.filePath)
              updates.push({ file: change.filePath, event: "unlink" })
              break
          }
          if (edited) {
            if (yield* format.file(edited)) {
              yield* Bom.syncFile(afs, edited, change.bom)
            }
            yield* events.publish(FileSystem.Event.Edited, { file: edited })
          }
        }
          }),
        )
        for (const update of updates) {
          yield* events.publish(Watcher.Event.Updated, update)
        }
      })
      yield* withFileLocks(targets, applyAll)

      for (const change of actionable) {
        if (change.type === "delete") {
          noteSessionDelete(globalReadCache, ctx.sessionID, change.filePath)
          continue
        }
        if (change.type === "move") {
          yield* noteSessionMove(globalReadCache, afs, ctx.sessionID, change.filePath, change.movePath!)
          continue
        }
        yield* noteSessionWrite(globalReadCache, afs, ctx.sessionID, change.filePath)
      }

      for (const change of actionable) {
        if (change.type === "delete") continue
        const target = change.movePath ?? change.filePath
        yield* lsp.touchFile(target, "document")
      }
      const diagnostics = yield* lsp.diagnostics()

      let output = Core.formatApplySummary({
        mode: auto === true ? "apply" : "if-clean",
        format: fmt,
        files: actionable.map((c) => ({
          type: c.type,
          path: c.type === "move" ? rel(c.filePath) : c.relPath,
          movePath: c.movePath ? rel(c.movePath) : undefined,
          additions: c.additions,
          deletions: c.deletions,
        })),
      })
      for (const change of actionable) {
        if (change.type === "delete") continue
        const target = change.movePath ?? change.filePath
        const block = LSP.Diagnostic.report(target, diagnostics[FSUtil.normalizePath(target)] ?? [])
        if (!block) continue
        output += `\n\nLSP errors detected in ${rel(target)}, please fix:\n${block}`
      }
      if (planWarnings.length > 0) {
        output += `\n\nWarnings:\n${planWarnings.map((w) => `  - ${w}`).join("\n")}`
      }

      return {
        title: `patch: applied ${actionable.length} changes`,
        output,
        metadata: {
          diff: totalDiff,
          files: filesMeta(actionable),
          diagnostics,
          format: fmt,
          applied: true,
          fileCount: actionable.length,
          conflicts: 0,
          warnings: planWarnings,
        },
      }
})

export const PatchTool = Tool.define(
  "patch",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* FSUtil.Service
    const format = yield* Format.Service
    const events = yield* EventV2Bridge.Service
    const services: PatchExecutorServices = { lsp, afs, format, events }

    const run = Effect.fn("PatchTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      return yield* runPatchEffect(services, params, ctx)
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
