import { Effect, Option, Schema } from "effect"
import * as path from "path"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import { Diagnostic } from "@/lsp/diagnostic"
import { createTwoFilesPatch, diffLines } from "diff"
import DESCRIPTION from "./write.txt"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { Format } from "../format"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { trimDiff } from "./edit"
import { atomicWrite, resolveWithin } from "./edit/commit"
import { withLock } from "./file-lock"
import { assertExternalDirectoryEffect } from "./external-directory"
import * as Bom from "@/util/bom"
import { AppProcess } from "@opencode-ai/core/process"
import { TypecheckScope } from "./typecheck-scope"
import { globalReadCache, noteWrite as noteSessionWrite } from "./edit/prior-read"
import { adaptWriteTerminators } from "@opencode-ai/core/line-ending"

export const Parameters = Schema.Struct({
  content: Schema.String.annotate({ description: "The content to write to the file" }),
  filePath: Schema.String.annotate({
    description: "File path to create or replace. Absolute paths are accepted; relative paths resolve from the project directory.",
  }),
  runTypecheck: Schema.optional(Schema.Boolean).annotate({
    description: "After writing, run a scoped tsgo/tsc check on this file and append the result (default false)",
  }),
})

export const WriteTool = Tool.define(
  "write",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const fs = yield* FSUtil.Service
    const events = yield* EventV2Bridge.Service
    const format = yield* Format.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { content: string; filePath: string; runTypecheck?: boolean }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (params.filePath.trim().length === 0) return yield* Effect.fail(new Error("filePath must not be empty"))
          if (params.filePath.includes("\0")) return yield* Effect.fail(new Error("filePath must not contain a NUL byte"))
          const instance = yield* InstanceState.context
          const requestedPath = path.isAbsolute(params.filePath)
            ? path.resolve(params.filePath)
            : path.resolve(instance.directory, params.filePath)
          const target = yield* resolveWithin(fs, instance.worktree, requestedPath)
          const filepath = target.real
          if (!target.inside) yield* assertExternalDirectoryEffect(ctx, filepath)

          const current = yield* fs.stat(filepath).pipe(
            Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)),
          )
          const exists = current !== undefined
          if (current && current.type !== "File") {
            return yield* Effect.fail(new Error(`Path is not a file: ${filepath}`))
          }
          const source = exists ? yield* Bom.readFile(fs, filepath) : { bom: false, text: "" }
          const next = Bom.split(params.content)
          const desiredBom = source.bom || next.bom
          const contentOld = source.text
          const contentNew = exists ? adaptWriteTerminators(source.text, next.text) : next.text
          const relative = path.relative(instance.worktree, filepath)

          // A whole-file write that already matches is not a mutation: skip
          // permission, formatter, events, and LSP churn just like edit no-ops.
          if (exists && contentNew === contentOld && desiredBom === source.bom) {
            const metadata = {
              diff: "",
              filediff: { file: filepath, patch: "", additions: 0, deletions: 0 },
              diagnostics: {},
              filepath,
              exists: true,
              applied: 0,
              strategy: "write",
            }
            yield* ctx.metadata({ metadata })
            return { title: relative, output: "No changes to write (applied=0).", metadata }
          }

          const plannedDiff = trimDiff(createTwoFilesPatch(filepath, filepath, contentOld, contentNew))
          yield* ctx.ask({
            permission: "edit",
            patterns: [relative],
            always: ["*"],
            metadata: {
              filepath,
              diff: plannedDiff,
              applied: 1,
              strategy: "write",
            },
          })

          const finalContent = yield* withLock(
            filepath,
            Effect.gen(function* () {
              const current = yield* fs.stat(filepath).pipe(
                Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)),
              )
              if (exists !== (current !== undefined)) {
                return yield* Effect.fail(
                  new Error(`File ${filepath} changed while write approval was pending. Nothing was written; re-read and reissue the write.`),
                )
              }
              if (current) {
                if (current.type !== "File") {
                  return yield* Effect.fail(new Error(`Path is no longer a file: ${filepath}. Nothing was written.`))
                }
                const latest = yield* Bom.readFile(fs, filepath)
                if (latest.text !== source.text || latest.bom !== source.bom) {
                  return yield* Effect.fail(
                    new Error(`File ${filepath} changed while write approval was pending. Nothing was written; re-read and reissue the write.`),
                  )
                }
              }

              yield* atomicWrite(fs, filepath, Bom.join(contentNew, desiredBom))
              let text = contentNew
              if (yield* format.file(filepath)) {
                const formatted = yield* Bom.readFile(fs, filepath)
                text = adaptWriteTerminators(contentNew, formatted.text)
                if (formatted.bom !== desiredBom || text !== formatted.text) {
                  yield* atomicWrite(fs, filepath, Bom.join(text, desiredBom))
                }
              }
              yield* noteSessionWrite(globalReadCache, fs, ctx.sessionID, filepath)
              yield* events.publish(FileSystem.Event.Edited, { file: filepath })
              yield* events.publish(Watcher.Event.Updated, {
                file: filepath,
                event: exists ? "change" : "add",
              })
              return text
            }),
          )

          let additions = 0
          let deletions = 0
          for (const change of diffLines(contentOld, finalContent)) {
            if (change.added) additions += change.count || 0
            if (change.removed) deletions += change.count || 0
          }
          const diff = trimDiff(createTwoFilesPatch(filepath, filepath, contentOld, finalContent))
          const filediff = { file: filepath, patch: diff, additions, deletions }

          let output = "Wrote file successfully."
          if (params.runTypecheck && TypecheckScope.isTsFile(filepath)) {
            const app = yield* Effect.serviceOption(AppProcess.Service)
            if (Option.isSome(app)) {
              const dir = path.dirname(filepath)
              const tsconfigDir = yield* Effect.promise(() => TypecheckScope.findNearestTsconfig(dir, instance.worktree))
              if (tsconfigDir) {
                const outcome = yield* TypecheckScope.runScopedTypecheck({
                  app: app.value,
                  worktree: instance.worktree,
                  tsconfigDir,
                  files: [filepath],
                  maxErrors: 30,
                  timeoutMs: 30_000,
                  signal: ctx.abort,
                })
                const status = outcome.exitCode === 0 ? "passed" : "failed"
                output += `\n\n<typecheck status="${status}" errors="${outcome.diagnostics.length}">\nScoped tsgo check of ${path.relative(instance.worktree, filepath)}: ${status}.\n${outcome.diagnostics
                  .slice(0, 10)
                  .map((d) => `  - ${d.file}(${d.line},${d.column}): TS${d.code} [${d.severity}] ${d.message.split("\n")[0]}`)
                  .join("\n")}\n</typecheck>`
              }
            }
          }
          yield* lsp.touchFile(filepath, "document")
          const normalizedFilepath = FSUtil.normalizePath(filepath)
          const diagnostics = yield* lsp.diagnosticsFor([normalizedFilepath])
          const block = LSP.Diagnostic.report(filepath, diagnostics[normalizedFilepath] ?? [])
          if (block) output += `\n\nLSP errors detected in this file, please fix:\n${block}`

          const metadata = {
            diff,
            filediff,
            diagnostics: Diagnostic.metadataForFiles([normalizedFilepath], diagnostics),
            filepath,
            exists,
            applied: 1,
            strategy: "write",
          }
          yield* ctx.metadata({ metadata })
          return {
            title: relative,
            metadata,
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
