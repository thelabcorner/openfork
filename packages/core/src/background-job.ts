export * as BackgroundJob from "./background-job"

import { Cause, Clock, Context, Deferred, Effect, Exit, Layer, Scope, SynchronizedRef } from "effect"
import { Identifier } from "./id/id"
import { makeGlobalNode } from "./effect/app-node"

export type Status = "running" | "completed" | "error" | "cancelled"

export type Info = {
  id: string
  type: string
  title?: string
  status: Status
  generation?: number
  started_at: number
  completed_at?: number
  output?: string
  error?: string
  metadata?: Record<string, unknown>
}

type Active = {
  info: Info
  done: Deferred.Deferred<Info>
  scope: Scope.Closeable
  token: object
  pending: number
  next: number
  output?: { sequence: number; text: string }
  failure?: { sequence: number; text: string }
  tail: Deferred.Deferred<void>
  promoted: Deferred.Deferred<Info>
  onPromote?: Effect.Effect<void>
  continueOnFailure: boolean
}

type OwnedHandle = {
  readonly id: string
  readonly generation: number
  readonly sessionID?: string
  readonly parentSessionID?: string
  readonly admissionEpoch: bigint
  background: boolean
  readonly cancel: Effect.Effect<Info | undefined>
}

// An index of live job cancellation handles only. Unlike each instance's
// retained status map, this process-level registry contains no completed jobs
// and lets Tier 0/1 session control cancel work without booting an Instance.
const ownedHandles = new Map<string, Set<OwnedHandle>>()
const cancellationFences = new Map<string, Map<bigint, number>>()
let admissionEpoch = 0n

function retainCancellationFence(key: string, epoch: bigint) {
  let fences = cancellationFences.get(key)
  if (!fences) cancellationFences.set(key, (fences = new Map()))
  fences.set(epoch, (fences.get(epoch) ?? 0) + 1)
}

function releaseCancellationFence(key: string, epoch: bigint) {
  const fences = cancellationFences.get(key)
  if (!fences) return
  const count = fences.get(epoch) ?? 0
  if (count <= 1) fences.delete(epoch)
  else fences.set(epoch, count - 1)
  if (fences.size === 0) cancellationFences.delete(key)
}

function oldestCancellationFence(keys: Iterable<string | undefined>) {
  let oldest: bigint | undefined
  for (const key of keys) {
    if (!key) continue
    for (const epoch of cancellationFences.get(key)?.keys() ?? []) {
      if (oldest === undefined || epoch < oldest) oldest = epoch
    }
  }
  return oldest
}

function ownerKeys(handle: OwnedHandle) {
  return new Set([handle.id, handle.sessionID, handle.parentSessionID].filter((key): key is string => !!key))
}

function registerOwned(handle: OwnedHandle) {
  for (const key of ownerKeys(handle)) {
    let entries = ownedHandles.get(key)
    if (!entries) ownedHandles.set(key, (entries = new Set()))
    entries.add(handle)
  }
}

function unregisterOwned(handle: OwnedHandle) {
  for (const key of ownerKeys(handle)) {
    const entries = ownedHandles.get(key)
    entries?.delete(handle)
    if (entries?.size === 0) ownedHandles.delete(key)
  }
}

/** Cancel the live jobs owned by a session without loading an Instance. */
export const cancelOwnedBySession = Effect.fn("BackgroundJob.cancelOwnedBySession")(function* (
  sessionID: string,
  afterCancel: Effect.Effect<void> = Effect.void,
) {
  return yield* Effect.uninterruptible(
    Effect.gen(function* () {
      const cancelled = new Set<OwnedHandle>()
      const fence = ++admissionEpoch
      const fenced = new Set<string>([sessionID])
      for (const key of fenced) retainCancellationFence(key, fence)
      try {
        const drain = Effect.fn("BackgroundJob.cancelOwnedBySession.drain")(function* () {
          const pending = new Set([sessionID])
          while (pending.size > 0) {
            const key = pending.values().next().value as string
            pending.delete(key)
            const candidates = [...(ownedHandles.get(key) ?? [])]
            for (const handle of candidates) {
              if (cancelled.has(handle) || handle.admissionEpoch >= fence) continue
              const direct = handle.id === sessionID || handle.sessionID === sessionID
              if (!direct && handle.background) continue
              cancelled.add(handle)
              for (const childKey of [handle.id, handle.sessionID]) {
                if (!childKey || fenced.has(childKey)) continue
                fenced.add(childKey)
                retainCancellationFence(childKey, fence)
              }
              yield* handle.cancel
              pending.add(handle.id)
              if (handle.sessionID) pending.add(handle.sessionID)
            }
          }
        })
        yield* drain()
        yield* afterCancel
        yield* drain()
      } finally {
        for (const key of fenced) releaseCancellationFence(key, fence)
      }
    }),
  )
})

type State = {
  // The Map is private to this owner. Access it only inside SynchronizedRef
  // operations and mutate it there; copying it on every progress update made
  // one job completion cost O(all retained jobs).
  jobs: SynchronizedRef.SynchronizedRef<Map<string, Active>>
  scope: Scope.Scope
}

type FinishResult = {
  info?: Info
  done?: Deferred.Deferred<Info>
  scope?: Scope.Closeable
}

type PromoteResult = {
  info?: Info
  promoted?: Deferred.Deferred<Info>
  onPromote?: Effect.Effect<void>
}

type StartResult = { info: Info } | { info: Info; scope: Scope.Closeable; token: object }
const ownedByToken = new WeakMap<object, OwnedHandle>()

type ExtendResult =
  | { extended: false }
  | {
      extended: true
      previous: Deferred.Deferred<void>
      scope: Scope.Closeable
      tail: Deferred.Deferred<void>
      token: object
      sequence: number
    }

export type StartInput = {
  id?: string
  type: string
  title?: string
  metadata?: Record<string, unknown>
  onPromote?: Effect.Effect<void>
  continueOnFailure?: boolean
  run: Effect.Effect<string, unknown>
}

export type ExtendInput = {
  id: string
  run: Effect.Effect<string, unknown>
}

export type WaitInput = {
  id: string
  timeout?: number
}

export type WaitResult = {
  info?: Info
  timedOut: boolean
}

export interface Interface {
  readonly list: () => Effect.Effect<Info[]>
  readonly get: (id: string) => Effect.Effect<Info | undefined>
  readonly start: (input: StartInput) => Effect.Effect<Info>
  readonly tryStart: (input: StartInput) => Effect.Effect<{ info: Info; started: boolean }>
  readonly extend: (input: ExtendInput) => Effect.Effect<boolean>
  readonly wait: (input: WaitInput) => Effect.Effect<WaitResult>
  readonly waitForPromotion: (id: string) => Effect.Effect<Info>
  readonly promote: (id: string) => Effect.Effect<Info | undefined>
  readonly foreground: (id: string, onPromote?: Effect.Effect<void>) => Effect.Effect<Info | undefined>
  readonly cancel: (id: string) => Effect.Effect<Info | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/BackgroundJob") {}

function snapshot(job: Active): Info {
  return {
    ...job.info,
    ...(job.info.metadata ? { metadata: { ...job.info.metadata } } : {}),
  }
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Makes one scoped, process-local registry. Entries are intentionally not
 * durable: process restart or owner-scope closure loses status and interrupts
 * live work. Persisted observation, restart recovery, and remote workers need a
 * separate durable ownership slice rather than pretending this registry has
 * those semantics.
 */
export const make = Effect.gen(function* () {
  const state: State = {
    jobs: yield* SynchronizedRef.make(new Map()),
    scope: yield* Scope.Scope,
  }

  const settle = Effect.fn("BackgroundJob.settle")(function* (
    id: string,
    token: object,
    sequence: number,
    exit: Exit.Exit<string, unknown>,
  ) {
    const completed_at = yield* Clock.currentTimeMillis
    const result = yield* SynchronizedRef.modify(state.jobs, (jobs): readonly [FinishResult, Map<string, Active>] => {
      const job = jobs.get(id)
      if (!job) return [{}, jobs]
      if (job.token !== token) return [{}, jobs]
      if (job.info.status !== "running") return [{ info: snapshot(job) }, jobs]
      const pending = job.pending - 1
      const interrupted = Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
      const output =
        Exit.isSuccess(exit) && (!job.output || sequence > job.output.sequence)
          ? { sequence, text: exit.value }
          : job.output
      const failure =
        Exit.isFailure(exit) && !interrupted && (!job.failure || sequence > job.failure.sequence)
          ? { sequence, text: errorText(Cause.squash(exit.cause)) }
          : job.failure

      if (!interrupted && (Exit.isSuccess(exit) || job.continueOnFailure) && pending > 0) {
        jobs.set(id, { ...job, pending, output, failure })
        return [{}, jobs]
      }

      const failFast = Exit.isFailure(exit) && !interrupted && !job.continueOnFailure
      const latestFailed =
        !interrupted && failure !== undefined && (!output || failure.sequence > output.sequence)
      const status: Exclude<Status, "running"> =
        interrupted ? "cancelled" : failFast || latestFailed ? "error" : "completed"
      const terminalError = failFast && Exit.isFailure(exit) ? errorText(Cause.squash(exit.cause)) : failure?.text
      const next = {
        ...job,
        onPromote: undefined,
        pending: 0,
        output,
        failure,
        info: {
          ...job.info,
          status,
          completed_at,
          ...(output ? { output: output.text } : {}),
          ...(status === "error" && terminalError ? { error: terminalError } : {}),
        },
      }
      jobs.set(id, next)
      return [{ info: snapshot(next), done: job.done, scope: job.scope }, jobs]
    })
    if (result.info && result.done) yield* Deferred.succeed(result.done, result.info).pipe(Effect.ignore)
    if (result.scope) {
      const handle = ownedByToken.get(token)
      if (handle) unregisterOwned(handle)
      yield* Scope.close(result.scope, Exit.void).pipe(Effect.forkIn(state.scope, { startImmediately: true }))
    }
    return result.info
  })

  const fork = Effect.fn("BackgroundJob.fork")(function* (
    scope: Scope.Scope,
    id: string,
    token: object,
    sequence: number,
    run: Effect.Effect<string, unknown>,
  ) {
    return yield* run.pipe(
      Effect.matchCauseEffect({
        onSuccess: (output) => settle(id, token, sequence, Exit.succeed(output)),
        onFailure: (cause) => settle(id, token, sequence, Exit.failCause(cause)),
      }),
      Effect.asVoid,
      Effect.forkIn(scope, { startImmediately: true }),
    )
  })

  const list: Interface["list"] = Effect.fn("BackgroundJob.list")(function* () {
    return yield* SynchronizedRef.modify(state.jobs, (jobs) => [
      Array.from(jobs.values())
        .map(snapshot)
        .toSorted((a, b) => a.started_at - b.started_at),
      jobs,
    ])
  })

  const get: Interface["get"] = Effect.fn("BackgroundJob.get")(function* (id) {
    return yield* SynchronizedRef.modify(state.jobs, (jobs) => {
      const job = jobs.get(id)
      return [job ? snapshot(job) : undefined, jobs]
    })
  })

  const cancelToken = Effect.fn("BackgroundJob.cancelToken")(function* (id: string, token: object) {
    const completed_at = yield* Clock.currentTimeMillis
    const result = yield* SynchronizedRef.modify(state.jobs, (jobs): readonly [FinishResult, Map<string, Active>] => {
      const job = jobs.get(id)
      if (!job || job.token !== token) return [{}, jobs]
      if (job.info.status !== "running") return [{ info: snapshot(job) }, jobs]
      const next = { ...job, onPromote: undefined, pending: 0, info: { ...job.info, status: "cancelled" as const, completed_at } }
      jobs.set(id, next)
      return [{ info: snapshot(next), done: job.done, scope: job.scope }, jobs]
    })
    if (result.info && result.done) yield* Deferred.succeed(result.done, result.info).pipe(Effect.ignore)
    if (result.scope) {
      const handle = ownedByToken.get(token)
      if (handle) unregisterOwned(handle)
      yield* Scope.close(result.scope, Exit.void).pipe(Effect.forkIn(state.scope, { startImmediately: true }), Effect.asVoid)
    }
    return result.info
  })

  const tryStart: Interface["tryStart"] = Effect.fn("BackgroundJob.tryStart")(function* (input) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const id = input.id ?? Identifier.ascending("job")
        const started_at = yield* Clock.currentTimeMillis
        const done = yield* Deferred.make<Info>()
        const promoted = yield* Deferred.make<Info>()
        const tail = yield* Deferred.make<void>()
        const result = yield* SynchronizedRef.modifyEffect(
          state.jobs,
          Effect.fnUntraced(function* (jobs) {
            const existing = jobs.get(id)
            if (existing?.info.status === "running") {
              return [{ info: snapshot(existing) }, jobs] as readonly [StartResult, Map<string, Active>]
            }
            const scope = yield* Scope.fork(state.scope, "parallel")
            const token = {}
            const job = {
              info: {
                id,
                type: input.type,
                title: input.title,
                status: "running" as const,
                generation: (existing?.info.generation ?? 0) + 1,
                started_at,
                metadata: input.metadata,
              },
              done,
              scope,
              token,
              pending: 1,
              next: 1,
              tail,
              promoted,
              onPromote: input.onPromote,
              continueOnFailure: input.continueOnFailure === true,
            }
            jobs.set(id, job)
            return [{ info: snapshot(job), scope, token }, jobs] as readonly [StartResult, Map<string, Active>]
          }),
        )
        if ("scope" in result) {
          const metadata = result.info.metadata
          const sessionID = typeof metadata?.sessionId === "string" ? metadata.sessionId : undefined
          const parentSessionID = typeof metadata?.parentSessionId === "string" ? metadata.parentSessionId : undefined
          const activeFence = oldestCancellationFence([id, sessionID, parentSessionID])
          const handle: OwnedHandle = {
            id,
            generation: result.info.generation ?? 0,
            sessionID,
            parentSessionID,
            // Work admitted while one or more matching cancellation fences are
            // active must compare older than *every* such fence. Using the
            // oldest matching epoch avoids cross-session interference when an
            // unrelated cancellation advances the process-global admission
            // clock between this fence's two drains.
            admissionEpoch: activeFence === undefined ? admissionEpoch : activeFence - 1n,
            background: metadata?.background === true,
            cancel: Effect.suspend(() => cancelToken(id, result.token)),
          }
          ownedByToken.set(result.token, handle)
          registerOwned(handle)
          yield* Scope.addFinalizer(result.scope, Effect.sync(() => unregisterOwned(handle)))
          yield* fork(
            result.scope,
            id,
            result.token,
            0,
            restore(input.run).pipe(Effect.ensuring(Deferred.succeed(tail, undefined))),
          )
        }
        return { info: result.info, started: "scope" in result }
      }),
    )
  })

  const start: Interface["start"] = Effect.fn("BackgroundJob.start")(function* (input) {
    return (yield* tryStart(input)).info
  })

  const extend: Interface["extend"] = Effect.fn("BackgroundJob.extend")(function* (input) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const tail = yield* Deferred.make<void>()
        const result = yield* SynchronizedRef.modify(
          state.jobs,
          (jobs): readonly [ExtendResult, Map<string, Active>] => {
            const job = jobs.get(input.id)
            if (!job || job.info.status !== "running") return [{ extended: false }, jobs]
            jobs.set(input.id, {
              ...job,
              pending: job.pending + 1,
              next: job.next + 1,
              tail,
            })
            return [
              { extended: true, previous: job.tail, scope: job.scope, tail, token: job.token, sequence: job.next },
              jobs,
            ]
          },
        )
        if (!result.extended) return false
        yield* fork(
          result.scope,
          input.id,
          result.token,
          result.sequence,
          Deferred.await(result.previous).pipe(
            Effect.andThen(restore(input.run)),
            Effect.ensuring(Deferred.succeed(result.tail, undefined)),
          ),
        )
        return true
      }),
    )
  })

  const wait: Interface["wait"] = Effect.fn("BackgroundJob.wait")(function* (input) {
    const job = yield* SynchronizedRef.modify(state.jobs, (jobs) => [jobs.get(input.id), jobs])
    if (!job) return { timedOut: false }
    if (job.info.status !== "running") return { info: snapshot(job), timedOut: false }
    if (input.timeout === undefined) return { info: yield* Deferred.await(job.done), timedOut: false }
    if (input.timeout <= 0) return { info: snapshot(job), timedOut: true }
    const info = yield* Deferred.await(job.done).pipe(Effect.timeoutOption(input.timeout))
    if (info._tag === "Some") return { info: info.value, timedOut: false }
    return { info: snapshot(job), timedOut: true }
  })

  const waitForPromotion: Interface["waitForPromotion"] = Effect.fn("BackgroundJob.waitForPromotion")(function* (id) {
    const job = yield* SynchronizedRef.modify(state.jobs, (jobs) => [jobs.get(id), jobs])
    if (!job || job.info.status !== "running") return yield* Effect.never
    if (job.info.metadata?.background === true) return snapshot(job)
    return yield* Deferred.await(job.promoted)
  })

  const promote: Interface["promote"] = Effect.fn("BackgroundJob.promote")(function* (id) {
    const result = yield* SynchronizedRef.modifyEffect(
      state.jobs,
      Effect.fnUntraced(function* (jobs) {
        const job = jobs.get(id)
        if (!job || job.info.status !== "running") return [{}, jobs] as readonly [PromoteResult, Map<string, Active>]
        if (job.info.metadata?.background === true)
          return [{ info: snapshot(job) }, jobs] as readonly [PromoteResult, Map<string, Active>]
        const next = {
          ...job,
          onPromote: undefined,
          info: {
            ...job.info,
            metadata: { ...job.info.metadata, background: true },
          },
        }
        jobs.set(id, next)
        return [{ info: snapshot(next), onPromote: job.onPromote, promoted: job.promoted }, jobs] as readonly [
          PromoteResult,
          Map<string, Active>,
        ]
      }),
    )
    if (result.info && result.promoted) yield* Deferred.succeed(result.promoted, result.info).pipe(Effect.ignore)
    if (result.info) for (const handle of ownedHandles.get(id) ?? []) handle.background = true
    if (result.onPromote) yield* result.onPromote.pipe(Effect.ignore)
    return result.info
  })

  const foreground: Interface["foreground"] = Effect.fn("BackgroundJob.foreground")(function* (id, onPromote) {
    const result = yield* SynchronizedRef.modifyEffect(
      state.jobs,
      Effect.fnUntraced(function* (jobs) {
        const job = jobs.get(id)
        if (!job) return [undefined, jobs] as const
        if (job.info.metadata?.background !== true) return [snapshot(job), jobs] as const
        const promoted = job.info.status === "running" ? yield* Deferred.make<Info>() : job.promoted
        const next = {
          ...job,
          promoted,
          onPromote: job.info.status === "running" ? onPromote : undefined,
          info: {
            ...job.info,
            metadata: { ...job.info.metadata, background: false },
          },
        }
        jobs.set(id, next)
        return [snapshot(next), jobs] as const
      }),
    )
    if (result) for (const handle of ownedHandles.get(id) ?? []) handle.background = false
    return result
  })

  const cancel: Interface["cancel"] = Effect.fn("BackgroundJob.cancel")(function* (id) {
    const job = yield* SynchronizedRef.modify(state.jobs, (jobs) => [jobs.get(id), jobs])
    if (!job) return undefined
    return yield* cancelToken(id, job.token)
  })

  return Service.of({ list, get, start, tryStart, extend, wait, waitForPromotion, promote, foreground, cancel })
})

const layer = Layer.effect(Service, make)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
