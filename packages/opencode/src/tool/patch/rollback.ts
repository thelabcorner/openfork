import { Effect } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import * as Bom from "@/util/bom"

export type Restorable = {
  filePath: string
  existedBefore: boolean
  contentBefore: string
  bom: boolean
  /**
   * A journal row becomes rollback-eligible only after the corresponding
   * mutation has actually committed. This prevents a failure before a write
   * from "restoring" a path we never changed.
   */
  committed: boolean
  /**
   * Exact post-mutation state owned by this patch operation. Rollback is a
   * compare-before-restore operation: if the live path no longer matches this
   * state, another writer has won and we must preserve its bytes.
   */
  expectedExists?: boolean
  expectedContent?: Uint8Array
}

export class RollbackConflictError extends Error {
  readonly paths: string[]
  readonly original: unknown

  constructor(paths: readonly string[], original: unknown) {
    const unique = [...new Set(paths)]
    super("Patch rollback refused to overwrite newer or unverifiable state: " + unique.join(", "))
    this.name = "RollbackConflictError"
    this.paths = unique
    this.original = original
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false
  }
  return true
}

const stillOwned = (afs: FSUtil.Interface, entry: Restorable) => {
  if (!entry.committed || entry.expectedExists === undefined) return Effect.succeed(false)
  if (!entry.expectedExists) {
    return afs.exists(entry.filePath).pipe(
      Effect.map((exists) => !exists),
      Effect.catch(() => Effect.succeed(false)),
    )
  }
  if (!entry.expectedContent) return Effect.succeed(false)
  return afs.readFile(entry.filePath).pipe(
    Effect.map((current) => equalBytes(current, entry.expectedContent!)),
    Effect.catch(() => Effect.succeed(false)),
  )
}

/**
 * Journal-and-restore for the bulk write loop. Retires the "atomicity
 * overclaim" flag for mutations still owned by this operation. Rollback runs
 * inside the patch file locks and additionally compares the live filesystem to
 * the exact post-write state before restoring. The comparison matters for
 * writers outside our in-process lock domain (editors, git, formatters, other
 * processes): a newer external edit is preserved rather than overwritten.
 */
export const withRollback = Effect.fn("PatchRollback.with")(function* <A, E, R>(
  afs: FSUtil.Interface,
  journal: readonly Restorable[],
  body: Effect.Effect<A, E, R>,
) {
  return yield* body.pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        const conflicts: string[] = []
        // Reverse order: a composed add+update for one path restores the seed
        // content first, then removes the added file — forward order would
        // delete then recreate.
        for (const entry of [...journal].reverse()) {
          if (!entry.committed) continue
          if (!(yield* stillOwned(afs, entry))) {
            conflicts.push(entry.filePath)
            continue
          }
          const restored = yield* (
            entry.existedBefore
              ? afs.writeWithDirs(entry.filePath, Bom.join(entry.contentBefore, entry.bom))
              : afs.remove(entry.filePath)
          ).pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          )
          if (!restored) conflicts.push(entry.filePath)
        }
        if (conflicts.length > 0) return yield* Effect.fail(new RollbackConflictError(conflicts, error))
        return yield* Effect.fail(error)
      }),
    ),
  )
})

export * as PatchRollback from "./rollback"
