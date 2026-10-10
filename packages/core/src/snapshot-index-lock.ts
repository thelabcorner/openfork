import path from "path"
import { Effect } from "effect"
import { Flock } from "./util/flock"

/**
 * Shared writer lease for the V1 and core/V2 snapshot implementations.
 *
 * Both services intentionally use data/snapshot/<project>/<worktree> as their
 * shadow gitdir. Their separate in-process semaphores cannot protect that
 * Git index from each other or from another OpenFork server process.
 *
 * Use a different lock directory from Git's index.lock: Flock provides atomic
 * mkdir acquisition, heartbeat, owner token validation and stale lease recovery.
 * Keep this lock across the entire index transaction, not merely git add.
 */
export namespace SnapshotIndexLock {
  export const key = (gitDirectory: string) => `snapshot-index:${path.normalize(gitDirectory)}`
  export const root = (dataDirectory: string) => path.join(dataDirectory, "snapshot-locks")

  export const withLock = <A, E, R>(
    gitDirectory: string,
    dataDirectory: string,
    body: Effect.Effect<A, E, R>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Flock.effect(key(gitDirectory), {
          dir: root(dataDirectory),
          staleMs: 180_000,
          timeoutMs: 45_000,
          baseDelayMs: 60,
          maxDelayMs: 750,
        })
        return yield* body
      }),
    )
}
