// the approaches in this edit tool are sourced from
// https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-23-25.ts
// https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/editCorrector.ts
// https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-26-25.ts

import * as path from "path"
import { Effect, Option, Schema, Semaphore } from "effect"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import * as LSPClient from "@/lsp/client"
import { createTwoFilesPatch, diffLines } from "diff"
import DESCRIPTION from "./edit.txt"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { Format } from "../format"
import { InstanceState } from "@/effect/instance-state"
import { Snapshot } from "@/snapshot"
import { assertExternalDirectoryEffect } from "./external-directory"
import { FSUtil } from "@opencode-ai/core/fs-util"
import * as Bom from "@/util/bom"
import { optional, PositiveInt } from "@opencode-ai/schema"
import { AppProcess } from "@opencode-ai/core/process"
import { TypecheckScope } from "./typecheck-scope"
import { Conflict } from "./conflict"

function normalizeLineEndings(text: string): string {
  return text.replaceAll("\r\n", "\n")
}

function detectLineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n"
}

function convertToLineEnding(text: string, ending: "\n" | "\r\n"): string {
  if (ending === "\n") return text
  return text.replaceAll("\n", "\r\n")
}

const locks = new Map<string, Semaphore.Semaphore>()

function lock(filePath: string) {
  const resolvedFilePath = FSUtil.resolve(filePath)
  const hit = locks.get(resolvedFilePath)
  if (hit) return hit

  const next = Semaphore.makeUnsafe(1)
  locks.set(resolvedFilePath, next)
  return next
}

// Batch edit op. Two shapes (union — the JSON-schema "anyOf" equivalent):
// a line-targeted op (optionally verified by oldText) or an exact replace op.
const BatchOp = Schema.Union([
  Schema.Struct({
    line: PositiveInt.annotate({
      description: "1-based line to replace",
    }),
    newText: Schema.String.annotate({ description: "Replacement text for the line" }),
    oldText: optional(Schema.String).annotate({
      description: "Optional verification: line must contain this text",
    }),
  }),
  Schema.Struct({
    oldString: Schema.String.annotate({ description: "The exact text to replace (must be unique)" }),
    newString: Schema.String.annotate({ description: "The replacement text" }),
  }),
])

export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "The absolute path to the file to modify" }),
  oldString: Schema.optional(Schema.String).annotate({ description: "The text to replace" }),
  newString: Schema.optional(Schema.String).annotate({
    description: "The text to replace it with (must be different from oldString)",
  }),
  newText: Schema.optional(Schema.String).annotate({
    description: "Replacement text for the line/range/insertAfter/appendFile/nearText strategies",
  }),
  replaceAll: Schema.optional(Schema.Boolean).annotate({
    description: "Replace all occurrences of oldString (default false)",
  }),
  line: Schema.optional(PositiveInt).annotate({
    description: "1-based line to replace with newText (line strategy)",
  }),
  oldText: Schema.optional(Schema.String).annotate({
    description: "Verification for line/range/nearText strategies: target must contain this text",
  }),
  startLine: Schema.optional(PositiveInt).annotate({
    description: "Range replace start (1-based, inclusive). Ranges over 5 lines require oldText or startAnchor.",
  }),
  endLine: Schema.optional(PositiveInt).annotate({
    description: "Range replace end (1-based, inclusive)",
  }),
  insertAfter: Schema.optional(PositiveInt).annotate({
    description: "Insert newText after this 1-based line (insertAfter strategy)",
  }),
  appendFile: Schema.optional(Schema.Boolean).annotate({
    description: "Append newText at the end of the file (appendFile strategy)",
  }),
  nearText: Schema.optional(Schema.String).annotate({
    description: "Context anchor for the nearText strategy: find oldText within ±5 lines of this text and replace it",
  }),
  edits: Schema.optional(Schema.Array(BatchOp)).annotate({
    description:
      "Batch of edits applied atomically: [{line,newText,oldText?}] or [{oldString,newString}]. Fully validated before any write.",
  }),
  runTypecheck: Schema.optional(Schema.Boolean).annotate({
    description: "After applying, run a scoped tsgo/tsc check on this file and append the result (default false)",
  }),
})

export type BatchOpType = Schema.Schema.Type<typeof BatchOp>

type EditMetadata = {
  diagnostics: Record<string, LSPClient.Diagnostic[]>
  diff: string
  filediff: Snapshot.FileDiff
  applied?: number
  strategy?: string
  oldPreview?: string
  output?: string
}

// ---------------------------------------------------------------------------
// Cheap (token-efficient) edit strategies — rails R1-R9.
//
// These are pure helpers (unit-testable like `replace()`). The exact
// oldString/newString path keeps priority and is untouched; strategies only
// run when oldString is absent. Every strategy operates on LF-normalized
// content; the execute normalizes line endings at the boundary.
// ---------------------------------------------------------------------------

export type StrategyResult = {
  content: string
  applied: number
  oldPreview?: string
}

const linesOf = (content: string) => content.split("\n")

// R4 Line verify: bounds-checked; oldText (if given) must be contained in the
// line, else reject with the actual snippet. A bare line replace is allowed
// (whole-line replace is inherently bounded) but surfaces oldPreview.
export function replaceLine(content: string, line: number, newText: string, oldText?: string): StrategyResult {
  const lines = linesOf(content)
  if (line < 1 || line > lines.length) {
    throw new Error(`Line ${line} is out of range (file has ${lines.length} lines)`)
  }
  const current = lines[line - 1]!
  if (oldText !== undefined && !current.includes(oldText)) {
    throw new Error(`Line ${line} does not contain the expected text.\nActual line: ${current.slice(0, 80)}`)
  }
  if (current === newText) return { content, applied: 0, oldPreview: current }
  const next = [...lines]
  next[line - 1] = newText
  return { content: next.join("\n"), applied: 1, oldPreview: current }
}

// R5 Range verify: bounds-checked, startLine <= endLine. Ranges spanning more
// than 5 lines require oldText (contained in the joined range) — a wide
// unanchored replace is a code-mangling vector.
export function replaceLines(
  content: string,
  startLine: number,
  endLine: number,
  newText: string,
  oldText?: string,
): StrategyResult {
  const lines = linesOf(content)
  if (startLine < 1 || endLine < startLine || endLine > lines.length) {
    throw new Error(`Invalid range ${startLine}..${endLine} (file has ${lines.length} lines)`)
  }
  const span = endLine - startLine + 1
  if (span > 5 && oldText === undefined) {
    throw new Error(
      `Range ${startLine}..${endLine} spans ${span} lines (>5) and requires oldText verification. Provide the text contained in the range, or use the exact oldString/newString path.`,
    )
  }
  const joined = lines.slice(startLine - 1, endLine).join("\n")
  if (oldText !== undefined && !joined.includes(oldText)) {
    throw new Error(
      `Range ${startLine}..${endLine} does not contain the expected text.\nFirst line: ${lines[startLine - 1]?.slice(0, 80)}`,
    )
  }
  if (joined === newText) return { content, applied: 0, oldPreview: joined }
  const next = [...lines.slice(0, startLine - 1), newText, ...lines.slice(endLine)]
  return { content: next.join("\n"), applied: 1, oldPreview: joined }
}

export function insertAfterLine(content: string, after: number, newText: string): StrategyResult {
  const lines = linesOf(content)
  if (after < 1 || after > lines.length) {
    throw new Error(`insertAfter line ${after} is out of range (file has ${lines.length} lines)`)
  }
  const next = [...lines.slice(0, after), newText, ...lines.slice(after)]
  return { content: next.join("\n"), applied: 1 }
}

// R7 Append: appends at EOF (fixes the presGEN prepend bug). Never requires
// verification — it is inherently a whole-file-tail operation.
export function appendToFile(content: string, newText: string): StrategyResult {
  if (content.length === 0) return { content: newText, applied: newText === "" ? 0 : 1 }
  const sep = content.endsWith("\n") ? "" : "\n"
  const next = content + sep + newText
  return { content: next, applied: next === content ? 0 : 1 }
}

// R3/R6 Anchor verify: nearText must match exactly one line (a multi-anchor is
// ambiguous — the tool never guesses a location); oldText must occur in
// exactly one line within the ±5 window, else reject listing the candidates.
export function replaceNear(
  content: string,
  nearText: string,
  oldText: string,
  newText: string,
): StrategyResult {
  const lines = linesOf(content)
  const anchors: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.includes(nearText)) anchors.push(i)
  }
  if (anchors.length === 0) {
    throw new Error(`nearText anchor not found: "${nearText.slice(0, 80)}" does not appear in the file. Provide the exact anchor text from the current file content.`)
  }
  if (anchors.length > 1) {
    throw new Error(
      `nearText matches multiple lines (${anchors.map((i) => i + 1).join(", ")}). Provide a more specific anchor or use the exact oldString/newString path.`,
    )
  }
  const anchor = anchors[0]!
  const start = Math.max(0, anchor - 5)
  const end = Math.min(lines.length - 1, anchor + 5)
  const candidates: number[] = []
  for (let i = start; i <= end; i++) {
    if (lines[i]!.includes(oldText)) candidates.push(i)
  }
  if (candidates.length === 0) {
    throw new Error(
      `oldText not found within ±5 lines of the nearText anchor (line ${anchor + 1}). Provide the exact text to replace.`,
    )
  }
  if (candidates.length > 1) {
    throw new Error(
      `oldText appears on multiple lines near the anchor (lines ${candidates.map((i) => i + 1).join(", ")}). Provide a more specific nearText or use the exact oldString/newString path.`,
    )
  }
  const target = candidates[0]!
  const current = lines[target]!
  const replaced = current.split(oldText).join(newText)
  if (replaced === current) return { content, applied: 0, oldPreview: current }
  const next = [...lines]
  next[target] = replaced
  return { content: next.join("\n"), applied: 1, oldPreview: current }
}

// R9 Atomic batch: every op is applied in memory; any validation failure
// rejects the whole batch and nothing is written (the single write under the
// lock makes the batch atomic). Exact ops reuse `replace()` (unique-match
// semantics); line ops reuse `replaceLine` (R4 verify per op).
export function applyBatch(content: string, edits: readonly BatchOpType[]): StrategyResult {
  let current = content
  let applied = 0
  let oldPreview: string | undefined
  for (const edit of edits) {
    if ("line" in edit) {
      const next = replaceLine(current, edit.line, normalizeLineEndings(edit.newText), edit.oldText === undefined ? undefined : normalizeLineEndings(edit.oldText))
      current = next.content
      applied += next.applied
      oldPreview = oldPreview ?? next.oldPreview
      continue
    }
    const next = replace(current, normalizeLineEndings(edit.oldString), normalizeLineEndings(edit.newString))
    if (next !== current) applied++
    current = next
  }
  return { content: current, applied, oldPreview }
}

// Strategy dispatch (rails: ambiguity guard — never guess). Exact path wins
// when oldString is present; otherwise exactly one strategy group may be set.
export function applyEditStrategy(
  content: string,
  params: {
    edits?: readonly BatchOpType[]
    line?: number
    startLine?: number
    endLine?: number
    insertAfter?: number
    appendFile?: boolean
    nearText?: string
    oldText?: string
    newText?: string
  },
): StrategyResult & { strategy: string } {
  const groups: string[] = []
  if (params.edits?.length) groups.push("edits")
  if (params.line !== undefined) groups.push("line")
  if (params.startLine !== undefined || params.endLine !== undefined) groups.push("startLine/endLine")
  if (params.insertAfter !== undefined) groups.push("insertAfter")
  if (params.appendFile) groups.push("appendFile")
  if (params.nearText !== undefined) groups.push("nearText")

  if (groups.length === 0) {
    throw new Error(
      "No edit strategy detected. Provide oldString/newString (exact path), or one of: edits, line, startLine+endLine, insertAfter, appendFile, nearText.",
    )
  }
  if (groups.length > 1) {
    throw new Error(`Ambiguous edit: multiple strategies present (${groups.join(", ")}). Provide exactly one.`)
  }

  const strategy = groups[0]!
  const newText = params.newText === undefined ? undefined : normalizeLineEndings(params.newText)
  const oldText = params.oldText === undefined ? undefined : normalizeLineEndings(params.oldText)

  if (strategy === "edits") {
    return { ...applyBatch(content, params.edits!), strategy }
  }
  if (strategy === "line") {
    if (newText === undefined) throw new Error("line strategy requires newText (the replacement text)")
    return { ...replaceLine(content, params.line!, newText, oldText), strategy }
  }
  if (strategy === "startLine/endLine") {
    if (params.startLine === undefined || params.endLine === undefined) {
      throw new Error("startLine/endLine strategy requires both startLine and endLine")
    }
    if (newText === undefined) throw new Error("startLine/endLine strategy requires newText (the replacement text)")
    return { ...replaceLines(content, params.startLine, params.endLine, newText, oldText), strategy }
  }
  if (strategy === "insertAfter") {
    if (newText === undefined) throw new Error("insertAfter strategy requires newText (the text to insert)")
    return { ...insertAfterLine(content, params.insertAfter!, newText), strategy }
  }
  if (strategy === "appendFile") {
    if (newText === undefined) throw new Error("appendFile strategy requires newText (the text to append)")
    return { ...appendToFile(content, newText), strategy }
  }
  if (strategy === "nearText") {
    if (newText === undefined) throw new Error("nearText strategy requires newText (the replacement text)")
    if (oldText === undefined || oldText === "") throw new Error("nearText strategy requires oldText (the exact text to replace)")
    return { ...replaceNear(content, normalizeLineEndings(params.nearText!), oldText, newText), strategy }
  }
  throw new Error(`Unsupported strategy: ${strategy}`)
}

export const EditTool = Tool.define<
  typeof Parameters,
  EditMetadata,
  LSP.Service | FSUtil.Service | Format.Service | EventV2Bridge.Service
>(
  "edit",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* FSUtil.Service
    const format = yield* Format.Service
    const events = yield* EventV2Bridge.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<EditMetadata>) =>
        Effect.gen(function* () {
          if (!params.filePath) {
            throw new Error("filePath is required")
          }

          const instance = yield* InstanceState.context
          const filePath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(instance.directory, params.filePath)
          yield* assertExternalDirectoryEffect(ctx, filePath)

          // Exact path has priority (back-compat; cheap params are ignored
          // when oldString is present). This branch is byte-for-byte the
          // pre-upgrade behavior.
          if (params.oldString !== undefined) {
            if (params.newString === undefined) {
              throw new Error("newString is required when oldString is provided.")
            }
            if (params.oldString === params.newString) {
              throw new Error("No changes to apply: oldString and newString are identical.")
            }
            const oldString = params.oldString
            const newString = params.newString
            return yield* exactExecute({ lsp, afs, format, events, params, oldString, newString, ctx, filePath, instance })
          }

          return yield* strategyExecute({ lsp, afs, format, events, params, ctx, filePath, instance })
        }),
    }
  }),
)

// The pre-upgrade exact edit path, kept byte-for-byte (rails already present:
// empty-oldString reject, multi-match reject, disproportionate-match guard).
const exactExecute = Effect.fn("EditTool.exact")(function* (input: {
  lsp: LSP.Interface
  afs: FSUtil.Interface
  format: Format.Interface
  events: EventV2.Interface
  params: Schema.Schema.Type<typeof Parameters>
  oldString: string
  newString: string
  ctx: Tool.Context
  filePath: string
  instance: { directory: string; worktree: string }
}) {
  const { params, oldString, newString, ctx, filePath, instance, lsp, afs, format, events } = input

  let diff = ""
  let contentOld = ""
  let contentNew = ""
  yield* lock(filePath).withPermits(1)(
    Effect.gen(function* () {
      if (oldString === "") {
        const existed = yield* afs.existsSafe(filePath)
        if (existed) {
          throw new Error(
            "oldString cannot be empty when editing an existing file. Provide the exact text to replace, or use write for an intentional full-file replacement.",
          )
        }
        const next = Bom.split(newString)
        const desiredBom = next.bom
        contentOld = ""
        contentNew = next.text
        diff = trimDiff(createTwoFilesPatch(filePath, filePath, contentOld, contentNew))
        yield* ctx.ask({
          permission: "edit",
          patterns: [path.relative(instance.worktree, filePath)],
          always: ["*"],
          metadata: {
            filepath: filePath,
            diff,
          },
        })
        yield* afs.writeWithDirs(filePath, Bom.join(contentNew, desiredBom))
        if (yield* format.file(filePath)) {
          contentNew = yield* Bom.syncFile(afs, filePath, desiredBom)
        }
        yield* events.publish(FileSystem.Event.Edited, { file: filePath })
        yield* events.publish(Watcher.Event.Updated, {
          file: filePath,
          event: "add",
        })
        return
      }

      const info = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!info) throw new Error(`File ${filePath} not found`)
      if (info.type === "Directory") throw new Error(`Path is a directory, not a file: ${filePath}`)
      const source = yield* Bom.readFile(afs, filePath)
      contentOld = source.text

      const ending = detectLineEnding(contentOld)
      const old = convertToLineEnding(normalizeLineEndings(oldString), ending)
      const replacement = convertToLineEnding(normalizeLineEndings(newString), ending)

      const next = Bom.split(replace(contentOld, old, replacement, params.replaceAll))
      const desiredBom = source.bom || next.bom
      contentNew = next.text

      diff = trimDiff(
        createTwoFilesPatch(
          filePath,
          filePath,
          normalizeLineEndings(contentOld),
          normalizeLineEndings(contentNew),
        ),
      )
      yield* ctx.ask({
        permission: "edit",
        patterns: [path.relative(instance.worktree, filePath)],
        always: ["*"],
        metadata: {
          filepath: filePath,
          diff,
        },
      })

      yield* afs.writeWithDirs(filePath, Bom.join(contentNew, desiredBom))
      if (yield* format.file(filePath)) {
        contentNew = yield* Bom.syncFile(afs, filePath, desiredBom)
      }
      yield* events.publish(FileSystem.Event.Edited, { file: filePath })
      yield* events.publish(Watcher.Event.Updated, {
        file: filePath,
        event: "change",
      })
      diff = trimDiff(
        createTwoFilesPatch(
          filePath,
          filePath,
          normalizeLineEndings(contentOld),
          normalizeLineEndings(contentNew),
        ),
      )
    }).pipe(Effect.orDie),
  )

  const result = yield* finishEdit({ ctx, filePath, instance, contentOld, contentNew, diff, lsp, strategy: "exact" })

  if (params.runTypecheck) {
    const block = yield* runTypecheckAfterEdit(filePath, instance, ctx)
    if (block) result.output += block
  }
  return result
})

// Cheap-strategy edit path (rails R1-R9). Dispatch + validation happen in
// memory before any write; the single write under the lock is atomic (R9).
const strategyExecute = Effect.fn("EditTool.strategy")(function* (input: {
  lsp: LSP.Interface
  afs: FSUtil.Interface
  format: Format.Interface
  events: EventV2.Interface
  params: Schema.Schema.Type<typeof Parameters>
  ctx: Tool.Context
  filePath: string
  instance: { directory: string; worktree: string }
}) {
  const { lsp, afs, format, events, params, ctx, filePath, instance } = input

  let diff = ""
  let contentOld = ""
  let contentNew = ""
  let applied = 1
  let oldPreview: string | undefined
  let strategy = ""

  yield* lock(filePath).withPermits(1)(
    Effect.gen(function* () {
      const info = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!info) throw new Error(`File ${filePath} not found`)
      if (info.type === "Directory") throw new Error(`Path is a directory, not a file: ${filePath}`)
      const source = yield* Bom.readFile(afs, filePath)
      contentOld = normalizeLineEndings(source.text)

      const result = applyEditStrategy(contentOld, params)
      strategy = result.strategy
      applied = result.applied
      oldPreview = result.oldPreview

      // R1 no-op detection: nothing to do, never write, never ask.
      if (applied === 0) {
        contentNew = contentOld
        return
      }

      const ending = detectLineEnding(source.text)
      const next = Bom.split(convertToLineEnding(result.content, ending))
      const desiredBom = source.bom || next.bom
      contentNew = next.text

      diff = trimDiff(createTwoFilesPatch(filePath, filePath, contentOld, normalizeLineEndings(contentNew)))
      yield* ctx.ask({
        permission: "edit",
        patterns: [path.relative(instance.worktree, filePath)],
        always: ["*"],
        metadata: {
          filepath: filePath,
          diff,
        },
      })

      yield* afs.writeWithDirs(filePath, Bom.join(contentNew, desiredBom))
      if (yield* format.file(filePath)) {
        contentNew = yield* Bom.syncFile(afs, filePath, desiredBom)
      }
      yield* events.publish(FileSystem.Event.Edited, { file: filePath })
      yield* events.publish(Watcher.Event.Updated, {
        file: filePath,
        event: "change",
      })
      diff = trimDiff(createTwoFilesPatch(filePath, filePath, contentOld, normalizeLineEndings(contentNew)))
    }).pipe(Effect.orDie),
  )

  if (applied === 0) {
    const title = path.relative(instance.worktree, filePath)
    const message = `No changes to apply: the target content already matches (strategy=${strategy}). applied=0.`
    yield* ctx.metadata({
      metadata: {
        diff: "",
        filediff: { file: filePath, patch: "", additions: 0, deletions: 0 },
        diagnostics: {},
        applied: 0,
        strategy,
      },
    })
    return {
      title,
      metadata: {
        diff: "",
        filediff: { file: filePath, patch: "", additions: 0, deletions: 0 },
        diagnostics: {},
        applied: 0,
        strategy,
        ...(oldPreview !== undefined ? { oldPreview } : {}),
      },
      output: message,
    }
  }

  const result = yield* finishEdit({ ctx, filePath, instance, contentOld, contentNew, diff, lsp, strategy, oldPreview })

  if (params.runTypecheck) {
    const block = yield* runTypecheckAfterEdit(filePath, instance, ctx)
    if (block) result.output += block
  }
  return result
})

// Shared post-write tail: diff stats, metadata, LSP diagnostics.
const finishEdit = Effect.fn("EditTool.finish")(function* (input: {
  ctx: Tool.Context
  filePath: string
  instance: { directory: string; worktree: string }
  contentOld: string
  contentNew: string
  diff: string
  lsp: LSP.Interface
  strategy: string
  oldPreview?: string
}) {
  const { ctx, filePath, instance, contentOld, contentNew, diff, lsp, strategy, oldPreview } = input

  let additions = 0
  let deletions = 0
  for (const change of diffLines(contentOld, contentNew)) {
    if (change.added) additions += change.count || 0
    if (change.removed) deletions += change.count || 0
  }
  const filediff: Snapshot.FileDiff = {
    file: filePath,
    patch: diff,
    additions,
    deletions,
  }

  yield* ctx.metadata({
    metadata: {
      diff,
      filediff,
      diagnostics: {},
      applied: 1,
      strategy,
      ...(oldPreview !== undefined ? { oldPreview } : {}),
    },
  })

  let output = `Edit applied successfully (strategy=${strategy}, +${additions}/-${deletions} lines).`
  yield* lsp.touchFile(filePath, "document")
  const diagnostics = yield* lsp.diagnostics()
  const normalizedFilePath = FSUtil.normalizePath(filePath)
  const block = LSP.Diagnostic.report(filePath, diagnostics[normalizedFilePath] ?? [])
  if (block) output += `\n\nLSP errors detected in this file, please fix:\n${block}`

  return {
    metadata: {
      diagnostics,
      diff,
      filediff,
      applied: 1,
      strategy,
      ...(oldPreview !== undefined ? { oldPreview } : {}),
    },
    title: `${path.relative(instance.worktree, filePath)}`,
    output,
  }
})

// R10 opt-in scoped typecheck after edit (default OFF; LSP diagnostics are the
// primary signal). Returns an output block to append, or undefined when the
// file is not TypeScript or the check is unavailable.
const runTypecheckAfterEdit = Effect.fn("EditTool.runTypecheck")(function* (
  filePath: string,
  instance: { directory: string; worktree: string },
  ctx: Tool.Context,
) {
  if (!TypecheckScope.isTsFile(filePath)) return undefined
  const app = yield* Effect.serviceOption(AppProcess.Service)
  if (Option.isNone(app)) return undefined
  const dir = path.dirname(filePath)
  const tsconfigDir = yield* Effect.promise(() => TypecheckScope.findNearestTsconfig(dir, instance.worktree))
  if (!tsconfigDir) return undefined
  const outcome = yield* TypecheckScope.runScopedTypecheck({
    app: app.value,
    worktree: instance.worktree,
    tsconfigDir,
    files: [filePath],
    maxErrors: 30,
    timeoutMs: 30_000,
    signal: ctx.abort,
  })
  const status = outcome.exitCode === 0 ? "passed" : "failed"
  return `\n\n<typecheck status="${status}" errors="${outcome.diagnostics.length}">\nScoped tsgo check of ${path.relative(instance.worktree, filePath)}: ${status}.\n${outcome.diagnostics
    .slice(0, 10)
    .map((d) => `  - ${d.file}(${d.line},${d.column}): TS${d.code} [${d.severity}] ${d.message.split("\n")[0]}`)
    .join("\n")}\n</typecheck>`
})

export type Replacer = (content: string, find: string) => Generator<string, void, unknown>

// Similarity thresholds for block anchor fallback matching
const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0.65
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD = 0.65

/**
 * Levenshtein distance algorithm implementation
 */
function levenshtein(a: string, b: string): number {
  // Handle empty strings
  if (a === "" || b === "") {
    return Math.max(a.length, b.length)
  }
  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost)
    }
  }
  return matrix[a.length][b.length]
}

export const SimpleReplacer: Replacer = function* (_content, find) {
  yield find
}

export const LineTrimmedReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n")
  const searchLines = find.split("\n")

  if (searchLines[searchLines.length - 1] === "") {
    searchLines.pop()
  }

  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true

    for (let j = 0; j < searchLines.length; j++) {
      const originalTrimmed = originalLines[i + j].trim()
      const searchTrimmed = searchLines[j].trim()

      if (originalTrimmed !== searchTrimmed) {
        matches = false
        break
      }
    }

    if (matches) {
      let matchStartIndex = 0
      for (let k = 0; k < i; k++) {
        matchStartIndex += originalLines[k].length + 1
      }

      let matchEndIndex = matchStartIndex
      for (let k = 0; k < searchLines.length; k++) {
        matchEndIndex += originalLines[i + k].length
        if (k < searchLines.length - 1) {
          matchEndIndex += 1 // Add newline character except for the last line
        }
      }

      yield content.substring(matchStartIndex, matchEndIndex)
    }
  }
}

export const BlockAnchorReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n")
  const searchLines = find.split("\n")

  if (searchLines.length < 3) {
    return
  }

  if (searchLines[searchLines.length - 1] === "") {
    searchLines.pop()
  }

  const firstLineSearch = searchLines[0].trim()
  const lastLineSearch = searchLines[searchLines.length - 1].trim()
  const searchBlockSize = searchLines.length
  const maxLineDelta = Math.max(1, Math.floor(searchBlockSize * 0.25))

  // Collect all candidate positions where both anchors match
  const candidates: Array<{ startLine: number; endLine: number }> = []
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i].trim() !== firstLineSearch) {
      continue
    }

    // Look for the matching last line after this first line
    for (let j = i + 2; j < originalLines.length; j++) {
      if (originalLines[j].trim() === lastLineSearch) {
        const actualBlockSize = j - i + 1
        if (Math.abs(actualBlockSize - searchBlockSize) <= maxLineDelta) {
          candidates.push({ startLine: i, endLine: j })
        }
        break // Only match the first occurrence of the last line
      }
    }
  }

  // Return immediately if no candidates
  if (candidates.length === 0) {
    return
  }

  // Handle single candidate scenario (using relaxed threshold)
  if (candidates.length === 1) {
    const { startLine, endLine } = candidates[0]
    const actualBlockSize = endLine - startLine + 1

    let similarity = 0
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2) // Middle lines only

    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalLines[startLine + j].trim()
        const searchLine = searchLines[j].trim()
        const maxLen = Math.max(originalLine.length, searchLine.length)
        if (maxLen === 0) {
          continue
        }
        const distance = levenshtein(originalLine, searchLine)
        similarity += (1 - distance / maxLen) / linesToCheck

        // Exit early when threshold is reached
        if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
          break
        }
      }
    } else {
      // No middle lines to compare, just accept based on anchors
      similarity = 1.0
    }

    if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
      let matchStartIndex = 0
      for (let k = 0; k < startLine; k++) {
        matchStartIndex += originalLines[k].length + 1
      }
      let matchEndIndex = matchStartIndex
      for (let k = startLine; k <= endLine; k++) {
        matchEndIndex += originalLines[k].length
        if (k < endLine) {
          matchEndIndex += 1 // Add newline character except for the last line
        }
      }
      yield content.substring(matchStartIndex, matchEndIndex)
    }
    return
  }

  // Calculate similarity for multiple candidates
  let bestMatch: { startLine: number; endLine: number } | null = null
  let maxSimilarity = -1

  for (const candidate of candidates) {
    const { startLine, endLine } = candidate
    const actualBlockSize = endLine - startLine + 1

    let similarity = 0
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2) // Middle lines only

    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalLines[startLine + j].trim()
        const searchLine = searchLines[j].trim()
        const maxLen = Math.max(originalLine.length, searchLine.length)
        if (maxLen === 0) {
          continue
        }
        const distance = levenshtein(originalLine, searchLine)
        similarity += 1 - distance / maxLen
      }
      similarity /= linesToCheck // Average similarity
    } else {
      // No middle lines to compare, just accept based on anchors
      similarity = 1.0
    }

    if (similarity > maxSimilarity) {
      maxSimilarity = similarity
      bestMatch = candidate
    }
  }

  // Threshold judgment
  if (maxSimilarity >= MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD && bestMatch) {
    const { startLine, endLine } = bestMatch
    let matchStartIndex = 0
    for (let k = 0; k < startLine; k++) {
      matchStartIndex += originalLines[k].length + 1
    }
    let matchEndIndex = matchStartIndex
    for (let k = startLine; k <= endLine; k++) {
      matchEndIndex += originalLines[k].length
      if (k < endLine) {
        matchEndIndex += 1
      }
    }
    yield content.substring(matchStartIndex, matchEndIndex)
  }
}

export const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
  const normalizeWhitespace = (text: string) => text.replace(/\s+/g, " ").trim()
  const normalizedFind = normalizeWhitespace(find)

  // Handle single line matches
  const lines = content.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (normalizeWhitespace(line) === normalizedFind) {
      yield line
    } else {
      // Only check for substring matches if the full line doesn't match
      const normalizedLine = normalizeWhitespace(line)
      if (normalizedLine.includes(normalizedFind)) {
        // Find the actual substring in the original line that matches
        const words = find.trim().split(/\s+/)
        if (words.length > 0) {
          const pattern = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+")
          try {
            const regex = new RegExp(pattern)
            const match = line.match(regex)
            if (match) {
              yield match[0]
            }
          } catch {
            // Invalid regex pattern, skip
          }
        }
      }
    }
  }

  // Handle multi-line matches
  const findLines = find.split("\n")
  if (findLines.length > 1) {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length)
      if (normalizeWhitespace(block.join("\n")) === normalizedFind) {
        yield block.join("\n")
      }
    }
  }
}

export const IndentationFlexibleReplacer: Replacer = function* (content, find) {
  const removeIndentation = (text: string) => {
    const lines = text.split("\n")
    const nonEmptyLines = lines.filter((line) => line.trim().length > 0)
    if (nonEmptyLines.length === 0) return text

    const minIndent = Math.min(
      ...nonEmptyLines.map((line) => {
        const match = line.match(/^(\s*)/)
        return match ? match[1].length : 0
      }),
    )

    return lines.map((line) => (line.trim().length === 0 ? line : line.slice(minIndent))).join("\n")
  }

  const normalizedFind = removeIndentation(find)
  const contentLines = content.split("\n")
  const findLines = find.split("\n")

  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const block = contentLines.slice(i, i + findLines.length).join("\n")
    if (removeIndentation(block) === normalizedFind) {
      yield block
    }
  }
}

export const EscapeNormalizedReplacer: Replacer = function* (content, find) {
  const unescapeString = (str: string): string => {
    return str.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match, capturedChar) => {
      switch (capturedChar) {
        case "n":
          return "\n"
        case "t":
          return "\t"
        case "r":
          return "\r"
        case "'":
          return "'"
        case '"':
          return '"'
        case "`":
          return "`"
        case "\\":
          return "\\"
        case "\n":
          return "\n"
        case "$":
          return "$"
        default:
          return match
      }
    })
  }

  const unescapedFind = unescapeString(find)

  // Try direct match with unescaped find string
  if (content.includes(unescapedFind)) {
    yield unescapedFind
  }

  // Also try finding escaped versions in content that match unescaped find
  const lines = content.split("\n")
  const findLines = unescapedFind.split("\n")

  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n")
    const unescapedBlock = unescapeString(block)

    if (unescapedBlock === unescapedFind) {
      yield block
    }
  }
}

export const MultiOccurrenceReplacer: Replacer = function* (content, find) {
  // This replacer yields all exact matches, allowing the replace function
  // to handle multiple occurrences based on replaceAll parameter
  let startIndex = 0

  while (true) {
    const index = content.indexOf(find, startIndex)
    if (index === -1) break

    yield find
    startIndex = index + find.length
  }
}

export const TrimmedBoundaryReplacer: Replacer = function* (content, find) {
  const trimmedFind = find.trim()

  if (trimmedFind === find) {
    // Already trimmed, no point in trying
    return
  }

  // Try to find the trimmed version
  if (content.includes(trimmedFind)) {
    yield trimmedFind
  }

  // Also try finding blocks where trimmed content matches
  const lines = content.split("\n")
  const findLines = find.split("\n")

  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n")

    if (block.trim() === trimmedFind) {
      yield block
    }
  }
}

export const ContextAwareReplacer: Replacer = function* (content, find) {
  const findLines = find.split("\n")
  if (findLines.length < 3) {
    // Need at least 3 lines to have meaningful context
    return
  }

  // Remove trailing empty line if present
  if (findLines[findLines.length - 1] === "") {
    findLines.pop()
  }

  const contentLines = content.split("\n")

  // Extract first and last lines as context anchors
  const firstLine = findLines[0].trim()
  const lastLine = findLines[findLines.length - 1].trim()

  // Find blocks that start and end with the context anchors
  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() !== firstLine) continue

    // Look for the matching last line
    for (let j = i + 2; j < contentLines.length; j++) {
      if (contentLines[j].trim() === lastLine) {
        // Found a potential context block
        const blockLines = contentLines.slice(i, j + 1)
        const block = blockLines.join("\n")

        // Check if the middle content has reasonable similarity
        // (simple heuristic: at least 50% of non-empty lines should match when trimmed)
        if (blockLines.length === findLines.length) {
          let matchingLines = 0
          let totalNonEmptyLines = 0

          for (let k = 1; k < blockLines.length - 1; k++) {
            const blockLine = blockLines[k].trim()
            const findLine = findLines[k].trim()

            if (blockLine.length > 0 || findLine.length > 0) {
              totalNonEmptyLines++
              if (blockLine === findLine) {
                matchingLines++
              }
            }
          }

          if (totalNonEmptyLines === 0 || matchingLines / totalNonEmptyLines >= 0.5) {
            yield block
            break // Only match the first occurrence
          }
        }
        break
      }
    }
  }
}

export function trimDiff(diff: string): string {
  const lines = diff.split("\n")
  const contentLines = lines.filter(
    (line) =>
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
      !line.startsWith("---") &&
      !line.startsWith("+++"),
  )

  if (contentLines.length === 0) return diff

  let min = Infinity
  for (const line of contentLines) {
    const content = line.slice(1)
    if (content.trim().length > 0) {
      const match = content.match(/^(\s*)/)
      if (match) min = Math.min(min, match[1].length)
    }
  }
  if (min === Infinity || min === 0) return diff
  const trimmedLines = lines.map((line) => {
    if (
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
      !line.startsWith("---") &&
      !line.startsWith("+++")
    ) {
      const prefix = line[0]
      const content = line.slice(1)
      return prefix + content.slice(min)
    }
    return line
  })

  return trimmedLines.join("\n")
}

export function replace(content: string, oldString: string, newString: string, replaceAll = false): string {
  if (oldString === newString) {
    throw new Error("No changes to apply: oldString and newString are identical.")
  }
  if (oldString === "") {
    throw new Error(
      "oldString cannot be empty when editing an existing file. Provide the exact text to replace, or use write for an intentional full-file replacement.",
    )
  }

  let notFound = true

  for (const replacer of [
    SimpleReplacer,
    LineTrimmedReplacer,
    BlockAnchorReplacer,
    WhitespaceNormalizedReplacer,
    IndentationFlexibleReplacer,
    EscapeNormalizedReplacer,
    TrimmedBoundaryReplacer,
    ContextAwareReplacer,
    MultiOccurrenceReplacer,
  ]) {
    for (const search of replacer(content, oldString)) {
      const index = content.indexOf(search)
      if (index === -1) continue
      notFound = false
      if (isDisproportionateMatch(search, oldString)) {
        throw new Error(
          `Refusing replacement because the matched span is much larger than oldString. Resend this exact current-file span as oldString:\n\n${Conflict.spanConflictHint({ content, span: search })}`,
        )
      }
      if (replaceAll) {
        return content.replaceAll(search, newString)
      }
      const lastIndex = content.lastIndexOf(search)
      if (index !== lastIndex) continue
      return content.substring(0, index) + newString + content.substring(index + search.length)
    }
  }

  if (notFound) {
    const message =
      "Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings."
    const hint = Conflict.replaceConflictHint({ content, needle: oldString })
    throw new Error(hint ? `${message}\n\n${hint}` : message)
  }
  const ambiguous = "Found multiple matches for oldString. Provide more surrounding context to make the match unique."
  const hint = Conflict.replaceConflictHint({ content, needle: oldString })
  throw new Error(hint ? `${ambiguous}\n\n${hint}` : ambiguous)
}

function isDisproportionateMatch(search: string, oldString: string) {
  const oldLines = oldString.split("\n").length
  const searchLines = search.split("\n").length
  if (searchLines >= Math.max(oldLines + 3, oldLines * 2)) return true
  if (oldLines === 1) return false
  return search.trim().length > Math.max(oldString.trim().length + 500, oldString.trim().length * 4)
}
