export * as ExchangeFileMutation from "./file-mutation"

import { Effect } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { atomicWrite } from "@/tool/edit/commit"
import { withFileLocks } from "@/tool/file-lock"
import { ExchangeError } from "./error"

export type Change =
  | {
      readonly type: "add"
      readonly path: string
      readonly displayPath: string
      readonly beforeExists: false
      readonly before: Uint8Array
      readonly after: Uint8Array
    }
  | {
      readonly type: "update"
      readonly path: string
      readonly displayPath: string
      readonly beforeExists: true
      readonly before: Uint8Array
      readonly after: Uint8Array
    }
  | {
      readonly type: "delete"
      readonly path: string
      readonly displayPath: string
      readonly beforeExists: true
      readonly before: Uint8Array
    }
  | {
      readonly type: "move"
      readonly path: string
      readonly displayPath: string
      readonly movePath: string
      readonly moveDisplayPath: string
      readonly beforeExists: true
      readonly before: Uint8Array
      readonly after: Uint8Array
    }

export interface PrepareResult<A> {
  readonly changes: readonly Change[]
  readonly value: A
}

export interface Hooks<E, A> {
  /**
   * Runs under all transaction locks. The planner may re-read/reconcile current
   * bytes here, then returns the exact before/after states to commit.
   */
  readonly prepare: () => Effect.Effect<PrepareResult<A>, ExchangeError.Error | E>
  /** Re-check external authority after planning but before the final CAS. */
  readonly revalidate: () => Effect.Effect<void, ExchangeError.Error | E>
  /**
   * Runs after final CAS and immediately before the first externally visible
   * mutation. Receipt-backed protocols mark their mutation boundary here.
   */
  readonly beforeCommit: () => Effect.Effect<void, ExchangeError.Error | E>
}

export interface Result<A> {
  readonly value: A
  readonly changes: readonly Change[]
  readonly committed: boolean
}

function sameBytes(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false
  return true
}

function targets(changes: readonly Change[]) {
  return changes.flatMap((change) => (change.type === "move" ? [change.path, change.movePath] : [change.path]))
}

function ensureNotCancelled(signal?: AbortSignal) {
  return signal?.aborted
    ? Effect.fail<ExchangeError.Error>(new ExchangeError.Cancelled({ detail: "File mutation was cancelled" }))
    : Effect.void
}

function dependency(detail: string) {
  return new ExchangeError.DependencyUnavailable({ detail })
}

function exists(fs: FSUtil.Interface, filePath: string) {
  return fs.exists(filePath).pipe(Effect.mapError(() => dependency("Unable to inspect file mutation state")))
}

function read(fs: FSUtil.Interface, filePath: string) {
  return fs.readFile(filePath).pipe(Effect.mapError(() => dependency("Unable to inspect file mutation bytes")))
}

function cas(fs: FSUtil.Interface, changes: readonly Change[]) {
  return Effect.gen(function* () {
    for (const change of changes) {
      const sourceExists = yield* exists(fs, change.path)
      if (sourceExists !== change.beforeExists) {
        return yield* new ExchangeError.Conflict({ detail: `${change.displayPath} changed before commit` })
      }
      if (sourceExists) {
        const current = yield* read(fs, change.path)
        if (!sameBytes(current, change.before)) {
          return yield* new ExchangeError.Conflict({ detail: `${change.displayPath} changed before commit` })
        }
      }
      if (change.type === "move" && (yield* exists(fs, change.movePath))) {
        return yield* new ExchangeError.Conflict({ detail: `${change.moveDisplayPath} appeared before commit` })
      }
    }
  })
}

function rollback(fs: FSUtil.Interface, attempted: readonly Change[], cause: unknown) {
  return Effect.gen(function* () {
    const ambiguous: string[] = []
    const rollbackFailed: string[] = []

    const inspect = Effect.fnUntraced(function* (filePath: string) {
      const present = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => undefined))
      if (present === undefined) return undefined
      if (!present) return { exists: false as const }
      const bytes = yield* fs.readFile(filePath).pipe(Effect.orElseSucceed(() => undefined))
      if (!bytes) return undefined
      return { exists: true as const, bytes }
    })

    const restore = (filePath: string, bytes: Uint8Array, display: string) =>
      atomicWrite(fs, filePath, bytes).pipe(
        Effect.as(true),
        Effect.catch(() =>
          Effect.sync(() => {
            rollbackFailed.push(display)
            return false
          }),
        ),
      )
    const remove = (filePath: string, display: string) =>
      fs.remove(filePath).pipe(
        Effect.as(true),
        Effect.catch(() =>
          Effect.sync(() => {
            rollbackFailed.push(display)
            return false
          }),
        ),
      )

    for (const change of attempted.toReversed()) {
      if (change.type === "add") {
        const state = yield* inspect(change.path)
        if (!state) {
          ambiguous.push(change.displayPath)
          continue
        }
        if (!state.exists) continue // mutation was not externally visible
        if (!sameBytes(state.bytes, change.after)) {
          ambiguous.push(change.displayPath)
          continue
        }
        yield* remove(change.path, change.displayPath)
        continue
      }

      if (change.type === "update") {
        const state = yield* inspect(change.path)
        if (!state || !state.exists) {
          ambiguous.push(change.displayPath)
          continue
        }
        if (sameBytes(state.bytes, change.before)) continue // write never became visible
        if (!sameBytes(state.bytes, change.after)) {
          ambiguous.push(change.displayPath)
          continue
        }
        yield* restore(change.path, change.before, change.displayPath)
        continue
      }

      if (change.type === "delete") {
        const state = yield* inspect(change.path)
        if (!state) {
          ambiguous.push(change.displayPath)
          continue
        }
        if (state.exists) {
          if (!sameBytes(state.bytes, change.before)) ambiguous.push(change.displayPath)
          continue // original bytes mean delete never became visible
        }
        yield* restore(change.path, change.before, change.displayPath)
        continue
      }

      const source = yield* inspect(change.path)
      const destination = yield* inspect(change.movePath)
      if (!source || !destination) {
        ambiguous.push(`${change.displayPath} -> ${change.moveDisplayPath}`)
        continue
      }

      const sourceOriginal = source.exists && sameBytes(source.bytes, change.before)
      const sourceRemoved = !source.exists
      const destinationOriginal = !destination.exists
      const destinationWritten = destination.exists && sameBytes(destination.bytes, change.after)

      if (sourceOriginal && destinationOriginal) continue // move never became visible
      if (!(destinationWritten && (sourceOriginal || sourceRemoved))) {
        ambiguous.push(`${change.displayPath} -> ${change.moveDisplayPath}`)
        continue
      }

      // Destination publication is the first move mutation. If source removal
      // also became visible, restore the source before deleting the destination.
      if (sourceRemoved) {
        const restored = yield* restore(change.path, change.before, change.displayPath)
        // Never delete the only surviving copy when source restoration failed.
        if (!restored) continue
      }
      yield* remove(change.movePath, change.moveDisplayPath)
    }

    if (ambiguous.length > 0 || rollbackFailed.length > 0) {
      const details = [
        ...(ambiguous.length ? [`unrecognized/newer state: ${ambiguous.join(", ")}`] : []),
        ...(rollbackFailed.length ? [`rollback operation failed: ${rollbackFailed.join(", ")}`] : []),
      ].join("; ")
      return yield* new ExchangeError.AmbiguousCommit({
        detail: `File mutation crossed its commit boundary and could not be proven rolled back (${details})`,
      })
    }
    return yield* new ExchangeError.DependencyUnavailable({
      detail: `File mutation failed and was rolled back: ${cause instanceof Error ? cause.message : String(cause)}`,
    })
  })
}

/**
 * Protocol-neutral file transaction kernel shared by edit and patch.
 *
 * `lockPaths` must conservatively include every possible source/destination the
 * planner can return. The kernel does a second whole-plan CAS after authority
 * revalidation, so an external writer racing the in-process lock is still
 * detected before the first write.
 */
export function commit<E, A>(
  fs: FSUtil.Interface,
  lockPaths: readonly string[],
  hooks: Hooks<E, A>,
  signal?: AbortSignal,
): Effect.Effect<Result<A>, ExchangeError.Error | E> {
  return withFileLocks(
    lockPaths,
    Effect.gen(function* () {
      yield* ensureNotCancelled(signal)
      const prepared = yield* hooks.prepare()
      if (prepared.changes.length === 0) {
        return { value: prepared.value, changes: prepared.changes, committed: false }
      }
      const actualTargets = new Set(targets(prepared.changes).map(FSUtil.normalizePath))
      const lockedTargets = new Set(lockPaths.map(FSUtil.normalizePath))
      if ([...actualTargets].some((target) => !lockedTargets.has(target))) {
        return yield* new ExchangeError.DependencyUnavailable({ detail: "Mutation planner returned a target outside its lock set" })
      }

      yield* hooks.revalidate()
      yield* cas(fs, prepared.changes)
      yield* ensureNotCancelled(signal)
      yield* hooks.beforeCommit()

      const attempted: Change[] = []
      yield* Effect.gen(function* () {
        for (const change of prepared.changes) {
          yield* ensureNotCancelled(signal)
          // Journal before dispatch. A filesystem operation can become visible
          // and still report failure, so recording only successful calls is not
          // sufficient to prove rollback after an uncertain OS result.
          attempted.push(change)
          if (change.type === "delete") {
            yield* fs.remove(change.path)
            continue
          }
          const target = change.type === "move" ? change.movePath : change.path
          yield* atomicWrite(fs, target, change.after)
          if (change.type === "move") yield* fs.remove(change.path)
        }
      }).pipe(
        Effect.catch((cause) => rollback(fs, attempted, cause)),
      )

      return { value: prepared.value, changes: prepared.changes, committed: true }
    }),
  )
}

