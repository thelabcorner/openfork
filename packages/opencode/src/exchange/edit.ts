export * as ExchangeEdit from "./edit"

import { createTwoFilesPatch } from "diff"
import { Effect, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import * as Bom from "@/util/bom"
import { absorbDeletionNewline, healInput } from "@/tool/edit/heal"
import { buildPlan, type EditPlan } from "@/tool/edit/plan"
import { applyEditStrategy, type BatchOpType } from "@/tool/edit/strategy"
import { resolveReplacement } from "@/tool/edit/match"
import { assertTextContent } from "@/tool/patch/core"
import { ExchangeError } from "./error"
import { ExchangeFileMutation } from "./file-mutation"
import { ExchangeRead } from "./read"

const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

const BatchOp = Schema.Union([
  Schema.Struct({ line: PositiveInt, newText: Schema.String, oldText: Schema.optional(Schema.String) }),
  Schema.Struct({
    startLine: PositiveInt,
    endLine: PositiveInt,
    newText: Schema.optional(Schema.String),
    oldText: Schema.optional(Schema.String),
    delete: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ oldString: Schema.String, newString: Schema.String }),
])

export const Parameters = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  oldString: Schema.optional(Schema.String),
  newString: Schema.optional(Schema.String),
  replaceAll: Schema.optional(Schema.Boolean),
  edits: Schema.optional(Schema.Array(BatchOp).check(Schema.isMaxLength(128))),
  line: Schema.optional(PositiveInt),
  startLine: Schema.optional(PositiveInt),
  endLine: Schema.optional(PositiveInt),
  insertAt: Schema.optional(NonNegativeInt),
  insertAfter: Schema.optional(PositiveInt),
  appendFile: Schema.optional(Schema.Boolean),
  nearText: Schema.optional(Schema.String),
  occurrence: Schema.optional(PositiveInt),
  oldText: Schema.optional(Schema.String),
  newText: Schema.optional(Schema.String),
  delete: Schema.optional(Schema.Boolean),
})
export type Input = Schema.Schema.Type<typeof Parameters>

export interface ExecuteInput extends Input {
  readonly canonicalPath: string
  readonly displayPath: string
  readonly groundedFingerprint?: string
  readonly ungroundedWarning?: string
  readonly signal?: AbortSignal
}

export interface Hooks<E> {
  readonly revalidate: () => Effect.Effect<void, E>
  readonly beforeCommit: () => Effect.Effect<void, E>
}

export interface Result {
  readonly title: string
  readonly output: string
  readonly metadata: Readonly<Record<string, unknown>>
  readonly mutation: { readonly attempted: boolean; readonly committed: boolean }
  readonly fingerprint: string
}

const LINE_TARGETED = new Set(["line", "startLine/endLine", "insertAt", "delete", "edits"])

function sameBytes(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false
  return true
}

function decode(bytes: Uint8Array) {
  return Bom.split(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes))
}

function encode(plan: EditPlan) {
  return new TextEncoder().encode(Bom.join(plan.contentNew, plan.bom))
}

function detail(error: unknown) {
  const value = error instanceof Error ? error.message : String(error)
  return value.length > 1000 ? `${value.slice(0, 997)}...` : value
}

function shape(input: Input) {
  const exact = input.oldString !== undefined || input.newString !== undefined || input.replaceAll !== undefined
  const strategy =
    input.edits !== undefined ||
    input.line !== undefined ||
    input.startLine !== undefined ||
    input.endLine !== undefined ||
    input.insertAt !== undefined ||
    input.insertAfter !== undefined ||
    input.appendFile === true ||
    input.nearText !== undefined
  if (exact && strategy) {
    throw new ExchangeError.InvalidArgument({ detail: "Exact oldString/newString editing cannot be combined with another edit strategy" })
  }
  if (exact) {
    if (input.oldString === undefined || input.newString === undefined) {
      throw new ExchangeError.InvalidArgument({ detail: "Exact edit requires both oldString and newString" })
    }
    if (input.oldString === "") {
      throw new ExchangeError.InvalidArgument({ detail: "Edit does not create files with an empty oldString; use patch add-file semantics" })
    }
    return "exact" as const
  }
  if (!strategy) throw new ExchangeError.InvalidArgument({ detail: "No edit strategy was supplied" })
  return "strategy" as const
}

function build(input: Input, filePath: string, displayPath: string, bytes: Uint8Array): EditPlan {
  const source = decode(bytes)
  assertTextContent(source.text, displayPath)
  const mode = shape(input)
  if (mode === "exact") {
    const oldValue = healInput(input.oldString!, "oldString")
    const newValue = healInput(input.newString!, "newString")
    if (oldValue.value === newValue.value) {
      return buildPlan({
        filePath,
        contentOld: source.text,
        bom: source.bom,
        spans: [],
        strategy: "exact",
        applied: 0,
        warnings: [...oldValue.warnings, ...newValue.warnings],
        isNew: false,
      })
    }
    const resolved = resolveReplacement(source.text, oldValue.value, newValue.value, input.replaceAll)
    let spans = resolved.spans
    if (newValue.value === "") spans = spans.map((span) => absorbDeletionNewline(source.text, span).value)
    return buildPlan({
      filePath,
      contentOld: source.text,
      bom: source.bom,
      spans,
      strategy: "exact",
      applied: resolved.applied,
      warnings: [...oldValue.warnings, ...newValue.warnings, ...resolved.warnings],
      isNew: false,
    })
  }

  const healedNew = input.newText === undefined ? undefined : healInput(input.newText, "newText")
  const healedOld = input.oldText === undefined ? undefined : healInput(input.oldText, "oldText")
  const healedNear = input.nearText === undefined ? undefined : healInput(input.nearText, "nearText")
  const result = applyEditStrategy(source.text, {
    edits: input.edits as readonly BatchOpType[] | undefined,
    line: input.line,
    startLine: input.startLine,
    endLine: input.endLine,
    insertAt: input.insertAt,
    insertAfter: input.insertAfter,
    appendFile: input.appendFile,
    nearText: healedNear?.value ?? input.nearText,
    occurrence: input.occurrence,
    oldText: healedOld?.value ?? input.oldText,
    newText: healedNew?.value ?? input.newText,
    delete: input.delete,
  })
  return buildPlan({
    filePath,
    contentOld: source.text,
    bom: source.bom,
    spans: result.spans,
    strategy: result.strategy,
    applied: result.applied,
    warnings: [
      ...(healedNew?.warnings ?? []),
      ...(healedOld?.warnings ?? []),
      ...(healedNear?.warnings ?? []),
      ...result.warnings,
    ],
    oldPreview: result.oldPreview,
    isNew: false,
  })
}

function strategyName(input: Input) {
  if (input.oldString !== undefined || input.newString !== undefined || input.replaceAll !== undefined) return "exact"
  if (input.edits !== undefined) return "edits"
  if (input.line !== undefined) return "line"
  if (input.startLine !== undefined || input.endLine !== undefined) return input.delete ? "delete" : "startLine/endLine"
  if (input.insertAt !== undefined || input.insertAfter !== undefined) return "insertAt"
  if (input.appendFile) return "appendFile"
  if (input.nearText !== undefined) return "nearText"
  return "unknown"
}

export function execute<E>(
  fs: FSUtil.Interface,
  input: ExecuteInput,
  hooks: Hooks<E>,
): Effect.Effect<Result, ExchangeError.Error | E> {
  return Effect.gen(function* () {
    if (input.signal?.aborted) return yield* new ExchangeError.Cancelled({ detail: "Edit was cancelled" })
    const initialStat = yield* fs.stat(input.canonicalPath).pipe(
      Effect.mapError(() => new ExchangeError.NotFound({ detail: `Edit target does not exist: ${input.displayPath}` })),
    )
    if (initialStat.type !== "File") {
      return yield* new ExchangeError.InvalidArgument({ detail: `Edit target is not a file: ${input.displayPath}` })
    }
    const initialFingerprint = ExchangeRead.statFingerprint(initialStat)
    if (input.groundedFingerprint !== undefined && input.groundedFingerprint !== initialFingerprint) {
      return yield* new ExchangeError.Conflict({ detail: `${input.displayPath} changed after it was last read; read it again before editing` })
    }
    const initialBytes = yield* fs.readFile(input.canonicalPath).pipe(
      Effect.mapError(() => new ExchangeError.DependencyUnavailable({ detail: "Unable to read the edit target" })),
    )
    const initialPlan = yield* Effect.try({
      try: () => build(input, input.canonicalPath, input.displayPath, initialBytes),
      catch: (error) =>
        error instanceof ExchangeError.InvalidArgument
          ? error
          : new ExchangeError.Conflict({ detail: detail(error) }),
    })
    const warnings = [...initialPlan.warnings]
    if (input.groundedFingerprint === undefined && LINE_TARGETED.has(strategyName(input))) {
      warnings.push(
        input.ungroundedWarning ??
          "This file has no prior read-grounding record for this external principal. The edit is still verified against current content, but read it first when relying on line coordinates.",
      )
    }
    if (initialPlan.applied === 0 || initialPlan.spans.length === 0) {
      return {
        title: input.displayPath,
        output: `No changes to apply: ${input.displayPath} already matches (strategy=${initialPlan.strategy}).`,
        metadata: { path: input.displayPath, strategy: initialPlan.strategy, applied: 0, warnings },
        mutation: { attempted: false, committed: false },
        fingerprint: initialFingerprint,
      }
    }

    const transaction = yield* ExchangeFileMutation.commit(
      fs,
      [input.canonicalPath],
      {
        prepare: () =>
          Effect.gen(function* () {
            const currentBytes = yield* fs.readFile(input.canonicalPath).pipe(
              Effect.mapError(() => new ExchangeError.Conflict({ detail: `${input.displayPath} disappeared before the edit could commit` })),
            )
            const currentStat = yield* fs.stat(input.canonicalPath).pipe(
              Effect.mapError(() => new ExchangeError.Conflict({ detail: `${input.displayPath} disappeared before the edit could commit` })),
            )
            const currentFingerprint = ExchangeRead.statFingerprint(currentStat)
            if (input.groundedFingerprint !== undefined && input.groundedFingerprint !== currentFingerprint) {
              return yield* new ExchangeError.Conflict({
                detail: `${input.displayPath} changed after the grounded read; read it again before editing`,
              })
            }

            let active = initialPlan
            if (!sameBytes(initialBytes, currentBytes)) {
              if (input.groundedFingerprint !== undefined) {
                return yield* new ExchangeError.Conflict({
                  detail: `${input.displayPath} changed after the grounded read; read it again before editing`,
                })
              }
              active = yield* Effect.try({
                try: () => build(input, input.canonicalPath, input.displayPath, currentBytes),
                catch: (error) =>
                  error instanceof ExchangeError.InvalidArgument
                    ? error
                    : new ExchangeError.Conflict({ detail: `Concurrent change made this edit unsafe: ${detail(error)}` }),
              })
              warnings.push("File changed between planning and commit; the edit was revalidated against current content.")
            }
            if (active.applied === 0 || active.spans.length === 0) {
              return { changes: [], value: { plan: active, fingerprint: currentFingerprint } }
            }
            return {
              changes: [
                {
                  type: "update" as const,
                  path: input.canonicalPath,
                  displayPath: input.displayPath,
                  beforeExists: true as const,
                  before: currentBytes,
                  after: encode(active),
                },
              ],
              value: { plan: active, fingerprint: currentFingerprint },
            }
          }),
        revalidate: hooks.revalidate,
        beforeCommit: hooks.beforeCommit,
      },
      input.signal,
    )

    let fingerprint = transaction.value.fingerprint
    if (transaction.committed) {
      const after = yield* fs.stat(input.canonicalPath).pipe(
        Effect.mapError(
          () =>
            new ExchangeError.AmbiguousCommit({
              detail: `Edit may have committed but post-write verification failed for ${input.displayPath}`,
              targetRef: input.displayPath,
            }),
        ),
      )
      fingerprint = ExchangeRead.statFingerprint(after)
    }
    const plan = transaction.value.plan
    const patch = createTwoFilesPatch(input.displayPath, input.displayPath, plan.contentOld, plan.contentNew)
    return {
      title: input.displayPath,
      output: transaction.committed
        ? `Edit applied successfully to ${input.displayPath} (strategy=${plan.strategy}, applied=${plan.applied}).`
        : `No changes to apply after commit-time revalidation: ${input.displayPath}.`,
      metadata: {
        path: input.displayPath,
        strategy: plan.strategy,
        applied: transaction.committed ? plan.applied : 0,
        diff: transaction.committed ? patch : "",
        warnings,
      },
      mutation: { attempted: true, committed: transaction.committed },
      fingerprint,
    }
  })
}

