import { randomUUID } from "node:crypto"
import { Context, Effect, Exit, Layer, Schema, Scope, Stream } from "effect"
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
import { OxpProcessEnvironment } from "./process-environment"
import { OxpError } from "./error"
import { OxpResult } from "./result"
import { OxpSchema } from "./schema"

const MAX_COMMAND_BYTES = 256 * 1024
const MAX_OUTPUT_BYTES = 256 * 1024
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
 * Action-specific schemas keep irrelevant fields out of the model contract.
 * start.argv is the preferred path for executable + arguments because it avoids
 * fragile nested shell/JSON quoting; command remains for actual shell syntax.
 */
export const Parameters = Schema.Union([StartArgv, StartShell, List, Status, Poll, Write, Wait, Kill, Remove])
export type Input = Schema.Schema.Type<typeof Parameters>

type Job = {
  readonly handle: string
  readonly connectorID: string
  readonly rootID: OxpSchema.RootID
  readonly rootPath: string
  readonly workdir: string
  readonly command: string
  readonly shell: string
  readonly mode: "foreground" | "background"
  readonly startedAt: number
  readonly process: ChildProcessHandle
  readonly scope: Scope.Closeable
  readonly outputDrained: Promise<void>
  output: string
  outputBytes: number
  truncated: boolean
  exitCode?: number
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

function cancelled(signal?: AbortSignal) {
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

const settle = (job: Job) =>
  job.process.exitCode.pipe(
    Effect.flatMap((code) =>
      Effect.promise(() => job.outputDrained).pipe(
        Effect.andThen(
          Effect.sync(() => {
            job.exitCode = code
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
    const app = yield* AppProcess.Service
    const fs = yield* FSUtil.Service
    const jobs = new Map<string, Job>()

    const retire = Effect.fnUntraced(function* (job: Job) {
      if (yield* job.process.isRunning) {
        yield* job.process.kill({ forceKillAfter: "3 seconds" }).pipe(
          Effect.mapError(() => new OxpError.DependencyUnavailable({ detail: "Unable to prove OXP process tree retirement" })),
        )
      }
      yield* Scope.close(job.scope, Exit.void).pipe(Effect.ignore)
    })

    const reapSettledForCapacity = Effect.fnUntraced(function* () {
      if (jobs.size < MAX_HANDLES) return
      // A child may have exited before the detached settle fiber gets CPU time.
      // Under pressure, reconcile those handles once before declaring Busy so a
      // registry full of already-dead children heals itself instead of wedging.
      for (const job of jobs.values()) {
        if (job.endedAt !== undefined) continue
        if (!(yield* job.process.isRunning)) {
          yield* settle(job).pipe(Effect.ignore)
        }
      }
      const settled = [...jobs.values()]
        .filter((job) => job.endedAt !== undefined)
        .sort((left, right) => (left.endedAt ?? 0) - (right.endedAt ?? 0))
      for (const job of settled) {
        jobs.delete(job.handle)
        yield* Scope.close(job.scope, Exit.void).pipe(Effect.ignore)
        if (jobs.size < MAX_HANDLES) break
      }
    })

    yield* Effect.addFinalizer(() => Effect.forEach([...jobs.values()], (job) => retire(job).pipe(Effect.ignore), { discard: true }))

    // Revocation is active, not merely an admission rule. Process authority or
    // root removal retires the trees this connector owns without a Session/PID
    // becoming the authorization token.
    const unsubscribe = yield* config.subscribe((next) => {
      for (const job of jobs.values()) {
        const validRoot = next.roots.some((root) => root.id === job.rootID)
        if (!next.enabled || !next.grant.process || next.connector.id !== job.connectorID || !validRoot) {
          void Effect.runPromise(
            retire(job).pipe(
              Effect.andThen(Effect.sync(() => jobs.delete(job.handle))),
              // Fail closed: a tree that could not be proven stopped remains
              // owned in the registry for shutdown/recovery rather than becoming
              // an orphan merely because authority was revoked.
              Effect.catch(() => Effect.void),
            ),
          )
        }
      }
    })
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))

    const owned = Effect.fnUntraced(function* (handle: string) {
      const job = jobs.get(handle)
      if (!job) return yield* new OxpError.HandleStale({ detail: "Unknown or retired OXP process handle" })
      const state = yield* config.get()
      if (state.connector.id !== job.connectorID) return yield* new OxpError.HandleStale({ detail: "OXP process handle belongs to another connector generation" })
      yield* authority.authorize({ plane: "augmentation", operation: "process.control", phase: "control", rootID: job.rootID })
      return job
    })

    const view = (job: Job) => ({
      handle: job.handle,
      rootID: job.rootID,
      workdir: job.workdir.slice(job.rootPath.length).replaceAll("\\", "/") || ".",
      mode: job.mode,
      running: job.endedAt === undefined,
      startedAt: job.startedAt,
      ...(job.endedAt === undefined ? {} : { endedAt: job.endedAt, exitCode: job.exitCode }),
      outputBytes: job.outputBytes,
      truncated: job.truncated,
    })

    const spawnOwned = Effect.fn("OxpProcess.spawnOwned")(function* (input: {
      readonly rootID: OxpSchema.RootID
      readonly workdir?: string
      readonly title: string
      readonly operation: string
      readonly mode: "foreground" | "background"
      readonly shell: string
      readonly command: (canonicalWorkdir: string) => Command
      readonly onChunk?: (chunk: string) => void
      readonly onStdout?: (chunk: string) => void
      readonly onStderr?: (chunk: string) => void
    }) {
      yield* reapSettledForCapacity()
      if (jobs.size >= MAX_HANDLES) return yield* new OxpError.Busy({ detail: "OXP process handle limit reached" })
      const admission = yield* authority.authorize({
        plane: "augmentation",
        operation: input.operation,
        phase: "spawn",
        rootID: input.rootID,
      })
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
      const stat = yield* fs.stat(canonicalWorkdir).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!stat?.type || stat.type !== "Directory") {
        return yield* new OxpError.InvalidArgument({ detail: "OXP process workdir must be an existing directory" })
      }
      yield* authority.revalidate(admission, "spawn")
      const state = yield* config.get()
      const scope = yield* Scope.make()
      let resolveOutputDrained!: () => void
      const outputDrained = new Promise<void>((resolve) => {
        resolveOutputDrained = resolve
      })
      const processHandle = yield* app.spawn(input.command(canonicalWorkdir)).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.mapError(() => new OxpError.DependencyUnavailable({ detail: "Unable to spawn OXP process" })),
      )
      const handle = `proc_${randomUUID().replaceAll("-", "")}`
      const job: Job = {
        handle,
        connectorID: state.connector.id,
        rootID: input.rootID,
        rootPath: admission.root.canonicalPath,
        workdir: canonicalWorkdir,
        command: input.title,
        shell: input.shell,
        mode: input.mode,
        startedAt: Date.now(),
        process: processHandle,
        scope,
        outputDrained,
        output: "",
        outputBytes: 0,
        truncated: false,
      }
      jobs.set(handle, job)
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
        // Stream capture is observational. A platform pipe-close must not widen
        // the public OXP error channel or orphan an otherwise-owned process.
        Effect.catch(() => Effect.void),
        Effect.ensuring(Effect.sync(resolveOutputDrained)),
        Effect.forkIn(scope, { startImmediately: true }),
      )
      // Attach output capture before the second authority check. Extremely
      // short-lived Windows children can emit and exit while revalidation is
      // still doing filesystem/root work; delaying the capture fiber until
      // after that check creates an avoidable pipe-observation race.
      //
      // This does not weaken authority: the child is still not returned to the
      // caller until revalidation succeeds, and a failed check immediately
      // retires the owned tree and its capture scope.
      yield* authority.revalidate(admission, "spawn").pipe(
        Effect.catch((error) =>
          retire(job).pipe(
            Effect.andThen(Effect.sync(() => jobs.delete(handle))),
            Effect.andThen(Effect.fail(error)),
          ),
        ),
      )
      // A process is not settled until both its exit status and its output pipes
      // are drained. Otherwise wait/status can race the final stdout chunk.
      yield* settle(job).pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
      return { handle, process: processHandle } as const
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
        command: (canonicalWorkdir) =>
          ChildProcess.make(bin, args, {
            cwd: canonicalWorkdir,
            env: OxpProcessEnvironment.childEnvironment(input.env ?? process.env),
            stdin: "ignore",
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

    const executeRaw = Effect.fn("OxpProcess.execute")(function* (input: Input, signal?: AbortSignal) {
      yield* cancelled(signal)
      if (input.action === "list") {
        if (!input.rootID) return yield* new OxpError.RootRequired({ detail: "process.list requires an explicit approved root" })
        yield* authority.authorize({ plane: "augmentation", operation: "process.list", phase: "control", rootID: input.rootID })
        const state = yield* config.get()
        const visible = [...jobs.values()].filter((job) => job.connectorID === state.connector.id && job.rootID === input.rootID)
        return { output: JSON.stringify(visible.map(view)), structured: { processes: visible.map(view) } } satisfies OxpResult.CapabilityResult
      }
      if (input.action !== "start") {
        if (!input.handle) return yield* new OxpError.InvalidArgument({ detail: `process.${input.action} requires handle` })
        const job = yield* owned(input.handle)
        if (input.action === "status") return { output: JSON.stringify(view(job)), structured: view(job) }
        if (input.action === "poll") {
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
          if (!(yield* job.process.isRunning)) return yield* new OxpError.Conflict({ detail: "OXP process is no longer running" })
          yield* Stream.run(Stream.make(new TextEncoder().encode(input.chars)), job.process.stdin).pipe(
            Effect.mapError(() => new OxpError.Conflict({ detail: "OXP process stdin is no longer writable" })),
          )
          return {
            output: `wrote ${Buffer.byteLength(input.chars)} bytes to ${job.handle}`,
            metadata: view(job),
            mutation: { attempted: true, committed: true },
          }
        }
        if (input.action === "wait") {
          const timeout = input.timeoutMs ?? 30_000
          const settled = settle(job).pipe(Effect.asVoid, Effect.catch(() => Effect.void))
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
          yield* authority.authorize({ plane: "augmentation", operation: "process.kill", phase: "control", rootID: job.rootID })
          yield* retire(job)
          job.endedAt ??= Date.now()
          return { output: JSON.stringify(view(job)), structured: view(job), mutation: { attempted: true, committed: true } }
        }
        if (input.action === "remove") {
          if (job.endedAt === undefined) return yield* new OxpError.Conflict({ detail: "Kill or wait for the OXP process before removing its handle" })
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
        const settled = settle(job).pipe(Effect.asVoid, Effect.catch(() => Effect.void))
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
              ? retire(job).pipe(
                  Effect.andThen(Effect.sync(() => jobs.delete(handle))),
                  Effect.andThen(Effect.fail(error)),
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

    const execute: Interface["execute"] = (input, signal) => executeRaw(input, signal).pipe(
      Effect.catch((error) => OxpError.isError(error)
        ? Effect.fail(error)
        : Effect.fail(new OxpError.DependencyUnavailable({ detail: "OXP process operation failed" }))),
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

export const node = makeGlobalNode({ service: Service, layer, deps: [OxpAuthority.node, OxpConfig.node, AppProcess.node, FSUtil.node] })
export * as OxpProcess from "./process"
