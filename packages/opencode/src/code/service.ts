import { createHash } from "node:crypto"
import { CodeMode, Tool as CodeModeTool, ToolSchema, toolError } from "@opencode-ai/codemode"
import { Cause, Effect, Exit } from "effect"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Snapshot } from "@/snapshot"
import { ToolInterrupt } from "@/tool/interrupt"
import type * as Tool from "@/tool/tool"
import * as Capability from "@/tool/capability"
import { BrokerContract } from "@/tool/broker-contract"
import * as CapabilityInvocationGateway from "@/session/capability-invocation-gateway"
import type * as Schema from "./schema"
import * as CodeError from "./error"
import * as Revision from "./revision"
import * as CodeExecution from "./execution"
import { PreparedProgramCache } from "./prepared"
import {
  CODE_RUN_TRACE_MAX_ID_CHARS,
  CODE_RUN_TRACE_MAX_REF_CHARS,
  CODE_RUN_TRACE_MAX_TITLE_CHARS,
  type SessionV1,
} from "@opencode-ai/core/v1/session"

export const HOST_LIMITS = CodeExecution.HOST_LIMITS

export const preparedCacheStats = PreparedProgramCache.stats
export const resetPreparedCacheForTest = PreparedProgramCache.resetForTest

const boundTraceString = (value: string, max: number) => {
  if (value.length <= max) return value
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 16)
  const suffix = `…sha256:${digest}`
  return value.slice(0, Math.max(0, max - suffix.length)) + suffix
}

const projectFrame = (frame: CapabilityInvocationGateway.Frame): SessionV1.CodeRunTrace["frames"][number] => ({
  frameID: boundTraceString(frame.frameID, CODE_RUN_TRACE_MAX_ID_CHARS),
  ...(frame.parentFrameID
    ? { parentFrameID: boundTraceString(frame.parentFrameID, CODE_RUN_TRACE_MAX_ID_CHARS) }
    : {}),
  ref: boundTraceString(frame.ref, CODE_RUN_TRACE_MAX_REF_CHARS),
  kind: frame.kind,
  depth: frame.depth,
  startedAt: frame.startedAt,
  ...(frame.finishedAt === undefined ? {} : { finishedAt: frame.finishedAt }),
  ...(frame.durationMs === undefined ? {} : { durationMs: frame.durationMs }),
  status: frame.status,
  ...(frame.title === undefined
    ? {}
    : { title: boundTraceString(frame.title, CODE_RUN_TRACE_MAX_TITLE_CHARS) }),
  ...(frame.attachmentCount === undefined ? {} : { attachmentCount: frame.attachmentCount }),
})

export function projectTrace(
  trace: CapabilityInvocationGateway.Trace,
  rootFrameID: string,
): SessionV1.CodeRunTrace {
  const omitted = Math.max(0, trace.totalCalls - trace.frames.length)
  return {
    version: 1,
    rootFrameID: boundTraceString(rootFrameID, CODE_RUN_TRACE_MAX_ID_CHARS),
    frames: trace.frames.map(projectFrame),
    counters: {
      calls: trace.totalCalls,
      failed: trace.failedCalls,
      active: trace.activeCalls,
    },
    ...(omitted > 0 ? { truncated: { frames: omitted } } : {}),
  }
}

export function projectProgress(
  progress: CapabilityInvocationGateway.Progress,
  rootFrameID: string,
): SessionV1.CodeRunTrace {
  const omitted = Math.max(0, progress.totalCalls - 1)
  return {
    version: 1,
    rootFrameID: boundTraceString(rootFrameID, CODE_RUN_TRACE_MAX_ID_CHARS),
    frames: [projectFrame(progress.frame)],
    counters: {
      calls: progress.totalCalls,
      failed: progress.failedCalls,
      active: progress.activeCalls,
    },
    ...(omitted > 0 || progress.truncated
      ? { truncated: { frames: Math.max(omitted, progress.truncated ? 1 : 0) } }
      : {}),
  }
}

type Attachment = NonNullable<Tool.ExecuteResult["attachments"]>[number]

export type Services = {
  readonly permission: Permission.Interface
  readonly plugin: Plugin.Interface
  readonly snapshot: Snapshot.Interface
  readonly interrupt: ToolInterrupt.Interface
}

export class CapabilityCallFailure extends Error {
  constructor(
    readonly semanticCause: unknown,
    readonly trace: SessionV1.CodeRunTrace,
    readonly calls: { readonly total: number; readonly failed: number },
  ) {
    super(semanticCause instanceof Error ? semanticCause.message : "Capability call failed")
    this.name = "CodeCapabilityCallFailure"
  }
}

export type SearchItem = {
  readonly kind: "capability" | "saved"
  readonly ref: string
  readonly capabilityKind: Capability.Kind
  readonly description: string
  readonly callable: boolean
}

export type SearchResponse = {
  readonly ok: true
  readonly generation: string
  readonly items: readonly SearchItem[]
  readonly remaining: number
  readonly next: string | null
}

export type DescribeItem = SearchItem & {
  readonly signature: string
  readonly example: string
  readonly inputSchema: unknown
  readonly outputSchema?: unknown
  readonly diagnostic?: { readonly kind: string; readonly message: string }
}

export type DescribeResponse = {
  readonly ok: true
  readonly generation: string
  readonly item: DescribeItem & {
    readonly canonical: BrokerContract.CanonicalDescriptor
  }
}

const SEARCH_CACHE_MAX_QUERIES = 16
const SEARCH_CACHE_MAX_GENERATIONS = 8
type SearchCache = Map<string, readonly SearchItem[]>
let localSearchCaches = new WeakMap<Capability.Inventory, SearchCache>()
const generationSearchCaches = new Map<string, SearchCache>()
let searchCacheHits = 0
let searchCacheMisses = 0

function searchCache(inventory: Capability.Inventory): SearchCache {
  const generation = inventory.searchGeneration
  if (!generation) {
    let local = localSearchCaches.get(inventory)
    if (!local) {
      local = new Map()
      localSearchCaches.set(inventory, local)
    }
    return local
  }

  const existing = generationSearchCaches.get(generation)
  if (existing) {
    generationSearchCaches.delete(generation)
    generationSearchCaches.set(generation, existing)
    return existing
  }

  const created: SearchCache = new Map()
  generationSearchCaches.set(generation, created)
  while (generationSearchCaches.size > SEARCH_CACHE_MAX_GENERATIONS) {
    const oldest = generationSearchCaches.keys().next().value as string | undefined
    if (oldest === undefined) break
    generationSearchCaches.delete(oldest)
  }
  return created
}

export const searchCacheStats = () => ({
  hits: searchCacheHits,
  misses: searchCacheMisses,
  generations: generationSearchCaches.size,
  queries: [...generationSearchCaches.values()].reduce((total, cache) => total + cache.size, 0),
})

export const resetSearchCacheForTest = () => {
  localSearchCaches = new WeakMap()
  generationSearchCaches.clear()
  searchCacheHits = 0
  searchCacheMisses = 0
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex")

const jsonHash = (value: unknown) => {
  try {
    return hash(JSON.stringify(value))
  } catch {
    return undefined
  }
}

export const runID = (ctx: Tool.Context) =>
  ctx.partID ? `run:${ctx.partID}` : `run:volatile:${ctx.callID ?? ctx.messageID}`

const progressObserver = (input: {
  readonly ctx: Tool.Context
  readonly action: "run" | "call"
  readonly runID: string
  readonly rootFrameID: string
}) =>
  (progress: CapabilityInvocationGateway.Progress) =>
    input.ctx.metadata({
      title: input.action === "run" ? "Code run" : "Code call",
      metadata: {
        action: input.action,
        runID: input.runID,
        trace: projectProgress(progress, input.rootFrameID),
      },
    })

const cursorEncode = (generation: string, offset: number) =>
  Buffer.from(JSON.stringify({ generation, offset }), "utf8").toString("base64url")

const cursorDecode = (value: string | undefined, generation: string) => {
  if (!value) return 0
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      generation?: unknown
      offset?: unknown
    }
    if (parsed.generation !== generation) throw new Error("stale")
    if (!Number.isSafeInteger(parsed.offset) || (parsed.offset as number) < 0) throw new Error("offset")
    return parsed.offset as number
  } catch {
    throw new Error("The code.search cursor is invalid or belongs to a stale capability generation.")
  }
}

const normalize = (value: string) =>
  value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean)

const score = (entry: Capability.Registration, query: string) => {
  const q = query.trim().toLowerCase()
  if (!q) return 1
  if (entry.identity.ref.toLowerCase() === q) return 1000
  const tokens = normalize(q)
  const ref = entry.identity.ref.toLowerCase()
  const segments = entry.identity.segments.join(" ").toLowerCase()
  const description = entry.description.toLowerCase()
  let value = 0
  for (const token of tokens) {
    if (ref.includes(token)) value += 12
    if (segments.includes(token)) value += 8
    if (description.includes(token)) value += 3
  }
  return value
}

const toSearchItem = (entry: Capability.Registration): SearchItem => ({
  kind: entry.kind === "saved" ? "saved" : "capability",
  ref: entry.identity.ref,
  capabilityKind: entry.kind,
  description: entry.description,
  callable: entry.codeCallable,
})

export function search(
  inventory: Capability.Inventory,
  input: Pick<Schema.Parameters, "query" | "target" | "limit" | "cursor">,
): SearchResponse {
  const target = input.target ?? "callable"

  // Run history is Session-owned and is projected by the provider tool because
  // it requires the current physical session scope. Saved revisions are already
  // first-class entries in this frozen inventory.
  if (target === "runs") {
    return { ok: true, generation: inventory.generation, items: [], remaining: 0, next: null }
  }

  const limit = input.limit ?? 8
  const offset = cursorDecode(input.cursor, inventory.generation)
  const query = input.query ?? ""
  const cacheKey = `${target}\u0000${query.trim().toLowerCase()}`
  const cache = searchCache(inventory)
  let entries = cache.get(cacheKey)
  if (!entries) {
    searchCacheMisses += 1
    entries = inventory.entries
      .filter((entry) => {
        if (target === "saved") return entry.kind === "saved"
        if (target === "capabilities") return entry.kind !== "saved"
        return entry.codeCallable
      })
      .map((entry) => ({ entry, score: score(entry, query) }))
      .filter((item) => query.trim().length === 0 || item.score > 0)
      .sort((a, b) => b.score - a.score || a.entry.identity.ref.localeCompare(b.entry.identity.ref))
      .map(({ entry }) => toSearchItem(entry))
    cache.set(cacheKey, entries)
    while (cache.size > SEARCH_CACHE_MAX_QUERIES) {
      const oldest = cache.keys().next().value as string | undefined
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  } else {
    searchCacheHits += 1
    cache.delete(cacheKey)
    cache.set(cacheKey, entries)
  }

  const page = entries.slice(offset, offset + limit)
  const nextOffset = offset + page.length
  return {
    ok: true,
    generation: inventory.generation,
    items: page,
    remaining: Math.max(0, entries.length - nextOffset),
    next: nextOffset < entries.length ? cursorEncode(inventory.generation, nextOffset) : null,
  }
}

export function describe(inventory: Capability.Inventory, ref: string): DescribeResponse {
  const entry = Capability.lookup(inventory, ref)
  if (!entry) throw new Error(`Unknown code.describe ref: ${ref}`)
  const input = ToolSchema.jsonSchemaToTypeScript(entry.inputSchema as CodeModeTool.JsonSchema, true)
  const output =
    entry.outputSchema === undefined
      ? "unknown"
      : ToolSchema.jsonSchemaToTypeScript(entry.outputSchema as CodeModeTool.JsonSchema, true)
  const refLiteral = JSON.stringify(ref)
  const item: DescribeItem = {
    ...toSearchItem(entry),
    signature: `declare function call(ref: ${refLiteral}, input: ${input}): Promise<${output}>;`,
    example: `const result = await call(${refLiteral}, /* input */)`,
    inputSchema: entry.inputSchema,
    ...(entry.outputSchema === undefined ? {} : { outputSchema: entry.outputSchema }),
    ...(entry.diagnostic ? { diagnostic: entry.diagnostic } : {}),
  }
  return {
    ok: true,
    generation: inventory.generation,
    item: { ...item, canonical: toCanonicalDescriptor(item) },
  }
}

/**
 * Project one `code.describe` item onto the shared cross-surface discovery
 * envelope (see docs/plans/tool-description-discovery-unification.md). The
 * item keeps its owner-specific signature/example; this only adds the shared
 * vocabulary so broker, Code, and domain catalogs converge.
 */
export function toCanonicalDescriptor(item: DescribeItem): BrokerContract.CanonicalDescriptor {
  return BrokerContract.toCanonicalDescriptor({
    ref: item.ref,
    kind: item.capabilityKind,
    description: item.description,
    inputSchema: item.inputSchema,
    invocation: {
      tool: "code",
      action: "run",
      argsField: "code",
      hint: item.example,
    },
  })
}

const safeLeafFailure = (cause: unknown) =>
  toolError(cause instanceof Error ? cause.message : "Capability call failed", cause)

function programValue(result: Tool.ExecuteResult, collect: (attachment: Attachment) => void): unknown {
  const attachments = result.attachments ?? []
  for (const attachment of attachments) collect(attachment)
  if (result.data !== undefined) return result.data
  if (result.output.length > 0) return result.output
  if (attachments.length === 0) return null

  const images = attachments.filter((attachment) => attachment.mime.startsWith("image/")).length
  const noun = images === attachments.length ? "image" : "file"
  return `[${attachments.length} ${noun}${attachments.length === 1 ? "" : "s"} attached to the result]`
}

const diagnostic = (value: CodeMode.Diagnostic): CodeError.Detail => {
  switch (value.kind) {
    case "ParseError":
      return { kind: "ParseError", message: value.message, recovery: "Fix the JavaScript/TypeScript syntax and rerun." }
    case "UnsupportedSyntax":
      return { kind: "UnsupportedSyntax", message: value.message, recovery: "Rewrite the program using the supported confined-runtime syntax." }
    case "UnknownTool":
      return { kind: "UnknownCapability", message: value.message, recovery: "Use code.search to obtain the exact host-issued capability ref, then rerun." }
    case "InvalidToolInput":
      return { kind: "CapabilitySchemaError", message: value.message, recovery: "Inspect the exact capability contract with code.describe({ ref }) and correct the call input." }
    case "InvalidToolOutput":
    case "InvalidDataValue":
      return { kind: "InvalidOutput", message: value.message, recovery: "Return JSON-safe bounded data from the program/capability." }
    case "LimitExceeded":
    case "ToolCallLimitExceeded":
      return { kind: "LimitExceeded", message: value.message, recovery: "Reduce program work, fan-out, intermediate data, or collection/string growth and rerun." }
    case "TimeoutExceeded":
      return { kind: "Timeout", message: value.message, recovery: "Reduce the work performed in one Code run or delegate long-lived work to a host capability." }
    case "ToolFailure":
      return { kind: "CapabilityFailed", message: value.message, recovery: "Handle the capability failure in program try/catch or revise the call and rerun." }
    case "ExecutionFailure":
      return { kind: "InternalRuntimeError", message: value.message, recovery: "Inspect the program and rerun; if the failure persists without program cause, inspect host diagnostics." }
  }
}

export function runInline(input: {
  readonly code: string
  readonly value: unknown
  readonly ctx: Tool.Context
  readonly inventory: Capability.Inventory
  readonly services: Services
  readonly replay?: {
    readonly replayOf: string
    readonly sourceRunID: string
    readonly inputRunID: string
  }
}) {
  return Effect.gen(function* () {
    const source = Revision.canonicalSource(input.code)
    const budget = CodeExecution.budgetFrom(input.ctx) ?? CodeExecution.createRootBudget()
    const rootContext = CodeExecution.withBudget(input.ctx, budget)
    const executionID = `code:${input.ctx.partID ?? input.ctx.callID ?? input.ctx.messageID}`
    const id = runID(input.ctx)
    const capabilitySnapshot = CapabilityInvocationGateway.fromInventory(input.inventory)
    const root = yield* CapabilityInvocationGateway.openWithServices(
      {
        snapshot: capabilitySnapshot,
        context: rootContext,
        caller: "code",
        executionID,
        onProgress: progressObserver({ ctx: input.ctx, action: "run", runID: id, rootFrameID: executionID }),
      },
      {
        permission: input.services.permission,
        plugin: input.services.plugin,
        workspace: input.services.snapshot,
        interrupt: input.services.interrupt,
      },
    )
    const attachments: Attachment[] = []
    const sourceHash = Revision.sha256(source)
    const inputHash = jsonHash(input.value)
    const sourceRunID = input.replay?.sourceRunID ?? id
    const inputRunID = input.replay?.inputRunID ?? id

    let prepared: CodeMode.PreparedProgram | undefined
    try {
      prepared = PreparedProgramCache.get(source, sourceHash)
    } catch {
      // Invalid source still flows through the ordinary executor so the agent
      // receives CodeMode's normalized parse/unsupported-syntax diagnostic.
    }

    const executionOptions = {
      input: input.value,
      call: (ref: string, args: unknown) =>
        root.invoke({ ref, args }).pipe(
          Effect.map((result) => programValue(result, (attachment) => attachments.push(attachment))),
          Effect.mapError(safeLeafFailure),
        ),
      limits: HOST_LIMITS,
      budget,
    }
    const execution = prepared
      ? CodeMode.executePrepared(prepared, executionOptions)
      : CodeMode.execute({ ...executionOptions, code: source })

    const result = yield* execution.pipe(
      Effect.ensuring(input.services.permission.releaseExecution({ sessionID: input.ctx.sessionID, executionID })),
    )
    const trace = yield* root.trace()
    const failed = trace.frames.filter((frame) => frame.status === "failed" || frame.status === "cancelled").length
    const calls = { total: trace.totalCalls, failed }

    const envelope: CodeError.Result = result.ok
      ? {
          ok: true,
          runID: id,
          sourceHash,
          ...(inputHash ? { inputHash: `sha256:${inputHash}` } : {}),
          ...(input.replay ? { replayOf: input.replay.replayOf } : {}),
          sourceRunID,
          replayable: input.ctx.partID !== undefined,
          value: result.value,
          calls,
          ...(trace.truncated
            ? { warnings: [{ kind: "TraceTruncated", message: "The bounded child-call trace was truncated." }] }
            : {}),
        }
      : {
          ok: false,
          runID: id,
          sourceHash,
          ...(input.replay ? { replayOf: input.replay.replayOf } : {}),
          sourceRunID,
          error: diagnostic(result.error),
          calls,
        }

    return {
      envelope,
      attachments,
      trace: projectTrace(trace, executionID),
      lineage: {
        ...(input.replay ? { replayOf: input.replay.replayOf } : {}),
        sourceRunID,
        inputRunID,
      },
      dependencies: prepared?.dependencies ?? {
        literalRefs: [] as readonly string[],
        dynamicCallTarget: false,
      },
      dependencyContracts:
        prepared && !prepared.dependencies.dynamicCallTarget
          ? (() => {
              try {
                return Revision.captureDependencies({
                  refs: prepared.dependencies.literalRefs,
                  inventory: input.inventory,
                })
              } catch {
                return undefined
              }
            })()
          : undefined,
    }
  })
}

/**
 * Invoke one exact capability as the provider-root Code action.
 *
 * Saved Code programs recurse through this same gateway, so one root budget,
 * trace, permission execution scope, cancellation tree, and mutation owner
 * govern the entire call graph.
 */
export function callCapability(input: {
  readonly ref: string
  readonly value: unknown
  readonly ctx: Tool.Context
  readonly inventory: Capability.Inventory
  readonly services: Services
}) {
  return Effect.gen(function* () {
    const budget = CodeExecution.budgetFrom(input.ctx) ?? CodeExecution.createRootBudget()
    const rootContext = CodeExecution.withBudget(input.ctx, budget)
    const executionID = `code:${input.ctx.partID ?? input.ctx.callID ?? input.ctx.messageID}`
    const id = runID(input.ctx)
    const root = yield* CapabilityInvocationGateway.openWithServices(
      {
        snapshot: CapabilityInvocationGateway.fromInventory(input.inventory),
        context: rootContext,
        caller: "code",
        executionID,
        onProgress: progressObserver({ ctx: input.ctx, action: "call", runID: id, rootFrameID: executionID }),
      },
      {
        permission: input.services.permission,
        plugin: input.services.plugin,
        workspace: input.services.snapshot,
        interrupt: input.services.interrupt,
      },
    )

    const attempted = yield* root
      .invoke({ ref: input.ref, args: input.value })
      .pipe(
        Effect.exit,
        Effect.ensuring(
          input.services.permission.releaseExecution({
            sessionID: input.ctx.sessionID,
            executionID,
          }),
        ),
      )
    const trace = yield* root.trace()
    const failed = trace.frames.filter((frame) => frame.status === "failed" || frame.status === "cancelled").length
    const projected = projectTrace(trace, executionID)
    const calls = { total: trace.totalCalls, failed }
    if (Exit.isFailure(attempted)) {
      return yield* Effect.fail(new CapabilityCallFailure(Cause.squash(attempted.cause), projected, calls))
    }
    return {
      result: attempted.value,
      trace: projected,
      calls,
    }
  })
}


