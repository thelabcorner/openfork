import { Effect } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import * as Bom from "@/util/bom"

export type Restorable = {
  filePath: string
  existedBefore: boolean
  contentBefore: string
  bom: boolean
}

/**
 * Journal-and-restore for the bulk write loop. Retires the "atomicity
 * overclaim" flag: every write is either committed or unwound, so a mid-loop
 * failure can no longer leave a half-applied refactor. Roll back inside the
 * file locks so no other writer can interleave during an unwind.
 */
export const withRollback = Effect.fn("PatchRollback.with")(function* <A, E, R>(
  afs: FSUtil.Interface,
  journal: readonly Restorable[],
  body: Effect.Effect<A, E, R>,
) {
  return yield* body.pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        // Reverse order: a composed add+update for one path restores the seed
        // content first, then removes the added file — forward order would
        // delete then recreate.
        for (const entry of [...journal].reverse()) {
          if (entry.existedBefore) {
            yield* afs.writeWithDirs(entry.filePath, Bom.join(entry.contentBefore, entry.bom)).pipe(Effect.catch(() => Effect.void))
          } else {
            yield* afs.remove(entry.filePath).pipe(Effect.catch(() => Effect.void))
          }
        }
        return yield* Effect.fail(error)
      }),
    ),
  )
})

export * as PatchRollback from "./rollback"
