


import { Effect, Semaphore } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"

// Per-path write serialization shared by the edit and patch executors.
//
// The key is the normalized resolved path so case variants of one file share
// a semaphore on case-insensitive filesystems. Entries are evicted the moment
// their in-flight count reaches zero: at that point there are no holders and
// no waiters (acquirers increment before blocking), so dropping the entry is
// safe and the next acquirer creates a fresh one. The table therefore stays
// bounded by live concurrency instead of growing with every file ever touched.
type Entry = { sem: Semaphore.Semaphore; active: number }
const locks = new Map<string, Entry>()

function keyFor(filePath: string) {
  return FSUtil.normalizePath(FSUtil.resolve(filePath))
}

function entryFor(filePath: string): { key: string; entry: Entry } {
  const key = keyFor(filePath)
  const hit = locks.get(key)
  if (hit) return { key, entry: hit }
  const entry: Entry = { sem: Semaphore.makeUnsafe(1), active: 0 }
  locks.set(key, entry)
  return { key, entry }
}

function release(key: string, entry: Entry): void {
  entry.active--
  if (entry.active <= 0 && locks.get(key) === entry) locks.delete(key)
}

// Run an effect while holding one path's lock. Acquisition is counted and
// idle entries are evicted on release, which runs on completion, failure, and
// interruption via ensuring (no Scope required).
export function withLock<A, E, R>(
  filePath: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  const { key, entry } = entryFor(filePath)
  entry.active++
  return entry.sem.withPermits(1)(effect).pipe(Effect.ensuring(Effect.sync(() => release(key, entry))))
}

// Run an effect while holding every target lock. Locks are always acquired in
// sorted path order so concurrent multi-file sections cannot deadlock against
// each other.
export function withFileLocks<A, E, R>(
  filePaths: readonly string[],
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  const ordered = [...new Set(filePaths)].sort()
  return ordered.reduceRight((inner, file) => withLock(file, inner), effect)
}

/** Testing seam: number of live lock-table entries. */
export function lockTableSize(): number {
  return locks.size
}
