import { randomUUID } from "node:crypto"
import { Context, Effect, Exit, Layer, Schedule, Schema, Scope, Semaphore, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import type { Command } from "effect/unstable/process/ChildProcess"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { AppProcess } from "@opencode-ai/core/process"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ShellLaunch } from "@/tool/shell/launch"
import * as Utf8 from "@/util/utf8"
import { ExchangeOwnedCommand } from "@/exchange/owned-command"
import { OxpAuthority } from "./authority"
import { OxpConfig } from "./config"
import { OxpProcessArchive } from "./process-archive"
import { OxpProcessEnvironment } from "./process-environment"
import { OxpError } from "./error"
import { OxpResult } from "./result"
import { OxpRoot } from "./root"
import { OxpSchema } from "./schema"

const MAX_COMMAND_BYTES = 256 * 1024
const MAX_OUTPUT_BYTES = 256 * 1024
const STATUS_OUTPUT_BYTES = 8 * 1024
const MAX_HANDLES = 64

const Handle = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80), Schema.isPattern(/^proc_[A-Za-z0-9_-]+$/))
const Workdir = Schema.String.check(Schema.isMaxLength(4096))
const Command = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_COMMAND_BYTES))
const Argv = Schema.Array(Schema.String.check(Schema.isMaxLength(MAX_COMMAND_BYTES))).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
)
const Mode = Schema.Literals(["foreground", "background"])
const YieldMs = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30_000 }))
const TimeoutMs = Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 3_600_000 }))
const MaxBytes = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_OUTPUT_BYTES }))
const Offset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

const StartShell = Schema.Struct({
  action: Schema.Literal("start"),
  rootID: OxpSchema.RootID,
  workdir: Schema.optionalKey(Workdir),
  command: Command,
  mode: Schema.optionalKey(Mode),
  shell: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
  yieldMs: Schema.optionalKey(YieldMs),
})
const StartArgv = Schema.Struct({
  action: Schema.Literal("start"),
  rootID: OxpSchema.RootID,
  workdir: Schema.optionalKey(Workdir),
  argv: Argv,
  mode: Schema.optionalKey(Mode),
  yieldMs: Schema.optionalKey(YieldMs),
})
const List = Schema.Struct({ action: Schema.Literal("list"), rootID: OxpSchema.RootID })
const Status = Schema.Struct({ action: Schema.Literal("status"), handle: Handle })
const Poll = Schema.Struct({
  action: Schema.Literal("poll"),
  handle: Handle,
  offset: Schema.optionalKey(Offset),
  maxBytes: Schema.optionalKey(MaxBytes),
})
const Write = Schema.Struct({
  action: Schema.Literal("write"),
  handle: Handle,
  chars: Schema.String.check(Schema.isMaxLength(256 * 1024)),
  timeoutMs: Schema.optionalKey(TimeoutMs),
})
const Wait = Schema.Struct({
  action: Schema.Literal("wait"),
  handle: Handle,
  timeoutMs: Schema.optionalKey(TimeoutMs),
  offset: Schema.optionalKey(Offset),
  maxBytes: Schema.optionalKey(MaxBytes),
})
const Kill = Schema.Struct({ action: Schema.Literal("kill"), handle: Handle })
const Remove = Schema.Struct({ action: Schema.Literal("remove"), handle: Handle })

/**
 * RuntimeParameters is the canonical post-normalization grammar. The public
 * transport schema is intentionally flatter because ChatGPT/MCP hosts can drop
 * root union constraints. Never rely on host-preserved oneOf semantics here.
 */
const RuntimeParameters = Schema.Union([StartArgv, StartShell, List, Status, Poll, Write, Wait, Kill, Remove])
type RuntimeInput = Schema.Schema.Type<typeof RuntimeParameters>

type TransportNormalization = {
  readonly runtime: RuntimeInput
  readonly ignored: readonly string[]
}

function normalizeTransport(input: Input): TransportNormalization {
  const present = Object.entries(input)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key)
  const finish = (runtime: RuntimeInput, used: readonly string[]): TransportNormalization => ({
    runtime,
    ignored: present.filter((key) => !used.includes(key)),
  })

  if (input.action === "start") {
    if (!input.rootID) {
      throw new OxpError.RootRequired({
        detail: "process.start requires an explicit approved root",
      })
    }

    const common = {
      action: "start" as const,
      rootID: input.rootID,
      ...(input.workdir !== undefined ? { workdir: input.workdir } : {}),
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
      ...(input.yieldMs !== undefined ? { yieldMs: input.yieldMs } : {}),
    }

    if (input.argv !== undefined) {
      return finish(
        { ...common, argv: input.argv },
        ["action", "rootID", "workdir", "mode", "yieldMs", "argv"],
      )
    }
    if (input.command !== undefined) {
      return finish(
        {
          ...common,
          command: input.command,
          ...(input.shell !== undefined ? { shell: input.shell } : {}),
        },
        ["action", "rootID", "workdir", "mode", "yieldMs", "command", "shell"],
      )
    }
    throw new OxpError.InvalidArgument({
      detail: "process.start requires argv or command",
    })
  }

  if (input.action === "list") {
    if (!input.rootID) {
      throw new OxpError.RootRequired({
        detail: "process.list requires an explicit approved root",
      })
    }
    return finish(
      { action: "list", rootID: input.rootID },
      ["action", "rootID"],
    )
  }

  if (!input.handle) {
    throw new OxpError.InvalidArgument({
      detail: `process.${input.action} requires handle`,
    })
  }

  if (input.action === "status") {
    return finish(
      { action: "status", handle: input.handle },
      ["action", "handle"],
    )
  }
  if (input.action === "poll") {
    return finish(
      {
        action: "poll",
        handle: input.handle,
        ...(input.offset !== undefined ? { offset: input.offset } : {}),
        ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
      },
      ["action", "handle", "offset", "maxBytes"],
    )
  }
  if (input.action === "write") {
    if (input.chars === undefined) {
      throw new OxpError.InvalidArgument({
        detail: "process.write requires chars",
      })
    }
    return finish(
      {
        action: "write",
        handle: input.handle,
        chars: input.chars,
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      },
      ["action", "handle", "chars", "timeoutMs"],
    )
  }
  if (input.action === "wait") {
    return finish(
      {
        action: "wait",
        handle: input.handle,
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.offset !== undefined ? { offset: input.offset } : {}),
        ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
      },
      ["action", "handle", "timeoutMs", "offset", "maxBytes"],
    )
  }
  if (input.action === "kill") {
    return finish(
      { action: "kill", handle: input.handle },
      ["action", "handle"],
    )
  }
  return finish(
    { action: "remove", handle: input.handle },
    ["action", "handle"],
  )
}

/**
 * Transport-safe public schema.
 *
 * Some MCP/ChatGPT schema projectors flatten a root anyOf and can silently
 * drop one discriminated branch (notably process.start argv vs command). The
 * public contract therefore advertises the complete superset of fields in one
 * object. Known cross-action fields are normalized away before RuntimeParameters
 * validates the canonical action shape; unknown transport fields still fail at
 * the public Parameters boundary.
 */
export const Parameters = Schema.Struct({
  action: Schema.Literals(["start", "list", "status", "poll", "write", "wait", "kill", "remove"]).annotate({
    description: "Process operation. OXP normalizes this flat transport envelope into the canonical action shape before execution.",
  }),
  rootID: Schema.optionalKey(OxpSchema.RootID).annotate({
    description: "Required only for start and list; identifies the explicit approved root that owns the process.",
  }),
  workdir: Schema.optionalKey(Workdir).annotate({ description: "start only; optional directory inside rootID." }),
  command: Schema.optionalKey(Command).annotate({
    description: "start only; shell command form. Use argv instead when no shell syntax is required.",
  }),
  argv: Schema.optionalKey(Argv).annotate({
    description: "start only; preferred exact executable/argument vector. Mutually exclusive with command.",
  }),
  mode: Schema.optionalKey(Mode).annotate({ description: "start only; foreground or background." }),
  shell: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))).annotate({
    description: "command start only; optional explicit shell executable.",
  }),
  yieldMs: Schema.optionalKey(YieldMs).annotate({ description: "start only; bounded foreground yield before returning a live handle." }),
  handle: Schema.optionalKey(Handle).annotate({
    description:
      "Required for status, poll, write, wait, kill, and remove; never a PID. Finalized public-process handles survive OXP runtime refresh for read-only status/poll/wait/remove recovery; recovered write/kill fail closed.",
  }),
  chars: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256 * 1024))).annotate({
    description: "write only; raw continuation bytes/text sent to the owned process stdin.",
  }),
  timeoutMs: Schema.optionalKey(TimeoutMs).annotate({ description: "write/wait only; bounded operation duration." }),
  offset: Schema.optionalKey(Offset).annotate({ description: "poll/wait only; byte offset into retained output." }),
  maxBytes: Schema.optionalKey(MaxBytes).annotate({ description: "poll/wait only; maximum output bytes to return." }),
})
export type Input = Schema.Schema.Type<typeof Parameters>

type Job = {
  readonly handle: string
  readonly connectorID: OxpSchema.ConnectorID
  readonly rootID: OxpSchema.RootID
  readonly workdir: string
  readonly command: string
  readonly shell: string
  readonly stdinWritable: boolean
  readonly mode: "foreground" | "background"
  readonly startedAt: number
  readonly process: ChildProcessHandle
  readonly scope: Scope.Closeable
  readonly outputDrained: Promise<void>
  archiveEnabled: boolean
  archiveCommitted: boolean
  output: string
  outputBytes: number
  truncated: boolean
  exitCode?: number
  terminationReason?: OxpProcessArchive.TerminationReason
  terminationSignal?: string
  endedAt?: number
}

export interface Interface {
  readonly execute: (input: Input, signal?: AbortSignal) => Effect.Effect<OxpResult.CapabilityResult, OxpError.Error>
  /**
   * Internal exact-argv execution seam for specialized OXP capabilities.
   * It deliberately shares this service's connector ownership, revocation
   * subscription, output capture, and process-tree retirement.
   */
  readonly startArgv: (
    input: {
      readonly rootID: OxpSchema.RootID
      readonly workdir?: string
      readonly argv: readonly [string, ...string[]]
      readonly env?: NodeJS.ProcessEnv
      readonly title?: string
      readonly operation?: string
      readonly mode?: "foreground" | "background"
      readonly archive?: boolean
      readonly onChunk?: (chunk: string) => void
      readonly onStdout?: (chunk: string) => void
      readonly onStderr?: (chunk: string) => void
    },
    signal?: AbortSignal,
  ) => Effect.Effect<{ readonly handle: string; readonly process: ChildProcessHandle }, OxpError.Error>
  /** Shared bounded exact-argv lifecycle for specialized OXP capabilities. */
  readonly runArgv: (
    input: {
      readonly rootID: OxpSchema.RootID
      readonly workdir?: string
      readonly argv: readonly [string, ...string[]]
      readonly env?: NodeJS.ProcessEnv
      readonly title?: string
      readonly operation?: string
      readonly timeoutMs: number
      readonly outputCapBytes?: number
    },
    signal?: AbortSignal,
  ) => Effect.Effect<ExchangeOwnedCommand.Result, OxpError.Error>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/OxpProcess") {}
export const use = serviceUse(Service)

function cancelled(signal?: AbortSignal): Effect.Effect<void, OxpError.Error> {
  return signal?.aborted
    ? Effect.fail<OxpError.Error>(new OxpError.Cancelled({ detail: "OXP process request was cancelled" }))
    : Effect.void
}

function hasResolvedPath(
  value: { readonly canonicalPath: string },
): value is { readonly canonicalPath: string; readonly path: string } {
  return "path" in value && typeof (value as { readonly path?: unknown }).path === "string"
}

function append(job: Job, chunk: string) {
  const bytes = Utf8.byteLength(chunk)
  job.outputBytes += bytes
  const retained = Utf8.byteLength(job.output)
  if (retained >= MAX_OUTPUT_BYTES) {
    job.truncated = true
    return
  }
  const remaining = MAX_OUTPUT_BYTES - retained
  const next = Utf8.truncate(chunk, remaining)
  job.output += next.text
  if (next.truncated) job.truncated = true
}

function signalFromExitError(error: unknown) {
  const cause =
    typeof error === "object" && error !== null && "cause" in error
      ? (error as { cause?: unknown }).cause
      : undefined
  const message =
    cause instanceof Error
      ? cause.message
      : error instanceof Error
        ? error.message
        : String(cause ?? error)
  return /receipt of signal: '([^']+)'/.exec(message)?.[1]
}

const settle = (job: Job) =>
  job.process.exitCode.pipe(
    // Exit status belongs to process lifetime, not pipe-drain lifetime. Record
    // it as soon as the platform proves termination so a bounded output-drain
    // timeout can never erase the terminal code we already know.
    Effect.tap((code) =>
      Effect.sync(() => {
        job.exitCode = code
      }),
    ),
    // POSIX reports signal termination as an exitCode failure even though the
    // process is definitively dead. Terminal truth must not depend on whether a
    // numeric code exists; retain the code when known, then still drain/stamp
    // the job when termination was signal-based.
    Effect.catch((error) =>
      Effect.sync(() => {
        const signal = signalFromExitError(error)
        if (!signal) return
        job.terminationSignal ??= signal
        job.terminationReason ??= "signal"
      }),
    ),
    Effect.flatMap(() =>
      Effect.promise(() => job.outputDrained).pipe(
        Effect.andThen(
          Effect.sync(() => {
            job.endedAt ??= Date.now()
          }),
        ),
      ),
    ),
  )

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const authority = yield* OxpAuthority.Service
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const archive = yield* OxpProcessArchive.Service
    const app = yield* AppProcess.Service
    const fs = yield* FSUtil.Service
    const jobs = new Map<string, Job>()
    const capacityLock = Semaphore.makeUnsafe(1)
    const reapLock = Semaphore.makeUnsafe(1)
    const archiveStateLock = Semaphore.makeUnsafe(1)
    const revocationTasks = new Set<Promise<unknown>>()
    let pendingStarts = 0

    // Config subscriptions are synchronous callbacks, but the retirement work
    // they launch is asynchronous. Track every callback-launched task so the
    // service scope cannot close while a revocation/archive flock is still
    // releasing against state that the caller may immediately tear down.
    const launchRevocationTask = (effect: Effect.Effect<void, never>) => {
      const pending = Effect.runPromise(effect)
      revocationTasks.add(pending)
      void pending.then(
        () => revocationTasks.delete(pending),
        () => revocationTasks.delete(pending),
      )
    }

    const archiveTerminal = Effect.fnUntraced(function* (job: Job) {
      if (!job.archiveEnabled || job.archiveCommitted || job.endedAt === undefined) return
      yield* archiveStateLock.withPermit(
        Effect.gen(function* () {
          if (!job.archiveEnabled || job.archiveCommitted || job.endedAt === undefined) return
          yield* archive.finalize({
            handle: job.handle,
            connectorID: job.connectorID,
            rootID: job.rootID,
            workdir: job.workdir,
            mode: job.mode,
            startedAt: job.startedAt,
            endedAt: job.endedAt,
            ...(job.exitCode === undefined ? {} : { exitCode: job.exitCode }),
            ...(job.terminationReason === undefined
              ? {}
              : { terminationReason: job.terminationReason }),
            ...(job.terminationSignal === undefined
              ? {}
              : { terminationSignal: job.terminationSignal }),
            outputBytes: job.outputBytes,
            truncated: job.truncated,
            output: job.output,
          })
          job.archiveCommitted = true
        }),
      )
    })

    const disableArchiveAndRemove = Effect.fnUntraced(function* (job: Job) {
      job.archiveEnabled = false
      yield* archiveStateLock.withPermit(archive.remove(job.handle))
      job.archiveCommitted = false
    })

    const settleOwned = (job: Job) =>
      settle(job).pipe(Effect.andThen(archiveTerminal(job)))

    const retryPendingArchives = Effect.fnUntraced(function* () {
      const pending = [...jobs.values()].filter(
        (job) =>
          job.endedAt !== undefined &&
          job.archiveEnabled &&
          !job.archiveCommitted,
      )
      yield* Effect.forEach(
        pending,
        (job) => archiveTerminal(job).pipe(Effect.ignore),
        { concurrency: 8, discard: true },
      )
    })

    const retire = Effect.fnUntraced(function* (
      job: Job,
      reason: OxpProcessArchive.TerminationReason = "runtime-dispose",
    ) {
      if (yield* job.process.isRunning) {
        job.terminationReason ??= reason
        yield* job.process.kill({ forceKillAfter: "3 seconds" }).pipe(
          Effect.mapError(() => new OxpError.DependencyUnavailable({ detail: "Unable to prove OXP process tree retirement" })),
        )
      }
      // Kill/retirement is not truthfully settled until the child exit code and
      // already-owned output pipes have had a bounded chance to drain. Keeping
      // this before Scope.close avoids publishing running:false with no exitCode
      // merely because closing the capture scope interrupted the settle fiber.
      yield* settleOwned(job).pipe(
        Effect.timeoutOrElse({ duration: "3 seconds", orElse: () => Effect.void }),
        Effect.ignore,
      )
      yield* Scope.close(job.scope, Exit.void).pipe(Effect.ignore)
    })

    const reapSettledForCapacity = Effect.fnUntraced(function* () {
      if (jobs.size + pendingStarts < MAX_HANDLES) return
      // Expensive exit/drain reconciliation must not hold the admission lock:
      // a dead descendant can keep inherited pipes open for the full bounded
      // drain window, and unrelated live starts still need to commit/release
      // their reservations. Serialize only reapers with each other.
      yield* reapLock.withPermit(
        Effect.gen(function* () {
          if (jobs.size + pendingStarts < MAX_HANDLES) return
          // A child may have exited before the detached settle fiber gets CPU
          // time. Reconcile those roots once before declaring Busy so a registry
          // full of already-dead children heals itself instead of wedging.
          const exited: Job[] = []
          for (const job of jobs.values()) {
            if (job.endedAt !== undefined) continue
            if (!(yield* job.process.isRunning)) exited.push(job)
          }
          yield* Effect.forEach(
            exited,
            (job) =>
              settleOwned(job).pipe(
                Effect.timeoutOrElse({ duration: "3 seconds", orElse: () => Effect.void }),
                Effect.ignore,
              ),
            { concurrency: "unbounded", discard: true },
          )
          yield* retryPendingArchives()

          // Registry mutation stays atomic with capacity reservations, but scope
          // closure happens after releasing the permit because terminal jobs no
          // longer consume executable capacity and cleanup may itself suspend.
          const reclaimed: Job[] = []
          yield* capacityLock.withPermit(
            Effect.sync(() => {
              const settled = [...jobs.values()]
                .filter(
                  (job) =>
                    job.endedAt !== undefined &&
                    (!job.archiveEnabled || job.archiveCommitted),
                )
                .sort((left, right) => (left.endedAt ?? 0) - (right.endedAt ?? 0))
              for (const job of settled) {
                if (jobs.size + pendingStarts < MAX_HANDLES) break
                if (jobs.delete(job.handle)) reclaimed.push(job)
              }
            }),
          )
          yield* Effect.forEach(
            reclaimed,
            (job) => Scope.close(job.scope, Exit.void).pipe(Effect.ignore),
            { concurrency: "unbounded", discard: true },
          )
        }),
      )
    })

    // Retirement is independent per owned process. Serial disposal would turn
    // the bounded per-process kill/drain windows into an O(MAX_HANDLES) shutdown
    // tail (minutes at the current cap), so retire the bounded registry in
    // parallel while preserving each job's own fail-closed semantics.
    yield* Effect.addFinalizer(() =>
      Effect.forEach([...jobs.values()], (job) => retire(job, "runtime-dispose").pipe(Effect.ignore), {
        concurrency: "unbounded",
        discard: true,
      }),
    )

    // Revocation is active, not merely an admission rule. Process authority or
    // root removal retires the trees this connector owns without a Session/PID
    // becoming the authorization token.
    const unsubscribe = yield* config.subscribe((next) => {
      for (const job of jobs.values()) {
        const validRoot = next.roots.some((root) => root.id === job.rootID)
        if (!next.enabled || !next.grant.process || next.connector.id !== job.connectorID || !validRoot) {
          job.archiveEnabled = false
          launchRevocationTask(
            retire(job, "authority-revoked").pipe(
              Effect.andThen(disableArchiveAndRemove(job)),
              Effect.andThen(Effect.sync(() => jobs.delete(job.handle))),
              // Fail closed: a tree that could not be proven stopped remains
              // owned in the registry for shutdown/recovery rather than becoming
              // an orphan merely because authority was revoked.
              Effect.catch(() => Effect.void),
            ),
          )
        }
      }
      // Durable terminal history follows current connector/root/process
      // authority too. Revocation never turns an archive row into a surviving
      // capability; inaccessible rows are purged asynchronously.
      launchRevocationTask(
        archive.list().pipe(
          Effect.flatMap((rows) =>
            Effect.forEach(
              rows,
              (row) => {
                const validRoot = next.roots.some((root) => root.id === row.rootID)
                return next.enabled &&
                  next.grant.process &&
                  next.connector.id === row.connectorID &&
                  validRoot
                  ? Effect.void
                  : archive.remove(row.handle).pipe(Effect.ignore)
              },
              { concurrency: 8, discard: true },
            ),
          ),
          Effect.ignore,
        ),
      )
    })
    yield* Effect.addFinalizer(() =>
      Effect.sync(unsubscribe).pipe(
        Effect.andThen(
          Effect.promise(async () => {
            await Promise.allSettled([...revocationTasks])
          }),
        ),
      ),
    )

    const recoveredView = (row: OxpProcessArchive.Record) => ({
      handle: row.handle,
      rootID: row.rootID,
      workdir: row.workdir,
      mode: row.mode,
      running: false,
      recovered: true as const,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      ...(row.exitCode === undefined ? {} : { exitCode: row.exitCode }),
      ...(row.terminationReason === undefined
        ? {}
        : { terminationReason: row.terminationReason }),
      ...(row.terminationSignal === undefined
        ? {}
        : { terminationSignal: row.terminationSignal }),
      outputBytes: row.outputBytes,
      truncated: row.truncated,
    })

    const recoveredStatusView = (row: OxpProcessArchive.Record) => {
      const state = recoveredView(row)
      const preview = Utf8.window(row.output, 0, STATUS_OUTPUT_BYTES)
      return {
        ...state,
        offset: preview.offset,
        nextOffset: preview.nextOffset,
        retainedBytes: preview.totalBytes,
        pageTruncated: preview.truncated,
        ...(preview.text.length === 0
          ? {}
          : {
              output: preview.text,
              outputNextOffset: preview.nextOffset,
              outputPreviewTruncated: preview.truncated,
            }),
      }
    }

    // Config subscription covers explicit authorization changes, but an approved
    // directory can disappear or be replaced on disk without any config event.
    // Long-running jobs must not outlive that physical root authority. Only live
    // jobs belong in this watchdog: archived process history has no execution
    // authority, and adding its roots here caused config/filesystem verification
    // for every historical root once per second even when no child was running.
    // Deduplicate checks so cost is at most one verification per active root per
    // interval rather than one stat per process.
    const reconcilePhysicalRoots = Effect.fnUntraced(function* () {
      const byRoot = new Map<OxpSchema.RootID, Job[]>()
      for (const job of jobs.values()) {
        if (job.endedAt !== undefined) continue
        const group = byRoot.get(job.rootID)
        if (group) group.push(job)
        else byRoot.set(job.rootID, [job])
      }
      yield* Effect.forEach(
        [...byRoot.entries()],
        ([rootID, rootJobs]) =>
          roots.resolveRoot(rootID).pipe(
            Effect.asVoid,
            Effect.catchIf(
              (error) => OxpError.isError(error) && error._tag === "OXP_ROOT_CHANGED",
              () =>
                Effect.all(
                  [
                    Effect.forEach(
                      rootJobs,
                      (job) =>
                        Effect.sync(() => {
                          job.archiveEnabled = false
                        }).pipe(
                          Effect.andThen(retire(job, "root-changed")),
                          Effect.andThen(disableArchiveAndRemove(job)),
                          Effect.andThen(Effect.sync(() => jobs.delete(job.handle))),
                          // A retirement failure remains owned and will be retried
                          // on the next liveness pass instead of orphaning the tree.
                          Effect.catch(() => Effect.void),
                        ),
                      { concurrency: "unbounded", discard: true },
                    ),
                  ],
                  { concurrency: "unbounded", discard: true },
                ),
            ),
            // Explicit config removal races are handled by the subscription
            // above. Other verification errors must not kill the watchdog.
            Effect.catch(() => Effect.void),
          ),
        { concurrency: "unbounded", discard: true },
      )
    })
    yield* Effect.forkScoped(
      reconcilePhysicalRoots().pipe(
        Effect.repeat(Schedule.spaced("1 second")),
        Effect.ignore,
      ),
    )

    const owned = Effect.fnUntraced(function* (handle: string) {
      const job = jobs.get(handle)
      if (!job) return yield* new OxpError.HandleStale({ detail: "Unknown or retired OXP process handle" })
      const state = yield* config.get()
      if (state.connector.id !== job.connectorID) return yield* new OxpError.HandleStale({ detail: "OXP process handle belongs to another connector generation" })
      yield* authority.authorize({ plane: "augmentation", operation: "process.control", phase: "control", rootID: job.rootID })
      return job
    })

    const recovered = Effect.fnUntraced(function* (handle: string, operation = "process.control") {
      const row = yield* archive.get(handle)
      if (!row) return yield* new OxpError.HandleStale({ detail: "Unknown or retired OXP process handle" })
      const state = yield* config.get()
      if (state.connector.id !== row.connectorID) {
        return yield* new OxpError.HandleStale({
          detail: "OXP process archive belongs to another connector generation",
        })
      }
      const admission = yield* authority.authorize({
        plane: "augmentation",
        operation,
        phase: "control",
        rootID: row.rootID,
      })
      return { row, admission } as const
    })

    const view = (job: Job) => ({
      handle: job.handle,
      rootID: job.rootID,
      workdir: job.workdir,
      mode: job.mode,
      running: job.endedAt === undefined,
      startedAt: job.startedAt,
      ...(job.endedAt === undefined
        ? {}
          : {
            endedAt: job.endedAt,
            ...(job.exitCode === undefined ? {} : { exitCode: job.exitCode }),
            ...(job.terminationReason === undefined
              ? {}
              : { terminationReason: job.terminationReason }),
            ...(job.terminationSignal === undefined
              ? {}
              : { terminationSignal: job.terminationSignal }),
          }),
      outputBytes: job.outputBytes,
      truncated: job.truncated,
    })

    const statusView = (job: Job) => {
      const state = view(job)
      const preview = Utf8.window(job.output, 0, STATUS_OUTPUT_BYTES)
      return {
        ...state,
        offset: preview.offset,
        nextOffset: preview.nextOffset,
        retainedBytes: preview.totalBytes,
        pageTruncated: preview.truncated,
        ...(preview.text.length === 0
          ? {}
          : {
              output: preview.text,
              // Compatibility aliases retained for callers that learned the
              // original status-only names before poll/wait pagination parity.
              outputNextOffset: preview.nextOffset,
              outputPreviewTruncated: preview.truncated,
            }),
      }
    }

    const spawnOwned = Effect.fn("OxpProcess.spawnOwned")(function* (input: {
      readonly rootID: OxpSchema.RootID
      readonly workdir?: string
      readonly title: string
      readonly operation: string
      readonly mode: "foreground" | "background"
      readonly shell: string
      readonly stdinWritable: boolean
      readonly archive: boolean
      readonly signal?: AbortSignal
      readonly command: (canonicalWorkdir: string) => Command
      readonly onChunk?: (chunk: string) => void
      readonly onStdout?: (chunk: string) => void
      readonly onStderr?: (chunk: string) => void
    }) {
      yield* cancelled(input.signal)
      const admission = yield* authority.authorize({
        plane: "augmentation",
        operation: input.operation,
        phase: "spawn",
        rootID: input.rootID,
      })
      yield* cancelled(input.signal)
      if (!admission.root || "path" in admission.root) {
        return yield* new OxpError.RootRequired({ detail: "OXP process execution requires one explicit approved root" })
      }
      const cwdPath = input.workdir
        ? (yield* authority.authorize({
            plane: "augmentation",
            operation: input.operation,
            phase: "spawn",
            rootID: input.rootID,
            path: input.workdir,
          })).root
        : admission.root
      if (!cwdPath) return yield* new OxpError.RootRequired({ detail: "OXP process workdir did not resolve" })
      const canonicalWorkdir = hasResolvedPath(cwdPath) ? cwdPath.path : cwdPath.canonicalPath
      const virtualWorkdir = roots.toVirtualPath(admission.root.root, canonicalWorkdir)
      const stat = yield* fs.stat(canonicalWorkdir).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!stat?.type || stat.type !== "Directory") {
        return yield* new OxpError.InvalidArgument({ detail: "OXP process workdir must be an existing directory" })
      }
      yield* authority.revalidate(admission, "spawn")
      yield* cancelled(input.signal)

      // Reconcile terminal handles outside the admission semaphore. The final
      // reservation check below is still authoritative if another start wins a
      // slot while reconciliation is in progress.
      yield* reapSettledForCapacity()

      // Reserve capacity atomically without serializing the expensive process
      // spawn itself. Bracket the reservation itself so Effect-level
      // interruption can never strand pendingStarts between acquisition and the
      // later child/publication lifecycle.
      let reservation = false
      const acquireReservation = capacityLock.withPermit(
        Effect.gen(function* () {
          if (jobs.size + pendingStarts >= MAX_HANDLES) {
            return yield* new OxpError.Busy({ detail: "OXP process handle limit reached" })
          }
          pendingStarts++
          reservation = true
        }),
      )
      const releaseReservation = () =>
        reservation
          ? capacityLock.withPermit(
              Effect.sync(() => {
                if (!reservation) return
                reservation = false
                pendingStarts = Math.max(0, pendingStarts - 1)
              }),
            )
          : Effect.void

      return yield* Effect.acquireUseRelease(
        acquireReservation,
        () =>
          Effect.gen(function* () {
            const state = yield* config.get()
            const scope = yield* Scope.make()
            let publishedHandle: string | undefined
            let publishedJob: Job | undefined
            return yield* Effect.gen(function* () {
              let resolveOutputDrained!: () => void
              const outputDrained = new Promise<void>((resolve) => {
                resolveOutputDrained = resolve
              })
              const spawning = app.spawn(input.command(canonicalWorkdir)).pipe(
                Effect.provideService(Scope.Scope, scope),
                Effect.mapError(() => new OxpError.DependencyUnavailable({ detail: "Unable to spawn OXP process" })),
              )
              const processHandle = yield* (input.signal
                ? spawning.pipe(
                    Effect.raceFirst(
                      AppProcess.waitForAbort(input.signal).pipe(
                        Effect.mapError(() => new OxpError.Cancelled({ detail: "OXP process start was cancelled" })),
                      ),
                    ),
                  )
                : spawning)
              yield* cancelled(input.signal)

              const handle = `proc_${randomUUID().replaceAll("-", "")}`
              const job: Job = {
                handle,
                connectorID: state.connector.id,
                rootID: input.rootID,
                workdir: virtualWorkdir,
                command: input.title,
                shell: input.shell,
                stdinWritable: input.stdinWritable,
                mode: input.mode,
                startedAt: Date.now(),
                process: processHandle,
                scope,
                outputDrained,
                archiveEnabled: false,
                archiveCommitted: false,
                output: "",
                outputBytes: 0,
                truncated: false,
              }
              const observe = (kind: "stdout" | "stderr", chunk: string) =>
                Effect.sync(() => {
                  append(job, chunk)
                  try {
                    input.onChunk?.(chunk)
                    if (kind === "stdout") input.onStdout?.(chunk)
                    else input.onStderr?.(chunk)
                  } catch {
                    // Observers are diagnostics only; they never own process lifetime.
                  }
                })
              const capture =
                input.onStdout || input.onStderr
                  ? Effect.all(
                      [
                        Stream.runForEach(Stream.decodeText(processHandle.stdout), (chunk) => observe("stdout", chunk)),
                        Stream.runForEach(Stream.decodeText(processHandle.stderr), (chunk) => observe("stderr", chunk)),
                      ],
                      { concurrency: "unbounded", discard: true },
                    )
                  : Stream.runForEach(Stream.decodeText(processHandle.all), (chunk) => observe("stdout", chunk))
              yield* capture.pipe(
                // Stream capture is observational. A platform pipe-close must not
                // widen the public error channel or orphan the owned process.
                Effect.catch(() => Effect.void),
                Effect.ensuring(Effect.sync(resolveOutputDrained)),
                Effect.forkIn(scope, { startImmediately: true }),
              )

              // Keep the child private until every fallible authority/cancellation
              // check is complete. Any failure or Effect-level interruption before
              // jobs.set closes the manual scope below, which owns the child release.
              const revalidate = authority.revalidate(admission, "spawn")
              yield* (input.signal
                ? revalidate.pipe(
                    Effect.raceFirst(
                      AppProcess.waitForAbort(input.signal).pipe(
                        Effect.mapError(() => new OxpError.Cancelled({ detail: "OXP process start was cancelled" })),
                      ),
                    ),
                  )
                : revalidate)
              yield* cancelled(input.signal)

              // Start terminal observation while still private; then atomically
              // convert the reservation into the externally addressable handle.
              yield* settle(job).pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
              yield* capacityLock.withPermit(
                Effect.sync(() => {
                  pendingStarts = Math.max(0, pendingStarts - 1)
                  reservation = false
                  jobs.set(handle, job)
                  job.archiveEnabled = input.archive
                  publishedHandle = handle
                  publishedJob = job
                }),
              )
              if (job.archiveEnabled) {
                yield* settleOwned(job).pipe(
                  Effect.ignore,
                  Effect.forkIn(scope, { startImmediately: true }),
                )
              }
              return { handle, process: processHandle } as const
            }).pipe(
              // The scope is intentionally manual because it must outlive a
              // successful start. Until the handle has actually returned to the
              // caller, every failure/defect/interruption owns rollback. If the
              // atomic publication already happened, remove that undisclosed
              // registry row before closing the scope.
              Effect.onError(() =>
                Effect.gen(function* () {
                  if (publishedJob !== undefined) {
                    publishedJob.archiveEnabled = false
                    jobs.delete(publishedJob.handle)
                    yield* disableArchiveAndRemove(publishedJob).pipe(Effect.ignore)
                  } else if (publishedHandle !== undefined) {
                    jobs.delete(publishedHandle)
                  }
                  yield* Scope.close(scope, Exit.void).pipe(Effect.ignore)
                }),
              ),
            )
          })
        ,
        releaseReservation,
      )
    })

    const startArgv: Interface["startArgv"] = Effect.fn("OxpProcess.startArgv")(function* (input, signal) {
      yield* cancelled(signal)
      if (input.argv.length === 0) {
        return yield* new OxpError.InvalidArgument({ detail: "OXP argv execution requires a program" })
      }
      if (input.argv[0] === "") {
        return yield* new OxpError.InvalidArgument({ detail: "OXP argv execution requires a non-empty program" })
      }
      const argvBytes = input.argv.reduce((total, item) => total + Buffer.byteLength(item), 0)
      if (argvBytes > MAX_COMMAND_BYTES) {
        return yield* new OxpError.InvalidArgument({ detail: "OXP argv payload exceeds 256 KiB" })
      }
      const [bin, ...args] = input.argv
      const title = input.title ?? [bin, ...args].join(" ")
      const spawned = yield* spawnOwned({
        rootID: input.rootID,
        workdir: input.workdir,
        title,
        operation: input.operation ?? "process.start",
        mode: input.mode ?? "background",
        shell: "",
        stdinWritable: true,
        archive: input.archive ?? false,
        signal,
        command: (canonicalWorkdir) =>
          ChildProcess.make(bin, args, {
            cwd: canonicalWorkdir,
            env: OxpProcessEnvironment.childEnvironment(input.env ?? process.env),
            stdin: "pipe",
            detached: process.platform !== "win32",
            forceKillAfter: "3 seconds",
          }),
        onChunk: input.onChunk,
        onStdout: input.onStdout,
        onStderr: input.onStderr,
      }).pipe(
        Effect.mapError((error) =>
          OxpError.isError(error)
            ? error
            : new OxpError.DependencyUnavailable({ detail: "Unable to start exact-argv OXP process" }),
        ),
      )
      return spawned
    })

    const executeRaw = Effect.fn("OxpProcess.execute")(function* (input: RuntimeInput, signal?: AbortSignal) {
      yield* cancelled(signal)
      if (input.action === "list") {
        if (!input.rootID) return yield* new OxpError.RootRequired({ detail: "process.list requires an explicit approved root" })
        yield* authority.authorize({ plane: "augmentation", operation: "process.list", phase: "control", rootID: input.rootID })
        yield* retryPendingArchives()
        const state = yield* config.get()
        const visible = [...jobs.values()].filter((job) => job.connectorID === state.connector.id && job.rootID === input.rootID)
        const archived = (yield* archive.list()).filter(
          (row) =>
            row.connectorID === state.connector.id &&
            row.rootID === input.rootID &&
            !jobs.has(row.handle),
        )
        // Live ownership remains hard-capped independently at MAX_HANDLES.
        // Durable terminal history is a separate bounded surface (MAX_ARCHIVES)
        // and must remain discoverable after capacity reclamation/restart.
        const processes = [
          ...visible.map(view),
          ...archived
            .sort((left, right) => right.endedAt - left.endedAt)
            .map(recoveredView),
        ]
        return { output: JSON.stringify(processes), structured: { processes } } satisfies OxpResult.CapabilityResult
      }
      if (input.action !== "start") {
        if (!input.handle) return yield* new OxpError.InvalidArgument({ detail: `process.${input.action} requires handle` })
        if (!jobs.has(input.handle)) {
          const recoveredOwned = yield* recovered(
            input.handle,
            input.action === "remove" ? "process.remove" : "process.control",
          )
          const row = recoveredOwned.row
          if (input.action === "status") {
            const status = recoveredStatusView(row)
            return { output: JSON.stringify(status), structured: status, metadata: recoveredView(row) }
          }
          if (input.action === "poll" || input.action === "wait") {
            const max = input.maxBytes ?? 64 * 1024
            const page = Utf8.window(row.output, input.offset ?? 0, max)
            const state = recoveredView(row)
            return {
              output: page.text || (input.action === "wait" ? JSON.stringify(state) : ""),
              structured: {
                ...state,
                output: page.text,
                offset: page.offset,
                nextOffset: page.nextOffset,
                retainedBytes: page.totalBytes,
                pageTruncated: page.truncated,
              },
              metadata: {
                ...state,
                offset: page.offset,
                nextOffset: page.nextOffset,
                retainedBytes: page.totalBytes,
                pageTruncated: page.truncated,
              },
            }
          }
          if (input.action === "write" || input.action === "kill") {
            return yield* new OxpError.Conflict({
              detail: "Recovered OXP process history is read-only; no live process owner exists",
            })
          }
          if (input.action === "remove") {
            yield* authority.revalidate(recoveredOwned.admission, "commit")
            yield* archive.remove(row.handle)
            return {
              output: `removed ${row.handle}`,
              mutation: { attempted: true, committed: true },
            }
          }
          return yield* new OxpError.InvalidArgument({ detail: "Unsupported OXP process action" })
        }
        const job = yield* owned(input.handle)
        if (input.action === "status") {
          if (job.endedAt !== undefined && job.archiveEnabled && !job.archiveCommitted) {
            yield* archiveTerminal(job).pipe(Effect.ignore)
          }
          const status = statusView(job)
          return { output: JSON.stringify(status), structured: status, metadata: view(job) }
        }
        if (input.action === "poll") {
          if (job.endedAt !== undefined && job.archiveEnabled && !job.archiveCommitted) {
            yield* archiveTerminal(job).pipe(Effect.ignore)
          }
          const max = input.maxBytes ?? 64 * 1024
          const page = Utf8.window(job.output, input.offset ?? 0, max)
          const state = view(job)
          return {
            output: page.text,
            structured: {
              ...state,
              output: page.text,
              offset: page.offset,
              nextOffset: page.nextOffset,
              retainedBytes: page.totalBytes,
              pageTruncated: page.truncated,
            },
            metadata: {
              ...state,
              offset: page.offset,
              nextOffset: page.nextOffset,
              retainedBytes: page.totalBytes,
              pageTruncated: page.truncated,
            },
          }
        }
        if (input.action === "write") {
          if (input.chars === undefined) return yield* new OxpError.InvalidArgument({ detail: "process.write requires chars" })
          if (Buffer.byteLength(input.chars) > MAX_COMMAND_BYTES) {
            return yield* new OxpError.InvalidArgument({ detail: "OXP process write payload exceeds 256 KiB" })
          }
          if (!job.stdinWritable) {
            return yield* new OxpError.Conflict({
              detail: "OXP process stdin is not writable for this job",
            })
          }
          if (!(yield* job.process.isRunning)) return yield* new OxpError.Conflict({ detail: "OXP process is no longer running" })
          const write = Stream.run(Stream.make(new TextEncoder().encode(input.chars)), job.process.stdin).pipe(
            Effect.mapError(() => new OxpError.Conflict({ detail: "OXP process stdin is no longer writable" })),
          )
          const cancellable = signal
            ? write.pipe(
                Effect.raceFirst(
                  AppProcess.waitForAbort(signal).pipe(
                    Effect.mapError(
                      () =>
                        new OxpError.Cancelled({
                          detail: "OXP process stdin write was cancelled; the child may have received a prefix",
                          metadata: { ambiguous: true },
                        }),
                    ),
                  ),
                ),
              )
            : write
          yield* cancellable.pipe(
            Effect.timeoutOrElse({
              duration: `${input.timeoutMs ?? 5_000} millis`,
              orElse: () =>
                Effect.fail(
                  new OxpError.Timeout({
                    detail: "OXP process stdin write timed out; the child may have received a prefix",
                    metadata: { ambiguous: true },
                  }),
                ),
            }),
          )
          return {
            output: `wrote ${Buffer.byteLength(input.chars)} bytes to ${job.handle}`,
            metadata: view(job),
            mutation: { attempted: true, committed: true },
          }
        }
        if (input.action === "wait") {
          const timeout = input.timeoutMs ?? 30_000
          const settled = settleOwned(job).pipe(Effect.asVoid, Effect.catch(() => Effect.void))
          const waited = signal
            ? settled.pipe(
                Effect.raceFirst(
                  AppProcess.waitForAbort(signal).pipe(
                    Effect.mapError(() => new OxpError.Cancelled({ detail: "OXP process wait was cancelled" })),
                  ),
                ),
              )
            : settled
          yield* waited.pipe(
            Effect.timeoutOrElse({ duration: `${timeout} millis`, orElse: () => Effect.void }),
          )
          const max = input.maxBytes ?? 64 * 1024
          const page = Utf8.window(job.output, input.offset ?? 0, max)
          const state = view(job)
          return {
            output: page.text || JSON.stringify(state),
            structured: {
              ...state,
              output: page.text,
              offset: page.offset,
              nextOffset: page.nextOffset,
              retainedBytes: page.totalBytes,
              pageTruncated: page.truncated,
            },
            metadata: {
              ...state,
              offset: page.offset,
              nextOffset: page.nextOffset,
              retainedBytes: page.totalBytes,
              pageTruncated: page.truncated,
            },
          }
        }
        if (input.action === "kill") {
          const admission = yield* authority.authorize({
            plane: "augmentation",
            operation: "process.kill",
            phase: "control",
            rootID: job.rootID,
          })
          yield* authority.revalidate(admission, "commit")
          yield* retire(job, "requested-kill")
          job.endedAt ??= Date.now()
          return { output: JSON.stringify(view(job)), structured: view(job), mutation: { attempted: true, committed: true } }
        }
        if (input.action === "remove") {
          if (job.endedAt === undefined) return yield* new OxpError.Conflict({ detail: "Kill or wait for the OXP process before removing its handle" })
          const admission = yield* authority.authorize({
            plane: "augmentation",
            operation: "process.remove",
            phase: "control",
            rootID: job.rootID,
          })
          yield* authority.revalidate(admission, "commit")
          yield* disableArchiveAndRemove(job)
          jobs.delete(job.handle)
          yield* Scope.close(job.scope, Exit.void).pipe(Effect.ignore)
          return { output: `removed ${job.handle}`, mutation: { attempted: true, committed: true } }
        }
        return yield* new OxpError.InvalidArgument({ detail: "Unsupported OXP process action" })
      }

      const mode = input.mode ?? "foreground"
      const title = "argv" in input ? input.argv.join(" ") : input.command
      const spawned =
        "argv" in input
          ? yield* startArgv(
              {
                rootID: input.rootID,
                workdir: input.workdir,
                argv: input.argv as [string, ...string[]],
                title,
                operation: "process.start",
                mode,
                archive: true,
              },
              signal,
            )
          : yield* Effect.gen(function* () {
              if (Buffer.byteLength(input.command) > MAX_COMMAND_BYTES) {
                return yield* new OxpError.InvalidArgument({ detail: "OXP process command exceeds 256 KiB" })
              }
              const shell =
                input.shell ?? (process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : process.env.SHELL ?? "/bin/sh")
              const env = OxpProcessEnvironment.childEnvironment(process.env)
              return yield* spawnOwned({
                rootID: input.rootID,
                workdir: input.workdir,
                title,
                operation: "process.start",
                mode,
                shell,
                stdinWritable: true,
                archive: true,
                signal,
                command: (canonicalWorkdir) =>
                  ShellLaunch.command(
                    shell,
                    input.command,
                    canonicalWorkdir,
                    env,
                    { stream: "pipe", endOnDone: false },
                    { forceKillAfter: "3 seconds" },
                  ),
              })
            })
      const handle = spawned.handle
      const job = jobs.get(handle)!

      if (job.mode === "foreground") {
        const yieldMs = input.yieldMs ?? 10_000
        const settled = settleOwned(job).pipe(Effect.asVoid, Effect.catch(() => Effect.void))
        const waited = signal
          ? settled.pipe(
              Effect.raceFirst(
                AppProcess.waitForAbort(signal).pipe(
                  Effect.mapError(() => new OxpError.Cancelled({ detail: "OXP foreground process request was cancelled" })),
                ),
              ),
            )
          : settled
        yield* waited.pipe(
          Effect.timeoutOrElse({ duration: `${yieldMs} millis`, orElse: () => Effect.void }),
          Effect.catch((error) =>
            OxpError.isError(error) && error._tag === "OXP_CANCELLED"
              ? retire(job, "request-cancelled").pipe(
                  Effect.andThen(
                    Effect.fail(
                      new OxpError.Cancelled({
                        detail: error.detail,
                        metadata: {
                          ...(error.metadata ?? {}),
                          committed: true,
                          handle,
                        },
                      }),
                    ),
                  ),
                )
              : Effect.fail(error),
          ),
        )
      }
      const state = view(job)
      return {
        title,
        output: job.endedAt === undefined ? `process running: ${handle}` : (job.output || "(no output)"),
        structured: {
          ...state,
          ...(job.endedAt === undefined ? {} : { output: job.output }),
        },
        metadata: state,
        mutation: { attempted: true, committed: true },
      } satisfies OxpResult.CapabilityResult
    })

    const execute: Interface["execute"] = (input, signal) =>
      Effect.try({
        try: () => normalizeTransport(input),
        catch: (cause) =>
          OxpError.isError(cause)
            ? cause
            : new OxpError.InvalidArgument({
                detail: "Invalid OXP process arguments",
              }),
      }).pipe(
        Effect.flatMap(({ runtime, ignored }) =>
          Schema.decodeUnknownEffect(RuntimeParameters)(runtime, {
            onExcessProperty: "error",
          }).pipe(
            Effect.mapError(
              () =>
                new OxpError.InvalidArgument({
                  detail: "Invalid canonical OXP process arguments",
                }),
            ),
            Effect.flatMap((canonical) => executeRaw(canonical, signal)),
            Effect.map((result) =>
              ignored.length === 0
                ? result
                : {
                    ...result,
                    metadata: {
                      ...result.metadata,
                      transportIgnored: ignored,
                    },
                  },
            ),
          ),
        ),
        Effect.catch((error) =>
          OxpError.isError(error)
            ? Effect.fail(error)
            : Effect.fail(
                new OxpError.DependencyUnavailable({
                  detail: "OXP process operation failed",
                }),
              ),
        ),
      )

    const stateFrom = (result: OxpResult.CapabilityResult): ExchangeOwnedCommand.State => {
      const value = (result.structured ?? result.metadata) as
        | { running?: boolean; exitCode?: number; truncated?: boolean }
        | undefined
      return {
        running: value?.running === true,
        ...(value?.exitCode === undefined ? {} : { exitCode: value.exitCode }),
        ...(value?.truncated === undefined ? {} : { truncated: value.truncated }),
      }
    }

    const runArgv: Interface["runArgv"] = (input, signal) =>
      ExchangeOwnedCommand.run<OxpError.Error>(
        {
          start: (request) =>
            startArgv(
              {
                rootID: input.rootID,
                workdir: request.workdir,
                argv: request.argv,
                env: request.env,
                title: request.title,
                operation: request.operation,
                mode: "background",
                onStdout: request.onStdout,
                onStderr: request.onStderr,
              },
              signal,
            ).pipe(Effect.map(({ handle }) => ({ handle }))),
          wait: (handle, timeoutMs, waitSignal) =>
            execute({ action: "wait", handle, timeoutMs }, waitSignal).pipe(Effect.map(stateFrom)),
          kill: (handle) => execute({ action: "kill", handle }).pipe(Effect.map(stateFrom)),
          remove: (handle) => execute({ action: "remove", handle }).pipe(Effect.asVoid),
        },
        {
          argv: input.argv,
          workdir: input.workdir,
          env: input.env,
          title: input.title,
          operation: input.operation,
          timeoutMs: input.timeoutMs,
          outputCapBytes: input.outputCapBytes,
          signal,
        },
      )

    return Service.of({ execute, startArgv, runArgv })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [
    OxpAuthority.node,
    OxpConfig.node,
    OxpRoot.node,
    OxpProcessArchive.node,
    AppProcess.node,
    FSUtil.node,
  ],
})
export * as OxpProcess from "./process"
