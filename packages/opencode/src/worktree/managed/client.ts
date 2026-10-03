import { AppProcess, AppProcessError } from "@opencode-ai/core/process"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Duration, Effect, Layer, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import path from "node:path"
import {
  boundedExcerpt,
  MANAGED_ERROR_CODES,
  MANAGED_ERROR_CODE_SET,
  MANAGED_DOMAIN_REFUSAL_CODES,
  MANAGED_INVOCATION_ERROR_CODES,
  MANAGED_LIMITS,
  MANAGED_PROTOCOL_MISMATCH_CODES,
  ManagedRequestInvalid,
  parseManagedCreateInitializeResult,
  parseManagedExitOutcome,
  parseManagedProtocolVersionResult,
  parseManagedStatusResult,
  type ManagedCreateInitializeRequest,
  type ManagedCreateInitializeResult,
  type ManagedExitOutcome,
  type ManagedProtocolCommand,
  type ManagedProtocolVersionResult,
  type ManagedSuccessResponse,
  type ManagedStatusResult,
} from "./protocol"
import {
  createInitializeRequestDocument,
  protocolVersionRequestDocument,
  serializeRequestDocument,
  statusRequestDocument,
  type ManagedCreateInitializeInput,
} from "./request"

export const MANAGED_TIMEOUTS = Object.freeze({
  protocolVersionMs: 5_000,
  statusMs: 15_000,
  createInitializeMs: 30 * 60_000,
})

export interface ManagedExecutable {
  readonly path: string
  readonly argsPrefix: readonly string[]
  readonly cwd?: string
}

export class UnavailableError extends Schema.TaggedErrorClass<UnavailableError>()("ManagedWorktreeUnavailableError", {
  code: Schema.String,
  message: Schema.String,
}) {}

export class ProtocolViolationError extends Schema.TaggedErrorClass<ProtocolViolationError>()(
  "ManagedWorktreeProtocolViolationError",
  {
    code: Schema.String,
    message: Schema.String,
    command: Schema.optional(Schema.String),
    exitCode: Schema.optional(Schema.Number),
    stdoutExcerpt: Schema.optional(Schema.String),
    stderrExcerpt: Schema.optional(Schema.String),
  },
) {}

export class AmbiguousOutcomeError extends Schema.TaggedErrorClass<AmbiguousOutcomeError>()(
  "ManagedWorktreeAmbiguousOutcomeError",
  {
    reason: Schema.Literals(["timeout", "cancelled"]),
    message: Schema.String,
    command: Schema.optional(Schema.String),
    timeoutMs: Schema.optional(Schema.Number),
  },
) {}

export class ContentionError extends Schema.TaggedErrorClass<ContentionError>()("ManagedWorktreeContentionError", {
  code: Schema.String,
  message: Schema.String,
  worktreeId: Schema.optional(Schema.String),
  operationId: Schema.optional(Schema.String),
}) {}

export class ReconcileError extends Schema.TaggedErrorClass<ReconcileError>()("ManagedWorktreeReconcileError", {
  code: Schema.String,
  message: Schema.String,
  reconcileRequired: Schema.Boolean,
  worktreeId: Schema.optional(Schema.String),
  operationId: Schema.optional(Schema.String),
  detailsJson: Schema.optional(Schema.String),
}) {}

export class RequestRejectedError extends Schema.TaggedErrorClass<RequestRejectedError>()(
  "ManagedWorktreeRequestRejectedError",
  {
    code: Schema.String,
    message: Schema.String,
    kind: Schema.Literals(["invocation", "domain", "other"]),
  },
) {}

export class InternalError extends Schema.TaggedErrorClass<InternalError>()("ManagedWorktreeInternalError", {
  code: Schema.String,
  message: Schema.String,
}) {}

export type Error =
  | UnavailableError
  | ProtocolViolationError
  | AmbiguousOutcomeError
  | ContentionError
  | ReconcileError
  | RequestRejectedError
  | InternalError

const MAX_ARGS_PREFIX = 32
const MAX_ARGS_PREFIX_BYTES = 16 * 1024
const MAX_DETAILS_BYTES = 256 * 1024
const FORBIDDEN_EXECUTABLE_EXTENSIONS = new Set([".cmd", ".bat", ".ps1", ".vbs"])

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value)
}

export function validateManagedExecutable(executable: ManagedExecutable): Error | undefined {
  if (typeof executable.path !== "string" || executable.path.length === 0) {
    return new UnavailableError({ code: "managed-executable-invalid", message: "the managed executable path is empty." })
  }
  if (hasControlCharacters(executable.path)) {
    return new UnavailableError({
      code: "managed-executable-invalid",
      message: "the managed executable path contains control characters.",
    })
  }
  if (!path.isAbsolute(executable.path)) {
    return new UnavailableError({
      code: "managed-executable-not-absolute",
      message: `the managed executable must be an absolute path; received ${executable.path}.`,
    })
  }
  if (process.platform === "win32" && FORBIDDEN_EXECUTABLE_EXTENSIONS.has(path.extname(executable.path).toLowerCase())) {
    return new UnavailableError({
      code: "managed-executable-shell-interpreter",
      message: `the managed executable must not be a shell script (${path.extname(executable.path)}).`,
    })
  }
  if (executable.argsPrefix.length > MAX_ARGS_PREFIX) {
    return new UnavailableError({
      code: "managed-executable-invalid",
      message: `the managed executable argument prefix must contain at most ${MAX_ARGS_PREFIX} entries.`,
    })
  }
  let prefixBytes = 0
  for (const arg of executable.argsPrefix) {
    if (typeof arg !== "string" || arg.length === 0) {
      return new UnavailableError({
        code: "managed-executable-invalid",
        message: "the managed executable argument prefix contains an empty argument.",
      })
    }
    if (arg.length > MANAGED_LIMITS.maxArgLength || hasControlCharacters(arg)) {
      return new UnavailableError({
        code: "managed-executable-invalid",
        message: "the managed executable argument prefix contains an invalid argument.",
      })
    }
    prefixBytes += Buffer.byteLength(arg, "utf8")
  }
  if (prefixBytes > MAX_ARGS_PREFIX_BYTES) {
    return new UnavailableError({
      code: "managed-executable-invalid",
      message: `the managed executable argument prefix exceeds ${MAX_ARGS_PREFIX_BYTES} bytes.`,
    })
  }
  if (executable.cwd !== undefined) {
    if (executable.cwd.length === 0 || hasControlCharacters(executable.cwd) || !path.isAbsolute(executable.cwd)) {
      return new UnavailableError({
        code: "managed-executable-invalid",
        message: "the managed executable working directory must be an absolute path.",
      })
    }
  }
  return undefined
}

function toProtocolViolation(
  cause: unknown,
  context: { command: ManagedProtocolCommand; exitCode?: number; stdout?: string; stderr?: string },
): ProtocolViolationError {
  const code = typeof cause === "object" && cause !== null && "code" in cause ? String((cause as { code: string }).code) : "stderr-invalid"
  const message =
    cause instanceof globalThis.Error && cause.message.length > 0 ? cause.message : "the managed response violated the wire protocol."
  return new ProtocolViolationError({
    code,
    message,
    command: context.command,
    ...(context.exitCode === undefined ? {} : { exitCode: context.exitCode }),
    ...(context.stdout === undefined || context.stdout.length === 0
      ? {}
      : { stdoutExcerpt: boundedExcerpt(context.stdout) }),
    ...(context.stderr === undefined || context.stderr.length === 0
      ? {}
      : { stderrExcerpt: boundedExcerpt(context.stderr) }),
  })
}

function ambiguityFromAppProcess(error: AppProcessError, command: ManagedProtocolCommand) {
  const cause = error.cause
  if (cause instanceof globalThis.Error && cause.name === "AbortError") {
    return new AmbiguousOutcomeError({
      reason: "cancelled",
      message: `the managed command ${command} was cancelled after it started; the outcome is ambiguous.`,
      command,
    })
  }
  return new UnavailableError({
    code: "managed-process-unavailable",
    message: error.message,
  })
}

function detailsJsonFor(payload: { quarantine?: unknown; state?: unknown }): string | undefined {
  if (payload.quarantine === undefined && payload.state === undefined) return undefined
  let serialized: string | undefined
  try {
    serialized = JSON.stringify({ quarantine: payload.quarantine, state: payload.state })
  } catch {
    return undefined
  }
  if (serialized === undefined) return undefined
  if (Buffer.byteLength(serialized, "utf8") > MAX_DETAILS_BYTES) {
    return boundedExcerpt(serialized, MAX_DETAILS_BYTES)
  }
  return serialized
}

export function classifyManagedErrorResponse(
  error: {
    code: string
    category: "invalid-request" | "contention" | "reconcile-required" | "internal"
    retryable: boolean
    message: string
    worktreeId?: string
    operationId?: string
    reconcileRequired?: boolean
    quarantine?: unknown
    state?: unknown
  },
  context: { command: ManagedProtocolCommand; exitCode?: number; stderr?: string },
): Error {
  const optional = {
    ...(error.worktreeId === undefined ? {} : { worktreeId: error.worktreeId }),
    ...(error.operationId === undefined ? {} : { operationId: error.operationId }),
  }
  if (!MANAGED_ERROR_CODE_SET.has(error.code) || MANAGED_PROTOCOL_MISMATCH_CODES.has(error.code)) {
    return new ProtocolViolationError({
      code: error.code,
      message: error.message,
      command: context.command,
      ...(context.exitCode === undefined ? {} : { exitCode: context.exitCode }),
      ...(context.stderr === undefined || context.stderr.length === 0 ? {} : { stderrExcerpt: boundedExcerpt(context.stderr) }),
    })
  }
  switch (error.category) {
    case "contention":
      return new ContentionError({ code: error.code, message: error.message, ...optional })
    case "reconcile-required": {
      const detailsJson = detailsJsonFor(error)
      return new ReconcileError({
        code: error.code,
        message: error.message,
        reconcileRequired: error.reconcileRequired ?? true,
        ...optional,
        ...(detailsJson === undefined ? {} : { detailsJson }),
      })
    }
    case "internal":
      return new InternalError({ code: error.code, message: error.message })
    case "invalid-request": {
      if (error.code === MANAGED_ERROR_CODES.controlPlaneUnavailable) {
        return new UnavailableError({ code: error.code, message: error.message })
      }
      if (MANAGED_INVOCATION_ERROR_CODES.has(error.code)) {
        return new RequestRejectedError({ code: error.code, message: error.message, kind: "invocation" })
      }
      if (MANAGED_DOMAIN_REFUSAL_CODES.has(error.code)) {
        return new RequestRejectedError({ code: error.code, message: error.message, kind: "domain" })
      }
      return new RequestRejectedError({ code: error.code, message: error.message, kind: "other" })
    }
  }
}

export interface ProtocolVersionOptions {
  readonly executable: ManagedExecutable
  readonly timeout?: Duration.Input
  readonly signal?: AbortSignal
}

export interface StatusOptions {
  readonly executable: ManagedExecutable
  readonly worktreeId: string
  readonly controlPlaneRoot: string
  readonly coordinatorEndpoint?: string
  readonly discoveryDirectory?: string
  readonly timeout?: Duration.Input
  readonly signal?: AbortSignal
}

export interface CreateInitializeOptions {
  readonly executable: ManagedExecutable
  readonly request: ManagedCreateInitializeInput
  readonly controlPlaneRoot: string
  readonly coordinatorEndpoint?: string
  readonly discoveryDirectory?: string
  readonly timeout?: Duration.Input
  readonly signal?: AbortSignal
}

export interface Interface {
  readonly protocolVersion: (options: ProtocolVersionOptions) => Effect.Effect<ManagedProtocolVersionResult, Error>
  readonly status: (options: StatusOptions) => Effect.Effect<ManagedStatusResult, Error>
  readonly createInitialize: (options: CreateInitializeOptions) => Effect.Effect<ManagedCreateInitializeResult, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ManagedWorktreeManager") {}

interface InvokeInput {
  readonly command: ManagedProtocolCommand
  readonly document: unknown
  readonly executable: ManagedExecutable
  readonly controlPlaneRoot?: string
  readonly coordinatorEndpoint?: string
  readonly discoveryDirectory?: string
  readonly timeout: Duration.Input
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const appProcess = yield* AppProcess.Service

    const invoke = Effect.fnUntraced(function* (input: InvokeInput) {
      const invalid = validateManagedExecutable(input.executable)
      if (invalid !== undefined) return yield* invalid
      if (input.controlPlaneRoot !== undefined && !path.isAbsolute(input.controlPlaneRoot)) {
        return yield* new InternalError({
          code: "invocation-invalid",
          message: "the control-plane root must be an absolute path.",
        })
      }
      if (input.coordinatorEndpoint !== undefined && input.coordinatorEndpoint.length === 0) {
        return yield* new InternalError({
          code: "invocation-invalid",
          message: "the coordinator endpoint must not be empty.",
        })
      }
      if (input.discoveryDirectory !== undefined && !path.isAbsolute(input.discoveryDirectory)) {
        return yield* new InternalError({
          code: "invocation-invalid",
          message: "the OpenFork service-discovery directory must be an absolute path.",
        })
      }

      const requestText = yield* Effect.try({
        try: () => serializeRequestDocument(input.document),
        catch: (cause) =>
          cause instanceof ManagedRequestInvalid
            ? new InternalError({ code: cause.code, message: cause.message })
            : new InternalError({ code: "request-invalid", message: "the managed request document could not be serialized." }),
      })

      const args = [...input.executable.argsPrefix, input.command]
      if (input.controlPlaneRoot !== undefined) args.push("--control-plane-root", input.controlPlaneRoot)
      if (input.coordinatorEndpoint !== undefined) args.push("--coordinator-endpoint", input.coordinatorEndpoint)
      if (input.discoveryDirectory !== undefined) {
        args.push("--openfork-discovery-directory", input.discoveryDirectory)
      }

      const command = ChildProcess.make(input.executable.path, args, {
        cwd: input.executable.cwd ?? path.dirname(input.executable.path),
        extendEnv: true,
        stdin: "pipe",
        forceKillAfter: "5 seconds",
      })

      const result = yield* appProcess
        .run(command, {
          stdin: requestText,
          maxOutputBytes: MANAGED_LIMITS.maxStdoutBytes,
          maxErrorBytes: MANAGED_LIMITS.maxStderrBytes,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        })
        .pipe(
          Effect.catchTag("AppProcessError", (error) => Effect.fail(ambiguityFromAppProcess(error, input.command))),
          Effect.timeoutOrElse({
            duration: input.timeout,
            orElse: () =>
              Effect.fail(
                new AmbiguousOutcomeError({
                  reason: "timeout",
                  message: `the managed command ${input.command} timed out after ${input.timeoutMs ?? "the configured"}ms; the outcome is ambiguous.`,
                  command: input.command,
                  ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
                }),
              ),
          }),
        )

      const stdout = result.stdout.toString("utf8")
      const stderr = result.stderr.toString("utf8")
      if (result.stdoutTruncated) {
        return yield* new ProtocolViolationError({
          code: "stdout-truncated",
          message: `the managed command ${input.command} produced stdout beyond ${MANAGED_LIMITS.maxStdoutBytes} bytes.`,
          command: input.command,
          exitCode: result.exitCode,
          ...(stdout.length === 0 ? {} : { stdoutExcerpt: boundedExcerpt(stdout) }),
        })
      }
      if (stdout.trim().length === 0 && result.exitCode !== 0) {
        return yield* new UnavailableError({
          code: "managed-process-unavailable",
          message: `the managed command ${input.command} exited with ${result.exitCode} without a protocol response${stderr.trim().length === 0 ? "." : `: ${boundedExcerpt(stderr.trim())}`}`,
        })
      }

      const outcome: ManagedExitOutcome = yield* Effect.try({
        try: () => parseManagedExitOutcome({ exitCode: result.exitCode, stdout, stderr }, { command: input.command }),
        catch: (cause) => toProtocolViolation(cause, { command: input.command, exitCode: result.exitCode, stdout, stderr }),
      })

      if (!outcome.response.ok) {
        return yield* classifyManagedErrorResponse(outcome.response.error, {
          command: input.command,
          exitCode: result.exitCode,
          stderr,
        })
      }
      return outcome.response
    })

    const protocolVersion = Effect.fn("ManagedWorktreeManager.protocolVersion")(function* (options: ProtocolVersionOptions) {
      const outcome = yield* invoke({
        command: "protocol-version",
        document: protocolVersionRequestDocument(),
        executable: options.executable,
        timeout: options.timeout ?? Duration.millis(MANAGED_TIMEOUTS.protocolVersionMs),
        timeoutMs: MANAGED_TIMEOUTS.protocolVersionMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      return yield* Effect.try({
        try: () => parseManagedProtocolVersionResult(outcome.result),
        catch: (cause) => toProtocolViolation(cause, { command: "protocol-version" }),
      })
    })

    const status = Effect.fn("ManagedWorktreeManager.status")(function* (options: StatusOptions) {
      const outcome = yield* invoke({
        command: "managed-status",
        document: statusRequestDocument(options.worktreeId),
        executable: options.executable,
        controlPlaneRoot: options.controlPlaneRoot,
        ...(options.coordinatorEndpoint === undefined ? {} : { coordinatorEndpoint: options.coordinatorEndpoint }),
        ...(options.discoveryDirectory === undefined ? {} : { discoveryDirectory: options.discoveryDirectory }),
        timeout: options.timeout ?? Duration.millis(MANAGED_TIMEOUTS.statusMs),
        timeoutMs: MANAGED_TIMEOUTS.statusMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      return yield* Effect.try({
        try: () => parseManagedStatusResult(outcome.result, { worktreeId: options.worktreeId }),
        catch: (cause) => toProtocolViolation(cause, { command: "managed-status" }),
      })
    })

    const createInitialize = Effect.fn("ManagedWorktreeManager.createInitialize")(function* (
      options: CreateInitializeOptions,
    ) {
      const document = yield* Effect.try({
        try: () => createInitializeRequestDocument(options.request),
        catch: (cause) =>
          cause instanceof ManagedRequestInvalid
            ? new InternalError({ code: cause.code, message: cause.message })
            : cause instanceof globalThis.Error
              ? new InternalError({ code: MANAGED_ERROR_CODES.requestInvalid, message: cause.message })
              : new InternalError({ code: MANAGED_ERROR_CODES.requestInvalid, message: "invalid managed request." }),
      })
      const outcome = yield* invoke({
        command: "managed-create-initialize",
        document,
        executable: options.executable,
        controlPlaneRoot: options.controlPlaneRoot,
        ...(options.coordinatorEndpoint === undefined ? {} : { coordinatorEndpoint: options.coordinatorEndpoint }),
        ...(options.discoveryDirectory === undefined ? {} : { discoveryDirectory: options.discoveryDirectory }),
        timeout: options.timeout ?? Duration.millis(MANAGED_TIMEOUTS.createInitializeMs),
        timeoutMs: MANAGED_TIMEOUTS.createInitializeMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      return yield* Effect.try({
        try: () => parseManagedCreateInitializeResult(outcome.result, { request: toWireRequest(options.request) }),
        catch: (cause) => toProtocolViolation(cause, { command: "managed-create-initialize" }),
      })
    })

    return Service.of({ protocolVersion, status, createInitialize })
  }),
)

function toWireRequest(input: ManagedCreateInitializeInput): ManagedCreateInitializeRequest {
  return {
    worktreeId: input.worktreeId,
    repositoryId: input.repositoryId,
    ...(input.repositoryPath === undefined ? {} : { repositoryPath: input.repositoryPath }),
    storageVolumeId: input.storageVolumeId,
    targetPath: input.targetPath,
    branchName: input.branchName,
    commitish: input.commitish,
    storagePolicy: input.storagePolicy,
    storageProbe: input.storageProbe,
    dedupe: input.dedupe,
  }
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [AppProcess.node],
})

export * as ManagedWorktreeManager from "./client"
