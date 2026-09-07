import { Effect, Option } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"

export type ReadRecord = { readAtMs: number; mtimeMs: number; size: number }

/**
 * Prior-read enforcement (D47).
 *
 * Two tiers, deliberately asymmetric:
 * - STALE record (the file changed after it was read) → hard refusal. There
 *   is positive evidence of drift, and applying a planned edit would discard
 *   real changes.
 * - MISSING record → warning, not refusal. Absence of evidence is not evidence
 *   of drift, and refusal would false-positive on legitimate programmatic
 *   flows. The mandatory oldText verification on every line-targeted strategy
 *   plus re-validation against current content at commit already make an
 *   unread line edit unable to silently hit the wrong line.
 */
export class ReadCache {
  private readonly entries = new Map<string, ReadRecord>()
  constructor(private readonly max = 512) {}

  record(filePath: string, mtimeMs: number, size: number) {
    const key = FSUtil.normalizePath(filePath)
    if (this.entries.size >= this.max && !this.entries.has(key)) {
      const oldest = this.entries.keys().next()
      if (!oldest.done) this.entries.delete(oldest.value)
    }
    this.entries.set(key, { readAtMs: Date.now(), mtimeMs, size })
  }

  get(filePath: string): ReadRecord | undefined {
    return this.entries.get(FSUtil.normalizePath(filePath))
  }
}

/** Process-wide cache. The read tool records; edit/patch enforce. */
export const globalReadCache = new ReadCache()

const LINE_TARGETED = new Set(["line", "startLine/endLine", "insertAt", "delete", "edits"])

export const enforce = Effect.fn("PriorRead.enforce")(function* (
  cache: Option.Option<ReadCache>,
  afs: FSUtil.Interface,
  filePath: string,
  strategy: string,
) {
  if (Option.isNone(cache)) return {}
  const record = cache.value.get(filePath)
  if (!record) {
    if (LINE_TARGETED.has(strategy)) {
      return {
        warning:
          `This file has no read record in this session — line numbers may be stale. ` +
          `The edit was still validated against the current file contents, but prefer reading the file first for line-targeted edits.`,
      }
    }
    return {}
  }
  const stat = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (!stat) return {}
  const mtimeMs = Option.getOrElse(stat.mtime, () => new Date(0)).getTime()
  if (mtimeMs > record.mtimeMs) {
    return {
      refusal: `This file changed on disk after it was last read. Re-read it before editing so the edit targets current content.`,
    }
  }
  return {}
})

export * as PriorRead from "./prior-read"
