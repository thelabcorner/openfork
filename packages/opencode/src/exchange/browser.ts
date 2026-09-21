export * as ExchangeBrowser from "./browser"

import path from "node:path"
import { Effect, Schema } from "effect"
import { BrowserHostBroker } from "@opencode-ai/core/browser/host-broker"
import {
  DEFAULT_TIMEOUT_MS,
  OperationInput,
  OperationOutput,
  type OperationName,
} from "@/browser/shared"
import * as Utf8 from "@/util/utf8"
import { ExchangeError } from "./error"

const OPERATION_SCHEMAS = [
  Schema.Struct({ operation: Schema.Literal("status"), args: OperationInput.status }),
  Schema.Struct({ operation: Schema.Literal("open"), args: OperationInput.open }),
  Schema.Struct({ operation: Schema.Literal("claim"), args: OperationInput.claim }),
  Schema.Struct({ operation: Schema.Literal("navigate"), args: OperationInput.navigate }),
  Schema.Struct({ operation: Schema.Literal("resize"), args: OperationInput.resize }),
  Schema.Struct({ operation: Schema.Literal("set_appearance"), args: OperationInput.set_appearance }),
  Schema.Struct({ operation: Schema.Literal("snapshot"), args: OperationInput.snapshot }),
  Schema.Struct({ operation: Schema.Literal("screenshot"), args: OperationInput.screenshot }),
  Schema.Struct({ operation: Schema.Literal("visual_capture"), args: OperationInput.visual_capture }),
  Schema.Struct({ operation: Schema.Literal("visual_diff"), args: OperationInput.visual_diff }),
  Schema.Struct({ operation: Schema.Literal("visual_record"), args: OperationInput.visual_record }),
  Schema.Struct({ operation: Schema.Literal("visual_history"), args: OperationInput.visual_history }),
  Schema.Struct({ operation: Schema.Literal("visual_artifact"), args: OperationInput.visual_artifact }),
  Schema.Struct({ operation: Schema.Literal("click"), args: OperationInput.click }),
  Schema.Struct({ operation: Schema.Literal("type"), args: OperationInput.type }),
  Schema.Struct({ operation: Schema.Literal("press"), args: OperationInput.press }),
  Schema.Struct({ operation: Schema.Literal("scroll"), args: OperationInput.scroll }),
  Schema.Struct({ operation: Schema.Literal("evaluate"), args: OperationInput.evaluate }),
  Schema.Struct({ operation: Schema.Literal("wait_for"), args: OperationInput.wait_for }),
  Schema.Struct({ operation: Schema.Literal("recording_start"), args: OperationInput.recording_start }),
  Schema.Struct({ operation: Schema.Literal("recording_stop"), args: OperationInput.recording_stop }),
  Schema.Struct({ operation: Schema.Literal("close"), args: OperationInput.close }),
  Schema.Struct({ operation: Schema.Literal("query"), args: OperationInput.query }),
  Schema.Struct({ operation: Schema.Literal("highlight"), args: OperationInput.highlight }),
  Schema.Struct({ operation: Schema.Literal("annotate"), args: OperationInput.annotate }),
  Schema.Struct({ operation: Schema.Literal("profiler_start"), args: OperationInput.profiler_start }),
  Schema.Struct({ operation: Schema.Literal("profiler_stop"), args: OperationInput.profiler_stop }),
  Schema.Struct({ operation: Schema.Literal("react_inspect"), args: OperationInput.react_inspect }),
  Schema.Struct({ operation: Schema.Literal("open_devtools"), args: OperationInput.open_devtools }),
  Schema.Struct({ operation: Schema.Literal("extensions_list"), args: OperationInput.extensions_list }),
] as const

export const Parameters = Schema.Union(OPERATION_SCHEMAS)
export type Input = Schema.Schema.Type<typeof Parameters>

export const VISUAL_ROOT_OPERATIONS = new Set<OperationName>([
  "visual_capture",
  "visual_diff",
  "visual_record",
  "visual_history",
  "visual_artifact",
])

export const READ_ONLY_OPERATIONS = new Set<OperationName>([
  "status",
  "snapshot",
  "screenshot",
  "query",
  "visual_history",
  "visual_artifact",
  "react_inspect",
  "extensions_list",
])

export const requiresRoot = (operation: OperationName) => VISUAL_ROOT_OPERATIONS.has(operation)
export const isMutating = (operation: OperationName) => !READ_ONLY_OPERATIONS.has(operation)

export interface ProjectScope {
  readonly rootPath: string
  readonly toVirtualPath: (absolutePath: string) => string
}

export interface Context {
  readonly principalId: string
  readonly broker: BrowserHostBroker.Interface
  readonly project?: ProjectScope
  readonly signal?: AbortSignal
  readonly revalidate: () => Effect.Effect<void, ExchangeError.Error>
}

export interface Result {
  readonly title: string
  readonly output: string
  readonly metadata: Readonly<Record<string, unknown>>
  readonly mutation: { readonly attempted: boolean; readonly committed: boolean }
}

function mapBrowserError(error: BrowserHostBroker.BrowserErrorClass): ExchangeError.Error {
  switch (error._tag) {
    case "BrowserPermissionDenied":
      return new ExchangeError.AuthorityDenied({ detail: error.message })
    case "BrowserTabNotFound":
    case "BrowserTargetNotFound":
      return new ExchangeError.NotFound({ detail: error.message })
    case "BrowserControlInterrupted":
      return new ExchangeError.Cancelled({ detail: error.message })
    case "BrowserInvalidSelector":
    case "BrowserStaleRefError":
    case "BrowserNotAReactAppError":
      return new ExchangeError.InvalidArgument({ detail: error.message })
    case "BrowserHostUnavailable":
    case "BrowserProtocolMismatch":
    case "BrowserGuestCrashed":
    case "BrowserResultTooLarge":
    case "BrowserDebuggerConflict":
    case "BrowserUnsupportedOperation":
    case "BrowserNotAttached":
    case "BrowserOperationFailed":
    case "BrowserTimeout":
      return new ExchangeError.DependencyUnavailable({ detail: error.message })
  }
}

function contained(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function projectProjectPath(scope: ProjectScope, value: string, base?: string) {
  if (!value || value.includes("\0")) throw new ExchangeError.PathEscape({ detail: "Browser artifact path is invalid" })
  const absolute = path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(base ?? scope.rootPath, value)
  if (!contained(scope.rootPath, absolute)) {
    throw new ExchangeError.PathEscape({ detail: "Browser artifact path escapes the approved root" })
  }
  return scope.toVirtualPath(absolute)
}

function projectVisualResult(operation: OperationName, value: unknown, scope: ProjectScope | undefined): unknown {
  if (!VISUAL_ROOT_OPERATIONS.has(operation)) return value
  if (!scope) throw new ExchangeError.InvalidArgument({ detail: `browser.${operation} requires an approved project root` })
  if (!value || typeof value !== "object") return value

  if (operation === "visual_history") {
    const result = value as { history?: { baselines?: Array<Record<string, unknown>>; runs?: Array<Record<string, unknown>> } }
    const history = result.history
    if (!history) return value
    return {
      ...result,
      history: {
        ...history,
        baselines: (history.baselines ?? []).map((row) => ({
          ...row,
          ...(typeof row.imagePath === "string" ? { imagePath: projectProjectPath(scope, row.imagePath) } : {}),
          ...(typeof row.metadataPath === "string" ? { metadataPath: projectProjectPath(scope, row.metadataPath) } : {}),
        })),
        runs: (history.runs ?? []).map((row) => ({
          ...row,
          ...(typeof row.resultPath === "string" ? { resultPath: projectProjectPath(scope, row.resultPath) } : {}),
        })),
      },
    }
  }

  if (operation === "visual_artifact") {
    const result = value as { artifact?: null | Record<string, unknown> }
    if (!result.artifact || typeof result.artifact.path !== "string") return value
    return { ...result, artifact: { ...result.artifact, path: projectProjectPath(scope, result.artifact.path) } }
  }

  const result = value as { visual?: Record<string, unknown> }
  const visual = result.visual
  if (!visual || typeof visual.runId !== "string" || !visual.artifacts || typeof visual.artifacts !== "object") return value
  const runBase = path.join(scope.rootPath, ".snapeye", "runs", visual.runId)
  const artifacts = Object.fromEntries(
    Object.entries(visual.artifacts as Record<string, unknown>).map(([key, item]) => {
      if (typeof item !== "string") return [key, item]
      const base = item.replaceAll("\\", "/").startsWith(".snapeye/") ? scope.rootPath : runBase
      return [key, projectProjectPath(scope, item, base)]
    }),
  )
  return { ...result, visual: { ...visual, artifacts } }
}

function scopeStatus(value: unknown, principalId: string): unknown {
  if (!value || typeof value !== "object") return value
  const result = value as { tabs?: unknown[] }
  if (!Array.isArray(result.tabs)) return value
  return {
    ...result,
    tabs: result.tabs.filter((tab) => {
      if (!tab || typeof tab !== "object") return false
      const owner = (tab as { owner?: unknown }).owner
      return !!owner && typeof owner === "object" &&
        (owner as { kind?: unknown }).kind === "external" &&
        (owner as { principalId?: unknown }).principalId === principalId
    }),
  }
}

function boundedJson(value: unknown) {
  const raw = JSON.stringify(value)
  const limited = Utf8.truncate(raw, 120 * 1024)
  return limited.truncated
    ? `${limited.text}\n<note>OFXP browser result truncated; narrow the browser request</note>`
    : limited.text
}

export const execute = Effect.fn("ExchangeBrowser.execute")(function* (input: Input, context: Context) {
  const operation = input.operation as OperationName
  if (context.signal?.aborted) return yield* new ExchangeError.Cancelled({ detail: "Browser operation was cancelled" })
  if (requiresRoot(operation) && !context.project) {
    return yield* new ExchangeError.InvalidArgument({ detail: `browser.${operation} requires an approved project root` })
  }

  const timeoutMs = "timeoutMs" in input.args && typeof input.args.timeoutMs === "number"
    ? input.args.timeoutMs
    : DEFAULT_TIMEOUT_MS[operation]
  const response = yield* context.broker.dispatch(
    {
      principal: { kind: "external", principalId: context.principalId },
      ...(context.project ? { directory: context.project.rootPath } : {}),
      operation: { name: operation, input: input.args },
      timeoutMs,
    },
    { signal: context.signal },
  )
  if (!response.ok) return yield* mapBrowserError(BrowserHostBroker.BrowserError.fromPayload(response.error))

  const decoded = yield* Schema.decodeUnknownEffect(OperationOutput[operation] as Schema.Decoder<unknown, never>)(response.result).pipe(
    Effect.mapError(
      () => new ExchangeError.DependencyUnavailable({ detail: `Desktop browser returned an invalid ${operation} result` }),
    ),
  )
  const visual = yield* Effect.try({
    try: () => projectVisualResult(operation, decoded, context.project),
    catch: (cause) =>
      cause instanceof ExchangeError.PathEscape || cause instanceof ExchangeError.InvalidArgument
        ? cause
        : new ExchangeError.PathEscape({ detail: "Browser result path projection failed" }),
  })
  const projected = operation === "status" ? scopeStatus(visual, context.principalId) : visual
  if (!isMutating(operation)) yield* context.revalidate()

  return {
    title: `Browser ${operation}`,
    output: boundedJson(projected),
    metadata: {
      operation,
      requestId: response.requestId,
      elapsedMs: response.elapsedMs,
      ...(response.snapshotAfter ? { snapshotAfter: response.snapshotAfter } : {}),
    },
    mutation: { attempted: isMutating(operation), committed: response.ok && isMutating(operation) },
  } satisfies Result
})

