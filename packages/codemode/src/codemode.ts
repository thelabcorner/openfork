import { Effect, Schema } from "effect"
import {
  executeWithLimits,
  prepareProgram,
  type DependencySummary,
  type PreparedProgram,
} from "./interpreter/runtime.js"
import { type HostTools, type Services, type ToolDescription, ToolRuntime } from "./tool-runtime.js"
import type { Definition } from "./tool.js"

/** A tool call admitted during an execution. */
export type { ToolCall, ToolCallEnded, ToolCallHooks, ToolCallStarted, ToolDescription } from "./tool-runtime.js"

/** Resource budgets enforced independently during each CodeMode program execution. */
export type ExecutionLimits = {
  /** Maximum wall-clock execution time in milliseconds. No default: absent means no timeout. */
  readonly timeoutMs?: number
  /** Maximum number of tool calls admitted by the runtime. No default: absent means unlimited. */
  readonly maxToolCalls?: number
  /** Maximum UTF-8 bytes of model-facing output. No default: absent means no truncation. */
  readonly maxOutputBytes?: number
  /** Maximum JSON-equivalent UTF-8 bytes admitted from one host tool result. */
  readonly maxIntermediateLeafBytes?: number
  /** Maximum JSON-equivalent UTF-8 bytes admitted from all host tool results in one execution. */
  readonly maxIntermediateAggregateBytes?: number
  /** Maximum deterministic interpreter evaluation operations. */
  readonly maxOperations?: number
  /** Maximum UTF-8 bytes in any string value produced inside the interpreter. */
  readonly maxStringBytes?: number
  /** Maximum entries in any Array/Object/Map/Set value produced inside the interpreter. */
  readonly maxCollectionEntries?: number
  /** Maximum eagerly running tool-call promises inside one interpreter execution. */
  readonly maxConcurrency?: number
}

/**
 * Mutable root-scoped accounting shared across composed interpreter frames.
 * Hosts own policy/lifetime; CodeMode only consumes the counters.
 */
export type ExecutionBudget = {
  remainingOperations?: number
  readonly externalData?: ToolRuntime.CodeExecutionBudget
}

/** Controls how much of the tool catalog is inlined in agent instructions. */
export type DiscoveryOptions = {
  /** Approximate token budget (chars/4, default 2000) for full catalog entries. */
  readonly catalogBudget?: number
}

type ToolTree<R = never> = {
  readonly [name: string]: Definition<R> | ToolTree<R>
}

export type ResolvedExecutionLimits = {
  readonly timeoutMs: number | undefined
  readonly maxToolCalls: number | undefined
  readonly maxOutputBytes: number | undefined
  readonly maxIntermediateLeafBytes: number | undefined
  readonly maxIntermediateAggregateBytes: number | undefined
  readonly maxOperations: number | undefined
  readonly maxStringBytes: number | undefined
  readonly maxCollectionEntries: number | undefined
  readonly maxConcurrency: number | undefined
}

/** Options for one CodeMode execution. */
export type ExecuteOptions<Tools extends Record<string, unknown> = {}> = {
  /** Source for one program in the supported JavaScript subset. */
  code: string
  /** Explicit tool tree exposed to the program as `tools`. */
  tools?: Tools & ToolTree<Services<Tools>>
  /** Immutable JSON-safe input exposed to the program as the global `input`. */
  input?: unknown
  /** Optional host-mediated capability bridge exposed as global `call(ref, input)`. */
  call?: ToolRuntime.HostCall<Services<Tools>>
  /** Per-execution overrides for the default resource limits. */
  limits?: ExecutionLimits
  /** Optional root-shared budget used by nested/composed CodeMode executions. */
  budget?: ExecutionBudget
  /** Observes decoded tool input immediately before tool execution. */
  onToolCallStart?: (call: ToolRuntime.ToolCallStarted) => Effect.Effect<void, never, Services<Tools>>
  /** Observes each admitted tool call as it settles, with outcome and duration. */
  onToolCallEnd?: (call: ToolRuntime.ToolCallEnded) => Effect.Effect<void, never, Services<Tools>>
}

/** A JSON value that can cross the confined interpreter boundary. */
export type DataValue = Schema.Json

/** Configuration shared by `CodeMode.make` and `CodeMode.execute`. */
export type Options<Tools extends Record<string, unknown> = {}> = Omit<ExecuteOptions<Tools>, "code"> & {
  /** Progressive-disclosure configuration for the agent-facing tool catalog. */
  readonly discovery?: DiscoveryOptions
}

/** Schema for a host tool input containing CodeMode source. */
export const Input = Schema.Struct({ code: Schema.String })
export type Input = typeof Input.Type

export const DiagnosticKind = Schema.Literals([
  "ParseError",
  "UnsupportedSyntax",
  "UnknownTool",
  "InvalidToolInput",
  "InvalidToolOutput",
  "InvalidDataValue",
  "LimitExceeded",
  "ToolCallLimitExceeded",
  "TimeoutExceeded",
  "ToolFailure",
  "ExecutionFailure",
])
/** Stable categories produced by program, schema, tool, and limit failures. */
export type DiagnosticKind = typeof DiagnosticKind.Type

export const Diagnostic = Schema.Struct({
  kind: DiagnosticKind,
  message: Schema.String,
  location: Schema.optionalKey(Schema.Struct({ line: Schema.Number, column: Schema.Number })),
  suggestions: Schema.optionalKey(Schema.Array(Schema.String)),
})
/** A normalized program diagnostic safe to return across an agent tool boundary. */
export type Diagnostic = typeof Diagnostic.Type

const ToolCallSchema = Schema.Struct({ name: Schema.String })
export const Success = Schema.Struct({
  ok: Schema.Literal(true),
  value: Schema.Json,
  logs: Schema.optionalKey(Schema.Array(Schema.String)),
  truncated: Schema.optionalKey(Schema.Boolean),
  toolCalls: Schema.Array(ToolCallSchema),
})
/** Successful execution after the result has crossed the plain-data boundary. */
export type Success = typeof Success.Type

export const Failure = Schema.Struct({
  ok: Schema.Literal(false),
  error: Diagnostic,
  logs: Schema.optionalKey(Schema.Array(Schema.String)),
  truncated: Schema.optionalKey(Schema.Boolean),
  toolCalls: Schema.Array(ToolCallSchema),
})
/** Failed execution with calls admitted before the diagnostic was produced. */
export type Failure = typeof Failure.Type

/** Schema for the structured success or diagnostic returned by CodeMode execution. */
export const Result = Schema.Union([Success, Failure])
/** Result of executing a CodeMode program. Program failures are data, not Effect failures. */
export type Result = typeof Result.Type

/** Reusable confined runtime over one explicit tool tree. */
export type Runtime<R = never> = {
  readonly catalog: () => ReadonlyArray<ToolDescription>
  readonly instructions: () => string
  readonly execute: (code: string) => Effect.Effect<Result, never, R>
}

export type { DependencySummary, PreparedProgram }

/**
 * Increment whenever the prepared-program representation or parser/transpile
 * semantics change in a way that makes cross-version prepared reuse unsafe.
 */
export const PREPARED_PROGRAM_ABI = 2 as const

const validateLimit = <Value extends number | undefined>(
  name: keyof ExecutionLimits,
  value: Value,
  minimum: number,
): Value => {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum)) {
    throw new RangeError(`${name} must be a safe integer greater than or equal to ${minimum}.`)
  }
  return value
}

const resolveExecutionLimits = (limits?: ExecutionLimits): ResolvedExecutionLimits => {
  const maxIntermediateLeafBytes = validateLimit(
    "maxIntermediateLeafBytes",
    limits?.maxIntermediateLeafBytes,
    0,
  )
  const maxIntermediateAggregateBytes = validateLimit(
    "maxIntermediateAggregateBytes",
    limits?.maxIntermediateAggregateBytes,
    0,
  )
  if ((maxIntermediateLeafBytes === undefined) !== (maxIntermediateAggregateBytes === undefined)) {
    throw new RangeError(
      "maxIntermediateLeafBytes and maxIntermediateAggregateBytes must be configured together.",
    )
  }
  return {
    timeoutMs: validateLimit("timeoutMs", limits?.timeoutMs, 1),
    maxToolCalls: validateLimit("maxToolCalls", limits?.maxToolCalls, 0),
    maxOutputBytes: validateLimit("maxOutputBytes", limits?.maxOutputBytes, 0),
    maxIntermediateLeafBytes,
    maxIntermediateAggregateBytes,
    maxOperations: validateLimit("maxOperations", limits?.maxOperations, 0),
    maxStringBytes: validateLimit("maxStringBytes", limits?.maxStringBytes, 0),
    maxCollectionEntries: validateLimit("maxCollectionEntries", limits?.maxCollectionEntries, 0),
    maxConcurrency: validateLimit("maxConcurrency", limits?.maxConcurrency, 1),
  }
}

export const createExecutionBudget = (limits?: ExecutionLimits): ExecutionBudget => {
  const resolved = resolveExecutionLimits(limits)
  return {
    ...(resolved.maxOperations === undefined ? {} : { remainingOperations: resolved.maxOperations }),
    ...(resolved.maxIntermediateLeafBytes === undefined || resolved.maxIntermediateAggregateBytes === undefined
      ? {}
      : {
          externalData: {
            maxLeafBytes: resolved.maxIntermediateLeafBytes,
            remainingAggregateBytes: resolved.maxIntermediateAggregateBytes,
          },
        }),
  }
}

/** Executes one Effect-native CodeMode program without constructing a reusable runtime. */
export const execute = <const Tools extends Record<string, unknown>>(
  options: ExecuteOptions<Tools>,
): Effect.Effect<Result, never, Services<Tools>> => {
  const tools = (options.tools ?? {}) as HostTools<Services<Tools>>
  ToolRuntime.assertValidTools(tools)
  return executeWithLimits(options, resolveExecutionLimits(options.limits), ToolRuntime.searchIndex(tools))
}

/**
 * Parse/transpile source once into an immutable authority-free program. The
 * prepared object contains no host tools, credentials, permissions, fibers, or
 * execution state and is safe to reuse across fresh runs.
 */
export const prepare = (code: string): PreparedProgram => prepareProgram(code)

/** Execute an already prepared program with fresh input and host capabilities. */
export const executePrepared = <const Tools extends Record<string, unknown>>(
  prepared: PreparedProgram,
  options: Omit<ExecuteOptions<Tools>, "code"> = {},
): Effect.Effect<Result, never, Services<Tools>> => {
  const tools = (options.tools ?? {}) as HostTools<Services<Tools>>
  ToolRuntime.assertValidTools(tools)
  const withCode = { ...options, code: prepared.source } as ExecuteOptions<Tools>
  return executeWithLimits(
    withCode,
    resolveExecutionLimits(options.limits),
    ToolRuntime.searchIndex(tools),
    prepared,
  )
}

/** Creates an Effect-native runtime over explicit, schema-described tools. */
export const make = <const Tools extends Record<string, unknown> = {}>(
  options: Options<Tools> = {} as Options<Tools>,
): Runtime<Services<Tools>> => {
  const tools = (options.tools ?? {}) as HostTools<Services<Tools>>
  ToolRuntime.assertValidTools(tools)
  const limits = resolveExecutionLimits(options.limits)
  const prepared = ToolRuntime.prepare(tools, options.discovery?.catalogBudget)

  return {
    catalog: () => prepared.catalog,
    instructions: () => prepared.instructions,
    execute: (code) => executeWithLimits<Tools>({ ...options, code }, limits, prepared.searchIndex),
  }
}
