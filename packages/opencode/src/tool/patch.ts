import * as path from "path"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { InstanceState } from "@/effect/instance-state"
import { Patch } from "../patch"
import { createTwoFilesPatch } from "diff"
import { assertExternalDirectoryEffect } from "./external-directory"
import { trimDiff } from "./edit"
import { Conflict } from "./conflict"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Format } from "../format"
import * as Bom from "@/util/bom"
import * as Core from "./patch/core"
import DESCRIPTION from "./patch.txt"

export const Parameters = Schema.Struct({
  patchText: Schema.String.annotate({
    description: "The patch text: either the opencode format (*** Begin Patch / *** Add File: / *** Update File: + @@ hunks / *** Delete File: / *** End Patch) or a git-style unified diff (--- a/x, +++ b/x, @@ hunks)",
  }),
  apply: Schema.optional(Schema.Boolean).annotate({
    description: "Apply the patch (default false: validate and return a compact per-file plan without writing). Set true after reviewing the plan.",
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
  conflict?: string
}

export const PatchTool = Tool.define(
  "patch",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* FSUtil.Service
    const format = yield* Format.Service
    const events = yield* EventV2Bridge.Service

    const run = Effect.fn("PatchTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
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
        conflict: `${type}: ${reason}`,
      })

      for (const hunk of hunks) {
        const filePath = path.resolve(instance.directory, hunk.path)
        yield* assertExternalDirectoryEffect(ctx, filePath)

        if (hunk.type === "add") {
          const raw =
            hunk.contents.length === 0 || hunk.contents.endsWith("\n") ? hunk.contents : `${hunk.contents}\n`
          const next = Bom.split(raw)
          const diff = trimDiff(createTwoFilesPatch(filePath, filePath, "", next.text))
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
          })
        } else if (hunk.type === "update") {
          const stats = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (stats?.type === "Directory") {
            fileChanges.push(conflict(filePath, "update", "path is a directory, not a file"))
            continue
          }
          if (!stats) {
            const hint = yield* Conflict.missingFileHint(afs, filePath)
            fileChanges.push(conflict(filePath, "update", hint ? `file not found; ${hint}` : "file not found"))
            continue
          }
          const source = yield* Bom.readFile(afs, filePath)
          try {
            const fileUpdate = Patch.deriveNewContentsFromChunks(
              filePath,
              hunk.chunks,
              Bom.join(source.text, source.bom),
            )
            const diff = trimDiff(createTwoFilesPatch(filePath, filePath, source.text, fileUpdate.content))
            const { additions, deletions } = Core.countPatchChanges(diff)
            const movePath = hunk.move_path ? path.resolve(instance.directory, hunk.move_path) : undefined
            if (movePath) yield* assertExternalDirectoryEffect(ctx, movePath)
            fileChanges.push({
              filePath,
              relPath: rel(movePath ?? filePath),
              oldContent: source.text,
              newContent: fileUpdate.content,
              type: movePath ? "move" : "update",
              movePath,
              diff,
              additions,
              deletions,
              bom: fileUpdate.bom,
            })
          } catch (error) {
            fileChanges.push(
              conflict(
                filePath,
                "update",
                Conflict.patchConflictDetail({ content: source.text, chunks: hunk.chunks, error }),
              ),
            )
          }
        } else {
          const source = yield* Bom.readFile(afs, filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (source === undefined) {
            const hint = yield* Conflict.missingFileHint(afs, filePath)
            fileChanges.push(conflict(filePath, "delete", hint ? `file not found; ${hint}` : "file not found"))
            continue
          }
          const diff = trimDiff(createTwoFilesPatch(filePath, filePath, source.text, ""))
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
          })
        }
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
          movePath: c.movePath,
        }))

      // ── Dry-run (default): compact plan, no writes, no permission ask ──
      if (!params.apply) {
        const output =
          conflicts.length === 0 && actionable.length === 0
            ? Core.noChangesMessage(false)
            : Core.formatPlan({
                format: fmt,
                files: planFiles(),
                showDiff: params.showDiff ?? false,
                diffs: fileChanges.map((c) => c.diff),
              })
        return {
          title: "patch plan",
          output,
          metadata: {
            format: fmt,
            fileCount: actionable.length,
            conflicts: conflicts.length,
            applied: false,
            diff: fileChanges.map((c) => c.diff).join("\n"),
            files: filesMeta(fileChanges),
            diagnostics: {},
          },
        }
      }

      // ── Apply: conflicts abort everything (atomic — nothing written) ──
      if (conflicts.length > 0) {
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
        },
      })

      // ── Apply (mirrors apply_patch: BOM, format sync, events, LSP) ──
      const updates: Array<{ file: string; event: "add" | "change" | "unlink" }> = []
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
      for (const update of updates) {
        yield* events.publish(Watcher.Event.Updated, update)
      }

      for (const change of actionable) {
        if (change.type === "delete") continue
        const target = change.movePath ?? change.filePath
        yield* lsp.touchFile(target, "document")
      }
      const diagnostics = yield* lsp.diagnostics()

      let output = Core.formatApplySummary({
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
        },
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
