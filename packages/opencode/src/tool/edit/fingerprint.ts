import { Effect, Option } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"

const mtimeOf = (stat: { mtime: Option.Option<Date> } | undefined): number =>
  stat ? Option.getOrElse(stat.mtime, () => new Date(0)).getTime() : 0

export type Fingerprint = { mtimeMs: number; size: number; hash: string }

/** Cheap non-cryptographic content hash (FNV-1a, 32-bit). */
export function hashContent(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

export function fingerprintOf(mtimeMs: number, content: string): Fingerprint {
  return { mtimeMs, size: content.length, hash: hashContent(content) }
}

export const capture = Effect.fn("EditFingerprint.capture")(function* (afs: FSUtil.Interface, filePath: string, content: string) {
  const stat = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
  return fingerprintOf(mtimeOf(stat), content)
})

/**
 * Re-verify immediately before writing. The window between plan and write is
 * unbounded — it contains ctx.ask, which blocks on a human — and a whole-file
 * contentNew computed from pre-prompt bytes would otherwise silently obliterate
 * any external mutation rather than conflicting on it.
 *
 * Returns undefined when the file is unchanged (fast path: the plan's spans
 * are still valid), or an error message when the file disappeared or changed.
 * A changed file is NOT automatically fatal to the caller: the commit path
 * re-resolves the edit against current content and only refuses when the
 * target no longer matches — a concurrent edit elsewhere in the file must not
 * fail this one.
 */
export const verify = Effect.fn("EditFingerprint.verify")(function* (
  afs: FSUtil.Interface,
  filePath: string,
  expected: Fingerprint,
  readText: (path: string) => Effect.Effect<string>,
) {
  const stat = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (!stat) {
    return `File ${filePath} disappeared after it was read. Re-read it and reissue the edit.`
  }
  const mtimeMs = mtimeOf(stat)
  if (mtimeMs === expected.mtimeMs) {
    const current = yield* readText(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (current !== undefined && hashContent(current) === expected.hash && current.length === expected.size) return undefined
    if (current === undefined) return undefined
  } else {
    // mtime moved: confirm by content before reporting, so touch(1) and
    // format-in-place round trips don't produce spurious failures.
    const current = yield* readText(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (current !== undefined && hashContent(current) === expected.hash && current.length === expected.size) return undefined
  }
  return (
    `File ${filePath} changed on disk after it was read (and after this edit was planned). ` +
    `The edit will be re-validated against the current contents; if the target no longer matches, re-read the file and reissue the edit.`
  )
})

export * as EditFingerprint from "./fingerprint"
