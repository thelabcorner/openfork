export * as ExchangeProcess from "./process"

import path from "node:path"
import { Context, Effect, Exit, Layer, Schema, Scope, Stream } from "effect"
import type { Command } from "effect/unstable/process/ChildProcess"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import { AppProcess } from "@opencode-ai/core/process"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import * as Utf8 from "@/util/utf8"
import { ExchangeError } from "./error"

export const MAX_COMMAND_BYTES = 256 * 1024
export const MAX_OUTPUT_BYTES = 256 * 1024
export const MAX_HANDLES = 128
export const MAX_HANDLES_PER_OWNER = 32

export const Handle = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(80),
  Schema.isPattern(/^proc_[A-Za-z0-9_-]+$/),
)
export type Handle = typeof Handle.Type

export const Parameters = Schema.Struct({
  action: Schema.Literals(["start", "poll", "write", "list", "status", "wait", "kill", "remove"]),
  workdir: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
  command: Schema.optional(Schema.String.check(Schema.isMaxLength(MAX_COMMAND_BYTES))),
  mode: Schema.optional(Schema.Literals(["foreground", "background"])),
  shell: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
  yieldMs: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30_000 }))),
  timeoutMs: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 3_600_000 }))),
  handle: Schema.optional(Handle),
  chars: Schema.optional(Schema.String.check(Schema.isMaxLength(256 * 1024))),
  offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  maxBytes: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_OUTPUT_BYTES }))),
})
export type Input = Schema.Schema.Type<typeof Parameters>

type Job = {
  readonly handle: Handle
  readonly ownerKey: string
  readonly rootKey: string
  readonly generation: number
  readonly rootPath: string
  readonly workdir: string
  readonly title: string
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

export interface View {
  readonly handle: Handle
  readonly rootKey: string
  readonly workdir: string
  readonly mode: "foreground" | "background"
  readonly running: boolean
  readonly startedAt: number
  readonly endedAt?: number
  readonly exitCode?: number
  readonly outputBytes: number
  readonly truncated: boolean
}

export interface Descriptor {
  readonly handle: Handle
  readonly ownerKey: string
  readonly rootKey: string
  readonly generation: number
  readonly running: boolean
}

export interface StartInput {
  readonly handle: Handle
  readonly ownerKey: string
  readonly rootKey: string
  readonly generation: number
  readonly rootPath: string
  readonly workdir: string
  readonly title: string
  readonly shell: string
  readonly mode: "foreground" | "background"
  readonly command: Command
  readonly revalidate: () => Effect.Effect<void, ExchangeError.Error>
  /** Internal diagnostics observers for specialized capability runners. */
  readonly onChunk?: (chunk: string) => void
  readonly onStdout?: (chunk: string) => void
  readonly onStderr?: (chunk: string) => void
}

export interface Interface {
  readonly start: (input: StartInput) => Effect.Effect<View, ExchangeError.Error>
  readonly descriptor: (ownerKey: string, handle: Handle) => Effect.Effect<Descriptor | undefined>
  readonly list: (ownerKey: string, rootKey: string, generation?: number) => Effect.Effect<readonly View[]>
  readonly status: (ownerKey: string, handle: Handle) => Effect.Effect<View, ExchangeError.Error>
  readonly poll: (
    ownerKey: string,
    handle: Handle,
    offset?: number,
    maxBytes?: number,
  ) => Effect.Effect<{ readonly output: string; readonly metadata: Readonly<Record<string, unknown>> }, ExchangeError.Error>
  readonly write: (ownerKey: string, handle: Handle, chars: string) => Effect.Effect<View, ExchangeError.Error>
  readonly wait: (ownerKey: string, handle: Handle, timeoutMs: number, signal?: AbortSignal) => Effect.Effect<View, ExchangeError.Error>
  readonly kill: (ownerKey: string, handle: Handle) => Effect.Effect<View, ExchangeError.Error>
  readonly remove: (ownerKey: string, handle: Handle) => Effect.Effect<boolean, ExchangeError.Error>
  readonly retire: (ownerKey: string, handle: Handle) => Effect.Effect<boolean, ExchangeError.Error>
  readonly retireWhere: (predicate: (job: Descriptor) => boolean) => Effect.Effect<number, ExchangeError.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ExchangeProcess") {}
export const use = serviceUse(Service)

function append(job: Job, chunk: string) {
  job.outputBytes += Utf8.byteLength(chunk)
  const retained = Utf8.byteLength(job.output)
  if (retained >= MAX_OUTPUT_BYTES) {
    job.truncated = true
    return
  }
  const next = Utf8.truncate(chunk, MAX_OUTPUT_BYTES - retained)
  job.output += next.text
  if (next.truncated) job.truncated = true
}

function view(job: Job): View {
  const relative = path.relative(job.rootPath, job.workdir).replaceAll("\\", "/") || "."
  return {
    handle: job.handle,
    rootKey: job.rootKey,
    workdir: relative,
    mode: job.mode,
    running: job.endedAt === undefined,
    startedAt: job.startedAt,
    ...(job.endedAt === undefined ? {} : { endedAt: job.endedAt, exitCode: job.exitCode }),
    outputBytes: job.outputBytes,
    truncated: job.truncated,
  }
}

function descriptor(job: Job): Descriptor {
  return {
    handle: job.handle,
    ownerKey: job.ownerKey,
    rootKey: job.rootKey,
    generation: job.generation,
    running: job.endedAt === undefined,
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const app = yield* AppProcess.Service
    const jobs = new Map<Handle, Job>()

    const owned = Effect.fnUntraced(function* (ownerKey: string, handle: Handle) {
      const job = jobs.get(handle)
      if (!job || job.ownerKey !== ownerKey) {
        return yield* new ExchangeError.NotFound({ detail: "Unknown or stale process handle" })
      }
      return job
    })

    const running = (job: Job) =>
      job.process.isRunning.pipe(
        Effect.mapError(() => new ExchangeError.DependencyUnavailable({ detail: "Unable to inspect process state" })),
      )

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

    const retireJob = Effect.fnUntraced(function* (job: Job) {
      if (yield* running(job)) {
        yield* job.process.kill({ forceKillAfter: "3 seconds" }).pipe(
          Effect.mapError(() => new ExchangeError.DependencyUnavailable({ detail: "Unable to prove process-tree retirement" })),
        )
      }
      job.endedAt ??= Date.now()
      yield* Scope.close(job.scope, Exit.void).pipe(Effect.ignore)
    })

    yield* Effect.addFinalizer(() =>
      Effect.forEach([...jobs.values()], (job) => retireJob(job).pipe(Effect.ignore), { discard: true }),
    )

    const start: Interface["start"] = Effect.fn("ExchangeProcess.start")(function* (input) {
      if (jobs.size >= MAX_HANDLES) return yield* new ExchangeError.Conflict({ detail: "Process handle limit reached" })
      let ownerCount = 0
      for (const job of jobs.values()) if (job.ownerKey === input.ownerKey) ownerCount++
      if (ownerCount >= MAX_HANDLES_PER_OWNER) {
        return yield* new ExchangeError.Conflict({ detail: "Process handle limit reached for this external principal" })
      }
      if (jobs.has(input.handle)) return yield* new ExchangeError.Conflict({ detail: "Process handle already exists" })
      yield* input.revalidate()

      const scope = yield* Scope.make()
      const processHandle = yield* app.spawn(input.command).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.mapError(() => new ExchangeError.DependencyUnavailable({ detail: "Unable to spawn process" })),
      )
      let resolveOutputDrained!: () => void
      const outputDrained = new Promise<void>((resolve) => {
        resolveOutputDrained = resolve
      })
      const job: Job = {
        handle: input.handle,
        ownerKey: input.ownerKey,
        rootKey: input.rootKey,
        generation: input.generation,
        rootPath: input.rootPath,
        workdir: input.workdir,
        title: input.title,
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
      jobs.set(input.handle, job)

      const observe = (kind: "stdout" | "stderr", chunk: string) =>
        Effect.sync(() => {
          append(job, chunk)
          try {
            input.onChunk?.(chunk)
            if (kind === "stdout") input.onStdout?.(chunk)
            else input.onStderr?.(chunk)
          } catch {
            // Observers are diagnostics-only and never own process lifetime.
          }
        })
      const capture = input.onStdout || input.onStderr
        ? Effect.all(
          [
            Stream.runForEach(Stream.decodeText(processHandle.stdout), (chunk) => observe("stdout", chunk)),
            Stream.runForEach(Stream.decodeText(processHandle.stderr), (chunk) => observe("stderr", chunk)),
          ],
          { concurrency: "unbounded", discard: true },
        )
        : Stream.runForEach(Stream.decodeText(processHandle.all), (chunk) => observe("stdout", chunk))
      yield* capture.pipe(
        Effect.catch(() => Effect.void),
        Effect.ensuring(Effect.sync(resolveOutputDrained)),
        Effect.forkIn(scope, { startImmediately: true }),
      )
      yield* settle(job).pipe(
        Effect.ignore,
        Effect.forkIn(scope, { startImmediately: true }),
      )

      // Attach output consumers immediately after spawn. OFXP revalidation can
      // cross storage/authority boundaries and a very short child may exit
      // while that check is in flight; delaying capture until afterwards can
      // lose already-closed pipe data. Authority is still revalidated before
      // the handle is returned, and failure retires the owned process tree.
      yield* input.revalidate().pipe(
        Effect.catch((error) =>
          retireJob(job).pipe(
            Effect.andThen(Effect.sync(() => jobs.delete(input.handle))),
            Effect.andThen(Effect.fail(error)),
            Effect.catch(() =>
              Effect.fail(
                new ExchangeError.AmbiguousCommit({
                  detail: "Process spawned but process-tree retirement after authority change could not be proven",
                  targetRef: input.handle,
                }),
              ),
            ),
          ),
        ),
      )
      return view(job)
    })

    const descriptorOf: Interface["descriptor"] = (ownerKey, handle) =>
      Effect.sync(() => {
        const job = jobs.get(handle)
        return job && job.ownerKey === ownerKey ? descriptor(job) : undefined
      })

    const list: Interface["list"] = (ownerKey, rootKey, generation) =>
      Effect.sync(() =>
        [...jobs.values()]
          .filter(
            (job) =>
              job.ownerKey === ownerKey &&
              job.rootKey === rootKey &&
              (generation === undefined || job.generation === generation),
          )
          .map(view),
      )

    const status: Interface["status"] = (ownerKey, handle) => Effect.map(owned(ownerKey, handle), view)

    const poll: Interface["poll"] = Effect.fn("ExchangeProcess.poll")(function* (ownerKey, handle, offset = 0, maxBytes = 64 * 1024) {
      const job = yield* owned(ownerKey, handle)
      const page = Utf8.window(job.output, offset, maxBytes)
      return {
        output: page.text,
        metadata: {
          ...view(job),
          offset: page.offset,
          nextOffset: page.nextOffset,
          retainedBytes: page.totalBytes,
          pageTruncated: page.truncated,
        },
      }
    })

    const write: Interface["write"] = Effect.fn("ExchangeProcess.write")(function* (ownerKey, handle, chars) {
      const job = yield* owned(ownerKey, handle)
      if (!(yield* running(job))) return yield* new ExchangeError.Conflict({ detail: "Process is no longer running" })
      yield* Stream.run(Stream.make(new TextEncoder().encode(chars)), job.process.stdin).pipe(
        Effect.mapError(() => new ExchangeError.Conflict({ detail: "Process stdin is no longer writable" })),
      )
      return view(job)
    })

    const wait: Interface["wait"] = Effect.fn("ExchangeProcess.wait")(function* (ownerKey, handle, timeoutMs, signal) {
      const job = yield* owned(ownerKey, handle)
      const exited = settle(job).pipe(Effect.asVoid, Effect.catch(() => Effect.void))
      const waited = signal
        ? exited.pipe(
            Effect.raceFirst(
              AppProcess.waitForAbort(signal).pipe(
                Effect.mapError(() => new ExchangeError.Cancelled({ detail: "Process wait was cancelled" })),
              ),
            ),
          )
        : exited
      yield* waited.pipe(Effect.timeoutOrElse({ duration: `${timeoutMs} millis`, orElse: () => Effect.void }))
      return view(job)
    })

    const kill: Interface["kill"] = Effect.fn("ExchangeProcess.kill")(function* (ownerKey, handle) {
      const job = yield* owned(ownerKey, handle)
      yield* retireJob(job)
      return view(job)
    })

    const remove: Interface["remove"] = Effect.fn("ExchangeProcess.remove")(function* (ownerKey, handle) {
      const job = jobs.get(handle)
      if (!job || job.ownerKey !== ownerKey) return false
      if (job.endedAt === undefined && (yield* running(job))) {
        return yield* new ExchangeError.Conflict({ detail: "Kill or wait for the process before removing its handle" })
      }
      jobs.delete(handle)
      yield* Scope.close(job.scope, Exit.void).pipe(Effect.ignore)
      return true
    })

    const retire: Interface["retire"] = Effect.fn("ExchangeProcess.retire")(function* (ownerKey, handle) {
      const job = jobs.get(handle)
      if (!job || job.ownerKey !== ownerKey) return false
      yield* retireJob(job)
      jobs.delete(handle)
      return true
    })

    const retireWhere: Interface["retireWhere"] = Effect.fn("ExchangeProcess.retireWhere")(function* (predicate) {
      const selected = [...jobs.values()].filter((job) => predicate(descriptor(job)))
      for (const job of selected) {
        yield* retireJob(job)
        jobs.delete(job.handle)
      }
      return selected.length
    })

    return Service.of({ start, descriptor: descriptorOf, list, status, poll, write, wait, kill, remove, retire, retireWhere })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [AppProcess.node] })

