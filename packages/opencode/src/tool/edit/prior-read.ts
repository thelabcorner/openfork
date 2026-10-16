import { Effect, Option } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"

export type ReadRecord = {
  observedAtMs: number
  exists: boolean
  mtimeMs: number
  size: number
  groundedByRead: boolean
}

/**
 * Prior-read enforcement (D47).
 *
 * Records are scoped by session. Full text reads establish line grounding;
 * navigation views record freshness without claiming complete text grounding.
 * Successful mutations made by that same session advance the observed file
 * version so a follow-up edit does not need a redundant re-read. Another
 * session (or an external editor/process) cannot advance this session's
 * record, so detected out-of-session drift still hard-refuses.
 *
 * A mutation does not magically give the model line-number grounding: writes
 * preserve groundedByRead=false until the session actually reads the file.
 */
export class ReadCache {
  private readonly entries = new Map<string, ReadRecord>()
  constructor(private readonly max = 512) {}

  private key(sessionID: string, filePath: string) {
    // Resolve symlink and dot-segment aliases on every platform. The read and
    // edit tools can be given different spellings for the same file; keeping
    // separate cache entries would let one spelling miss another spelling's
    // freshness record.
    let canonical = FSUtil.normalizePath(filePath)
    try {
      canonical = FSUtil.resolve(filePath)
    } catch {
      // Missing paths still need a stable key (for create/delete flows).
    }
    return `${sessionID}\u0000${canonical}`
  }

  private set(sessionID: string, filePath: string, record: ReadRecord) {
    const key = this.key(sessionID, filePath)
    if (this.entries.size >= this.max && !this.entries.has(key)) {
      const oldest = this.entries.keys().next()
      if (!oldest.done) this.entries.delete(oldest.value)
    }
    this.entries.set(key, record)
  }

  recordRead(sessionID: string, filePath: string, mtimeMs: number, size: number, groundedByRead = true) {
    this.set(sessionID, filePath, {
      observedAtMs: Date.now(),
      exists: true,
      mtimeMs,
      size,
      groundedByRead,
    })
  }

  recordWrite(sessionID: string, filePath: string, mtimeMs: number, size: number, inheritGrounding = false) {
    const prior = this.get(sessionID, filePath)
    this.set(sessionID, filePath, {
      observedAtMs: Date.now(),
      exists: true,
      mtimeMs,
      size,
      groundedByRead: prior?.groundedByRead === true || inheritGrounding,
    })
  }

  recordDelete(sessionID: string, filePath: string) {
    const prior = this.get(sessionID, filePath)
    this.set(sessionID, filePath, {
      observedAtMs: Date.now(),
      exists: false,
      mtimeMs: 0,
      size: 0,
      groundedByRead: prior?.groundedByRead === true,
    })
  }

  get(sessionID: string, filePath: string): ReadRecord | undefined {
    return this.entries.get(this.key(sessionID, filePath))
  }
}

/** Process-wide cache. The read tool records; edit/patch enforce. */
export const globalReadCache = new ReadCache()

const LINE_TARGETED = new Set(["line", "startLine/endLine", "insertAt", "delete", "edits"])

export const enforce = Effect.fn("PriorRead.enforce")(function* (
  cache: Option.Option<ReadCache>,
  afs: FSUtil.Interface,
  sessionID: string,
  filePath: string,
  strategy: string,
) {
  if (Option.isNone(cache)) return {}
  const record = cache.value.get(sessionID, filePath)
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
  if (!stat) {
    if (!record.exists) return {}
    return {
      refusal:
        `This file changed outside the current session after it was last observed: it no longer exists. ` +
        `Re-read the path before editing. Changes made by this session are tracked automatically and do not require re-reading.`,
    }
  }
  const mtimeMs = Option.getOrElse(stat.mtime, () => new Date(0)).getTime()
  const size = Number(stat.size)
  if (!record.exists || mtimeMs !== record.mtimeMs || size !== record.size) {
    return {
      refusal:
        `This file changed outside the current session after it was last observed. ` +
        `Re-read it once before editing so the edit targets current content. Changes made by this session are tracked automatically and do not require re-reading.`,
    }
  }
  if (!record.groundedByRead && LINE_TARGETED.has(strategy)) {
    return {
      warning:
        `This file has only been written, not read as full text in this session — it may instead have been inspected through outline/grep/around. ` +
        `Line numbers may be stale. The edit was still validated against current contents; read the relevant text before line-targeted edits.`,
    }
  }
  return {}
})

export const noteWrite = Effect.fn("PriorRead.noteWrite")(function* (
  cache: ReadCache,
  afs: FSUtil.Interface,
  sessionID: string,
  filePath: string,
  inheritGrounding = false,
) {
  const stat = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (!stat || stat.type === "Directory") return
  cache.recordWrite(
    sessionID,
    filePath,
    Option.getOrElse(stat.mtime, () => new Date(0)).getTime(),
    Number(stat.size),
    inheritGrounding,
  )
})

export const noteDelete = (cache: ReadCache, sessionID: string, filePath: string) => {
  cache.recordDelete(sessionID, filePath)
}

export const noteMove = Effect.fn("PriorRead.noteMove")(function* (
  cache: ReadCache,
  afs: FSUtil.Interface,
  sessionID: string,
  sourcePath: string,
  destinationPath: string,
) {
  const inheritGrounding = cache.get(sessionID, sourcePath)?.groundedByRead === true
  cache.recordDelete(sessionID, sourcePath)
  yield* noteWrite(cache, afs, sessionID, destinationPath, inheritGrounding)
})

export * as PriorRead from "./prior-read"
