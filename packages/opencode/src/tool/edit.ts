// the approaches in this edit tool are sourced from
// https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-23-25.ts
// https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/editCorrector.ts
// https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-26-25.ts

import * as path from "path"
import { Effect, Option, Schema } from "effect"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import * as LSPClient from "@/lsp/client"
import DESCRIPTION from "./edit.txt"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "../format"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { FSUtil } from "@opencode-ai/core/fs-util"
import * as Bom from "@/util/bom"
import { NonNegativeInt, optional, PositiveInt } from "@opencode-ai/schema"
import { AppProcess } from "@opencode-ai/core/process"
import { TypecheckScope } from "./typecheck-scope"
import { runPatchEffect } from "./patch"
import { assertTextContent, trimDiff } from "./patch/core"
import { resolveReplacement } from "./edit/match"
import { applyEditStrategy, type BatchOpType as StrategyBatchOp } from "./edit/strategy"
import { buildPlan, type EditPlan } from "./edit/plan"
import { absorbDeletionNewline, healInput } from "./edit/heal"
import * as Fingerprint from "./edit/fingerprint"
import { commitPlan, resolveWithin, type CommitServices } from "./edit/commit"
import { enforce as enforcePriorReadEffect, globalReadCache } from "./edit/prior-read"

// trimDiff is re-exported below (next to its original definition site) so
// existing `from "./edit"` importers keep working.

// Batch edit op. Three shapes (union — the JSON-schema "anyOf" equivalent):
// a line-targeted op, a range op (optionally deleting), or an exact replace op.
const BatchOp = Schema.Union([
  Schema.Struct({
    line: PositiveInt.annotate({
      description: "1-based line to replace",
    }),
    newText: Schema.String.annotate({ description: "Replacement text for the line" }),
    oldText: optional(Schema.String).annotate({
      description: "Verification: line must contain this text (required by the tool although optional in the wire shape)",
    }),
  }),
  Schema.Struct({
    startLine: PositiveInt.annotate({ description: "Range replace start (1-based, inclusive)" }),
    endLine: PositiveInt.annotate({ description: "Range replace end (1-based, inclusive)" }),
    newText: optional(Schema.String).annotate({ description: "Replacement text for the range (omit with delete:true)" }),
    oldText: optional(Schema.String).annotate({
      description: "Verification: must span the range's endpoints for ranges over 5 lines",
    }),
    delete: optional(Schema.Boolean).annotate({ description: "Remove the range instead of replacing it" }),
  }),
  Schema.Struct({
    oldString: Schema.String.annotate({ description: "The exact text to replace (must be unique)" }),
    newString: Schema.String.annotate({ description: "The replacement text" }),
  }),
])

export const Parameters = Schema.Struct({
  filePath: Schema.optional(Schema.String).annotate({ description: "The absolute path to the file to modify (alias: file_path)" }),
  file_path: Schema.optional(Schema.String).annotate({ description: "Alias for filePath" }),
  oldString: Schema.optional(Schema.String).annotate({
    description: "The text to replace. Single-hunk only — for 2+ locations/files use the patchText bulk pathway instead of looping this tool.",
  }),
  newString: Schema.optional(Schema.String).annotate({
    description: "The text to replace it with (must be different from oldString)",
  }),
  newText: Schema.optional(Schema.String).annotate({
    description: "Replacement text for the line/range/insertAt/appendFile/nearText strategies",
  }),
  replaceAll: Schema.optional(Schema.Boolean).annotate({
    description: "Replace all occurrences of oldString (default false)",
  }),
  line: Schema.optional(PositiveInt).annotate({
    description: "1-based line to replace with newText (line strategy; oldText with the line's current text is required)",
  }),
  oldText: Schema.optional(Schema.String).annotate({
    description: "Verification for line/range/insertAt/nearText strategies: target must contain this text",
  }),
  startLine: Schema.optional(PositiveInt).annotate({
    description: "Range replace start (1-based, inclusive). Ranges over 5 lines require oldText spanning the endpoints.",
  }),
  endLine: Schema.optional(PositiveInt).annotate({
    description: "Range replace end (1-based, inclusive)",
  }),
  insertAt: Schema.optional(NonNegativeInt).annotate({
    description: "Insert newText after this line (0 = prepend before line 1; N > 0 requires oldText confirming line N)",
  }),
  insertAfter: Schema.optional(PositiveInt).annotate({
    description: "Deprecated alias for insertAt (identical semantics).",
  }),
  appendFile: Schema.optional(Schema.Boolean).annotate({
    description: "Append newText at the end of the file (appendFile strategy)",
  }),
  nearText: Schema.optional(Schema.String).annotate({
    description: "Context anchor for the nearText strategy: find oldText within ±5 lines of this text and replace it",
  }),
  occurrence: Schema.optional(PositiveInt).annotate({
    description: "nearText strategy: select the Nth anchor occurrence (1-based) when the anchor repeats",
  }),
  delete: Schema.optional(Schema.Boolean).annotate({
    description: "With startLine+endLine: remove the range instead of replacing it (no newText)",
  }),
  edits: Schema.optional(Schema.Array(BatchOp)).annotate({
    description:
      "PREFERRED when 2+ non-overlapping changes in ONE file are already known. Apply them atomically in ONE call instead of sequential edit calls: [{line,newText,oldText?}], [{startLine,endLine,newText?,oldText?,delete?}], or [{oldString,newString}]. Every op is validated against original coordinates; overlaps are rejected. For multi-file/create/delete/move work use patch/patchText.",
  }),
  runTypecheck: Schema.optional(Schema.Boolean).annotate({
    description:
      "After applying, run a scoped tsgo/tsc check on this file and append the result (default false). Single-edit pathway only — cannot be combined with patchText.",
  }),
  patchText: Schema.optional(Schema.String).annotate({
    description:
      "Bulk pathway for 2+ files, arbitrary multi-hunk changes, or structural create/delete/move work (the dedicated patch tool is also appropriate). Batch ALL known edits into ONE mutation call instead of looping edit. One context processing, one permission prompt, atomic all-or-nothing apply. Validates every hunk first ('if-clean' default: asks once and applies when zero conflicts, else returns the plan; apply:false = plan only; apply:true = fail on conflicts). Cannot be combined with filePath/oldString/line-style params.",
  }),
  apply: Schema.optional(Schema.Union([Schema.Boolean, Schema.Literal("if-clean")])).annotate({
    description:
      "Bulk pathway only: true = apply (fail hard on conflicts), false = dry-run plan only (never writes or asks), 'if-clean' (default) = ask once with the full diff and apply when zero conflicts, else return the plan.",
  }),
  format: Schema.optional(Schema.Literals(["auto", "opencode", "git"])).annotate({
    description: "Bulk pathway only: patch format hint. 'auto' detects from the patch text (default).",
  }),
  showDiff: Schema.optional(Schema.Boolean).annotate({
    description: "Bulk pathway only: include the per-file diffs in the dry-run plan (default false — the plan is intentionally token-lean).",
  }),
})

export type BatchOpType = Schema.Schema.Type<typeof BatchOp>

export type EditMetadata = {
  diagnostics: Record<string, LSPClient.Diagnostic[]>
  diff: string
  filediff?: { file: string; patch: string; additions: number; deletions: number }
  applied?: number | boolean
  strategy?: string
  oldPreview?: string
  output?: string
  warnings?: string[]
  reformatted?: boolean
  // Bulk (patchText) pathway extras — present only on that branch.
  files?: Array<{
    filePath: string
    relativePath: string
    type: string
    patch: string
    additions: number
    deletions: number
    movePath?: string
  }>
  fileCount?: number
  conflicts?: number
  format?: string
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
    const services: CommitServices = { lsp, afs, format, events }

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<EditMetadata>) =>
        Effect.gen(function* () {
          // Bulk pathway: patchText carries multi-file / multi-hunk edits in ONE
          // call (one context processing) instead of n sequential edit calls.
          if (params.patchText !== undefined) {
            const mixed: string[] = []
            if (params.filePath !== undefined || params.file_path !== undefined) mixed.push("filePath")
            if (params.oldString !== undefined) mixed.push("oldString")
            if (params.newString !== undefined) mixed.push("newString")
            if (params.newText !== undefined) mixed.push("newText")
            if (params.replaceAll !== undefined) mixed.push("replaceAll")
            if (params.line !== undefined) mixed.push("line")
            if (params.oldText !== undefined) mixed.push("oldText")
            if (params.startLine !== undefined) mixed.push("startLine")
            if (params.endLine !== undefined) mixed.push("endLine")
            if (params.insertAt !== undefined) mixed.push("insertAt")
            if (params.insertAfter !== undefined) mixed.push("insertAfter")
            if (params.appendFile !== undefined) mixed.push("appendFile")
            if (params.nearText !== undefined) mixed.push("nearText")
            if (params.occurrence !== undefined) mixed.push("occurrence")
            if (params.delete !== undefined) mixed.push("delete")
            if (params.edits !== undefined) mixed.push("edits")
            if (params.runTypecheck !== undefined) mixed.push("runTypecheck")
            if (mixed.length > 0) {
              throw new Error(
                `patchText cannot be combined with single-edit parameters (${mixed.join(", ")}). Put ALL changes into patchText (file paths inside the patch are relative to the project directory), or call again without patchText for one precise single-file edit.`,
              )
            }
            const bulk = yield* runPatchEffect(
              { lsp, afs, format, events },
              {
                patchText: params.patchText,
                apply: params.apply,
                format: params.format,
                showDiff: params.showDiff,
              },
              ctx,
            ).pipe(Effect.orDie)
            return bulk as unknown as Tool.ExecuteResult<EditMetadata>
          }

          if (params.apply !== undefined || params.format !== undefined || params.showDiff !== undefined) {
            throw new Error(
              "apply/format/showDiff require patchText (bulk pathway). Single-edit params apply immediately — there is no dry-run for one precise edit. Either add patchText with all changes, or drop these flags.",
            )
          }
          if (params.filePath !== undefined && params.file_path !== undefined && params.filePath !== params.file_path) {
            throw new Error(
              `Conflicting paths: filePath (${params.filePath}) differs from file_path (${params.file_path}). Provide exactly one.`,
            )
          }
          const filePathParam = params.filePath ?? params.file_path
          if (!filePathParam) {
            throw new Error("filePath (or file_path alias) is required")
          }

          const instance = yield* InstanceState.context
          const filePath = path.isAbsolute(filePathParam) ? filePathParam : path.join(instance.directory, filePathParam)
          // Symlink-aware containment (D10): an in-worktree link pointing
          // outside must trigger the same approval as a directly-external path.
          const within = yield* resolveWithin(afs, instance.worktree, filePath)
          yield* assertExternalDirectoryEffect(ctx, within.inside ? within.resolved : within.real)

          const runTypecheckBlock =
            params.runTypecheck === true
              ? () => runTypecheckAfterEdit(filePath, instance, ctx)
              : undefined

          // Exact path has priority (back-compat). Strategies run only when
          // oldString is absent; ambiguity between groups is refused, never guessed.
          if (params.oldString !== undefined) {
            if (params.newString === undefined) {
              throw new Error("newString is required when oldString is provided.")
            }
            const built = yield* buildExactPlan({ services, params, ctx, filePath, instance }).pipe(Effect.orDie)
            const result = yield* commitPlan(services, built.plan, ctx, instance, {
              fingerprint: built.fingerprint,
              rebuild: () => buildExactPlan({ services, params, ctx, filePath, instance }).pipe(Effect.orDie, Effect.map((b) => b.plan)),
              runTypecheckBlock,
            }).pipe(Effect.orDie)
            return result as unknown as Tool.ExecuteResult<EditMetadata>
          }

          const built = yield* buildStrategyPlan({ services, params, ctx, filePath, instance }).pipe(Effect.orDie)
          const result = yield* commitPlan(services, built.plan, ctx, instance, {
            fingerprint: built.fingerprint,
            rebuild: () => buildStrategyPlan({ services, params, ctx, filePath, instance }).pipe(Effect.orDie, Effect.map((b) => b.plan)),
            runTypecheckBlock,
          }).pipe(Effect.orDie)
          return result as unknown as Tool.ExecuteResult<EditMetadata>
        }),
    }
  }),
)

type PlanInput = {
  services: CommitServices
  params: Schema.Schema.Type<typeof Parameters>
  ctx: Tool.Context<EditMetadata>
  filePath: string
  instance: { directory: string; worktree: string }
}

// Read + validate + resolve, without asking or writing. Runs once up front
// (for the permission prompt's diff) and again inside the write lock when the
// file moved under us (re-validation, never a blind overwrite).
const buildExactPlan = Effect.fn("EditTool.exactPlan")(function* (input: PlanInput) {
  const { services, params, filePath, ctx } = input
  const { afs } = services
  const oldString = params.oldString!
  const newString = params.newString!

  const prior = yield* checkPriorRead(afs, ctx.sessionID, filePath, "exact")
  const warnings: string[] = [...prior]

  const healedOldTop = healInput(oldString, "oldString")
  const healedNewTop = healInput(newString, "newString")
  if (healedOldTop.value === healedNewTop.value) {
    throw new Error("No changes to apply: oldString and newString are identical.")
  }

  if (oldString === "") {
    const existed = yield* afs.existsSafe(filePath)
    if (existed) {
      throw new Error(
        "oldString cannot be empty when editing an existing file. Provide the exact text to replace, or use write for an intentional full-file replacement.",
      )
    }
    const healedNew = healInput(newString, "newString")
    warnings.push(...healedNew.warnings)
    const next = Bom.split(healedNew.value)
    const plan = buildPlan({
      filePath,
      contentOld: "",
      bom: next.bom,
      spans: [{ start: 0, end: 0, replacement: next.text }],
      strategy: "exact",
      applied: next.text === "" ? 0 : 1,
      warnings,
      isNew: true,
    })
    return { plan, fingerprint: undefined }
  }

  const source = yield* readExisting(afs, filePath)
  assertTextContent(source.text, filePath)
  const healedOld = healInput(oldString, "oldString")
  const healedNew = healInput(newString, "newString")
  warnings.push(...healedOld.warnings, ...healedNew.warnings)
  if (healedOld.value === healedNew.value) {
    throw new Error("No changes to apply: oldString and newString are identical.")
  }

  // Input healing normalizes model transport newlines to logical LF. Matching
  // then treats LF/CRLF/lone-CR as equivalent and the resolved span re-encodes
  // replacement newlines from that exact region's surrounding separators.
  // This is intentionally local: a mixed-ending file is never normalized by a
  // whole-file "dominant EOL" guess.
  const replacement = healedNew.value
  const resolved = resolveReplacement(source.text, healedOld.value, replacement, params.replaceAll)
  warnings.push(...resolved.warnings)

  let spans = resolved.spans
  if (replacement === "") {
    // D29 — extend deletions over the following terminator so a block
    // deletion doesn't leave a blank line behind.
    spans = spans.map((span) => absorbDeletionNewline(source.text, span).value)
  }

  const plan = buildPlan({
    filePath,
    contentOld: source.text,
    bom: source.bom,
    spans,
    strategy: "exact",
    applied: resolved.applied,
    warnings,
    isNew: false,
  })
  const fingerprint = yield* Fingerprint.capture(afs, filePath, source.text)
  return { plan, fingerprint }
})

const buildStrategyPlan = Effect.fn("EditTool.strategyPlan")(function* (input: PlanInput) {
  const { services, params, filePath, ctx } = input
  const { afs } = services

  const source = yield* readExisting(afs, filePath)
  assertTextContent(source.text, filePath)

  const healedNew = params.newText === undefined ? undefined : healInput(params.newText, "newText")
  const healedOld = params.oldText === undefined ? undefined : healInput(params.oldText, "oldText")
  const healedNear = params.nearText === undefined ? undefined : healInput(params.nearText, "nearText")
  const warnings: string[] = [...(healedNew?.warnings ?? []), ...(healedOld?.warnings ?? []), ...(healedNear?.warnings ?? [])]

  const result = applyEditStrategy(source.text, {
    edits: params.edits as StrategyBatchOp[] | undefined,
    line: params.line,
    startLine: params.startLine,
    endLine: params.endLine,
    insertAt: params.insertAt,
    insertAfter: params.insertAfter,
    appendFile: params.appendFile,
    nearText: healedNear?.value ?? params.nearText,
    occurrence: params.occurrence,
    oldText: healedOld?.value ?? params.oldText,
    newText: healedNew?.value ?? params.newText,
    delete: params.delete,
  })
  warnings.push(...result.warnings)

  const prior = yield* checkPriorRead(afs, ctx.sessionID, filePath, result.strategy)
  warnings.push(...prior)

  const plan = buildPlan({
    filePath,
    contentOld: source.text,
    bom: source.bom,
    spans: result.spans,
    strategy: result.strategy,
    applied: result.applied,
    warnings,
    oldPreview: result.oldPreview,
    isNew: false,
  })
  const fingerprint = yield* Fingerprint.capture(afs, filePath, source.text)
  return { plan, fingerprint }
})

const readExisting = Effect.fn("EditTool.readExisting")(function* (afs: FSUtil.Interface, filePath: string) {
  const info = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (!info) throw new Error(`File ${filePath} not found`)
  if (info.type === "Directory") throw new Error(`Path is a directory, not a file: ${filePath}`)
  return yield* Bom.readFile(afs, filePath)
})

const checkPriorRead = Effect.fn("EditTool.priorRead")(function* (
  afs: FSUtil.Interface,
  sessionID: string,
  filePath: string,
  strategy: string,
) {
  const outcome = yield* enforcePriorReadEffect(Option.some(globalReadCache), afs, sessionID, filePath, strategy)
  if (outcome.refusal) throw new Error(outcome.refusal)
  return outcome.warning ? [outcome.warning] : []
})

// Canonical implementation lives in ./patch/core (shared with the patch
// executor); re-exported here so existing `from "./edit"` importers keep working.
export { trimDiff }
// Back-compat: same signature as the old replace(). Offset-based arbitration
// with the lowest-tier-wins uniqueness rule lives in ./edit/match.
export { replace } from "./edit/match"

// R10 opt-in scoped typecheck after edit (default OFF; LSP diagnostics are the
// primary signal). Returns an output block to append, or undefined when the
// file is not TypeScript or the check is unavailable.
const runTypecheckAfterEdit = Effect.fn("EditTool.runTypecheck")(function* (
  filePath: string,
  instance: { directory: string; worktree: string },
  ctx: Tool.Context,
  maxErrors?: number,
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
    maxErrors: maxErrors ?? 30,
    timeoutMs: 30_000,
    signal: ctx.abort,
  })
  const status = outcome.exitCode === 0 ? "passed" : "failed"
  return `\n\n<typecheck status="${status}" errors="${outcome.diagnostics.length}">\nScoped tsgo check of ${path.relative(instance.worktree, filePath)}: ${status}.\n${outcome.diagnostics
    .slice(0, 10)
    .map((d) => `  - ${d.file}(${d.line},${d.column}): TS${d.code} [${d.severity}] ${d.message.split("\n")[0]}`)
    .join("\n")}\n</typecheck>`
})
