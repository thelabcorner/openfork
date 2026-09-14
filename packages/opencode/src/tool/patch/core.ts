// src/tool/patch/core.ts
//
// Pure helpers for the `patch` tool: patch-format auto-detection, git-style
// unified-diff translation into the opencode patch Hunk format, token-lean
// plan/summary rendering, and instructive error text. No I/O here — the tool
// layer owns files, permissions, and dispatch.

import { parsePatch as parseUnifiedDiff } from "diff"
import { normalizePatchText, seekSequence } from "../../patch"
import type { Hunk, UpdateFileChunk } from "../../patch"

export type PatchFormat = "opencode" | "git"

type ParsedGitFile = ReturnType<typeof parseUnifiedDiff>[number]

// ── Format detection ──────────────────────────────────────────────────────────

export function stripHeredoc(input: string): string {
  const m = input.match(/^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/)
  return m ? m[2] : input
}

export function looksLikeOpencode(text: string): boolean {
  return text.includes("*** Begin Patch")
}

export function looksLikeGitDiff(text: string): boolean {
  const t = text.trim()
  return /^--- /m.test(t) && /^\+\+\+ /m.test(t) && t.includes("@@")
}

export function detectFormat(text: string): PatchFormat | null {
  if (looksLikeOpencode(text)) return "opencode"
  if (looksLikeGitDiff(text)) return "git"
  return null
}

// ── Git-style unified diff translation ────────────────────────────────────────

function stripGitPrefix(name: string | undefined): string | null {
  if (!name) return null
  const cleaned = name.replace(/^a\//, "").replace(/^b\//, "")
  if (cleaned === "/dev/null") return null
  return cleaned
}

/**
 * Translate a git-style unified diff (`--- a/x`, `+++ b/x`, `@@` hunks) into
 * the opencode patch Hunk format, so it can flow through the exact same
 * derive/verify path as native patches. Returns null when the input is not a
 * translatable unified diff.
 *
 * SAFETY GATES (a translated patch can never silently mis-apply):
 * - Only files that parse with at least one hunk are emitted.
 * - An update hunk with no old lines (no context, no removals) would map to the
 *   native "append at EOF" semantics — refuse the whole translation instead.
 * - After translation, every update chunk is verified against the real file by
 *   Patch.deriveNewContentsFromChunks (throws on mismatch → nothing is written).
 */
export function translateGitDiff(patchText: string): Hunk[] | null {
  const cleaned = stripHeredoc(normalizePatchText(patchText).trim())
  if (!looksLikeGitDiff(cleaned)) return null

  let parsed: ParsedGitFile[]
  try {
    parsed = parseUnifiedDiff(cleaned)
  } catch {
    return null
  }
  if (parsed.length === 0) return null

  const hunks: Hunk[] = []
  for (const file of parsed) {
    if (!file.hunks || file.hunks.length === 0) continue
    const oldName = stripGitPrefix(file.oldFileName)
    const newName = stripGitPrefix(file.newFileName)

    if (newName === null) {
      // `+++ /dev/null` (or a missing new name): deletion
      if (oldName === null) return null
      hunks.push({ type: "delete", path: oldName })
      continue
    }
    if (oldName === null) {
      // `--- /dev/null` (or a missing old name): creation
      const contents = file.hunks
        .flatMap((h) => h.lines)
        .filter((l) => l.startsWith("+"))
        .map((l) => l.slice(1))
        .join("\n")
      hunks.push({ type: "add", path: newName, contents })
      continue
    }

    // Update (or move when the git diff renames the file): convert hunks.
    const chunks: UpdateFileChunk[] = []
    for (const h of file.hunks) {
      const oldLines: string[] = []
      const newLines: string[] = []
      for (const line of h.lines) {
        if (line.startsWith("\\")) continue // "\ No newline at end of file"
        if (line.startsWith(" ")) {
          oldLines.push(line.slice(1))
          newLines.push(line.slice(1))
        } else if (line.startsWith("-")) {
          oldLines.push(line.slice(1))
        } else if (line.startsWith("+")) {
          newLines.push(line.slice(1))
        }
      }
      if (oldLines.length === 0) return null // unsafe: native semantics append at EOF
      chunks.push({ old_lines: oldLines, new_lines: newLines })
    }
    if (oldName === newName) hunks.push({ type: "update", path: oldName, chunks })
    else hunks.push({ type: "update", path: oldName, move_path: newName, chunks })
  }
  return hunks.length > 0 ? hunks : null
}

// ── Diff line counting ────────────────────────────────────────────────────────

/**
 * Count +/- changes from a rendered unified diff. Only lines INSIDE hunk regions
 * (after an `@@` header) are counted — the `Index:`/`===`/`---`/`+++`/`@@` file
 * headers are excluded, as are `\ No newline at end of file` markers.
 */
export function countPatchChanges(diff: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  let inHunk = false
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true
      continue
    }
    if (!inHunk) continue
    if (line.startsWith("\\")) continue // "\ No newline at end of file"
    if (line.startsWith("+") && !line.startsWith("+++")) additions++
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++
  }
  return { additions, deletions }
}

// ── Plan / summary rendering (token-lean) ─────────────────────────────────────

export type PlanFile = {
  type: "add" | "update" | "delete" | "move"
  path: string
  movePath?: string
  additions: number
  deletions: number
  conflict?: string
}

export function opLetter(type: PlanFile["type"]): string {
  if (type === "add") return "A"
  if (type === "delete") return "D"
  if (type === "move") return "R"
  return "M"
}

const MAX_RENDERED_DIFF = 4000

function renderFileLine(f: PlanFile): string {
  const op = opLetter(f.type)
  const target = f.movePath && f.movePath !== f.path ? ` -> ${f.movePath}` : ""
  if (f.conflict) return `  ${op} ${f.path}${target} CONFLICT: ${f.conflict}`
  return `  ${op} ${f.path}${target} (+${f.additions}/-${f.deletions}) clean`
}

export function formatPlan(input: {
  format: PatchFormat
  files: PlanFile[]
  showDiff: boolean
  diffs: string[]
  mode: "dry-run" | "if-clean"
}): string {
  const n = input.files.length
  const c = input.files.filter((f) => f.conflict).length
  const lines = [
    `patch: ${input.mode === "dry-run" ? "dry-run plan" : "plan"} (mode: ${input.mode}, format: ${input.format}, ${n} file${n === 1 ? "" : "s"}, ${c} conflict${c === 1 ? "" : "s"})`,
  ]
  for (const f of input.files) lines.push(renderFileLine(f))

  if (input.showDiff) {
    for (let i = 0; i < input.files.length; i++) {
      const f = input.files[i]
      if (f.conflict) continue
      const d = input.diffs[i]
      if (!d) continue
      const shown = d.length > MAX_RENDERED_DIFF ? d.slice(0, MAX_RENDERED_DIFF) + "\n... (diff truncated)" : d
      lines.push(`  --- diff ${f.path}${f.movePath && f.movePath !== f.path ? ` -> ${f.movePath}` : ""}`)
      lines.push(shown.split("\n").map((l) => `  ${l}`).join("\n"))
      lines.push(`  --- end diff`)
    }
  }

  lines.push(
    c > 0
      ? "next: fix the conflicted files above and resubmit (nothing was written)"
      : "next: re-run with apply:true to write these changes, or resubmit bare for if-clean apply (nothing was written)",
  )
  return lines.join("\n")
}

export function formatApplySummary(input: { format: PatchFormat; files: PlanFile[]; mode: "apply" | "if-clean" }): string {
  const n = input.files.length
  const lines = [`patch: applied ${n} change${n === 1 ? "" : "s"} (mode: ${input.mode}, format: ${input.format})`]
  for (const f of input.files) {
    const op = opLetter(f.type)
    const target = f.movePath && f.movePath !== f.path ? ` -> ${f.movePath}` : ""
    lines.push(`  ${op} ${f.path}${target} (+${f.additions}/-${f.deletions})`)
  }
  return lines.join("\n")
}

export function noChangesMessage(applied: boolean): string {
  return applied
    ? "patch: no changes to apply (hunks matched but produced no diff — nothing was written)"
    : "patch: no changes (hunks matched but produced no diff)"
}

// ── Instructive parse errors ──────────────────────────────────────────────────

const OPENCODE_EXAMPLE = [
  "*** Begin Patch",
  "*** Add File: hello.txt",
  "+Hello world",
  "*** Update File: src/main.ts",
  "@@",
  "-print('Hi')",
  "+print('Hello!')",
  "*** Delete File: obsolete.txt",
  "*** End Patch",
].join("\n")

const GIT_EXAMPLE = [
  "--- a/src/main.ts",
  "+++ b/src/main.ts",
  "@@ -1,2 +1,2 @@",
  "-print('Hi')",
  "+print('Hello!')",
].join("\n")

export function instructiveParseError(format: PatchFormat | null, underlying: unknown, patchText: string): string {
  const parts: string[] = []
  parts.push(
    format === null
      ? "Invalid patch: could not detect a patch format. Expected the opencode format (*** Begin Patch ... *** End Patch) or a git-style unified diff (--- a/x, +++ b/x, @@ hunks)."
      : `Invalid patch: could not parse as the ${format} format.`,
  )
  if (format !== "git") parts.push("", "opencode format example:", OPENCODE_EXAMPLE)
  if (format !== "opencode") parts.push("", "git-style unified diff example:", GIT_EXAMPLE)
  parts.push("", `Received (first 80 chars): "${patchText.trim().slice(0, 80)}"`)
  if (underlying) parts.push(`Underlying error: ${underlying instanceof Error ? underlying.message : String(underlying)}`)
  return parts.join("\n")
}

// ── Diff trimming (shared with the edit tool) ─────────────────────────────────
// Strips the common leading indentation from diff content lines so permission
// prompts and metadata stay compact. Pure; lives here so both the edit tool
// and the patch executor can import it without an edit<->patch import cycle.
export function trimDiff(diff: string): string {
  const lines = diff.split("\n")
  const contentLines = lines.filter(
    (line) =>
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
      !line.startsWith("---") &&
      !line.startsWith("+++"),
  )

  if (contentLines.length === 0) return diff

  let min = Infinity
  for (const line of contentLines) {
    const content = line.slice(1)
    if (content.trim().length > 0) {
      const match = content.match(/^(\s*)/)
      if (match) min = Math.min(min, match[1].length)
    }
  }
  if (min === Infinity || min === 0) return diff
  const trimmedLines = lines.map((line) => {
    if (
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
      !line.startsWith("---") &&
      !line.startsWith("+++")
    ) {
      const prefix = line[0]
      const content = line.slice(1)
      return prefix + content.slice(min)
    }
    return line
  })

  return trimmedLines.join("\n")
}

export function noOpsError(format: PatchFormat): string {
  return format === "opencode"
    ? "No file operations found in the patch. Expected *** Add File: / *** Update File: / *** Delete File: headers between the Begin and End markers."
    : "No file operations found in the git-style diff (no translatable file hunks)."
}

// Refuse to treat binary files as text. A NUL byte in the first 512
// characters also catches UTF-16, where ASCII-range text interleaves NULs.
export function assertTextContent(content: string, filePath: string): void {
  if (content.slice(0, 512).includes("\0") === false) return
  throw new Error(
    `Refusing to edit binary file ${filePath}: NUL byte detected in the first 512 characters. This tool only edits text files.`,
  )
}

// Order-independent chunk resolution (shared with the batch-edit path): every
// chunk's position is resolved against the ORIGINAL content first (using the
// identical seek the cursor resolver uses, so anything unresolvable here is
// unresolvable there and is left for it to report as a proper conflict), then
// chunks are sorted by offset and overlaps are rejected. Position-free (pure
// addition) chunks trail in encounter order; they never interact with the
// cursor. Single-chunk callers skip this entirely (no extra reads).
export function orderChunksByPosition(
  content: string,
  filePath: string,
  chunks: UpdateFileChunk[],
): UpdateFileChunk[] {
  const lines = content.split("\n")
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  const positioned: Array<{ chunk: UpdateFileChunk; start: number; len: number }> = []
  const floating: UpdateFileChunk[] = []
  const unresolved: UpdateFileChunk[] = []
  for (const chunk of chunks) {
    if (chunk.old_lines.length === 0) {
      floating.push(chunk)
      continue
    }
    let pattern = chunk.old_lines
    let found = seekSequence(lines, pattern, 0, chunk.is_end_of_file ?? false)
    let length = pattern.length
    if (found === -1 && length > 0 && pattern[length - 1] === "") {
      pattern = pattern.slice(0, -1)
      found = seekSequence(lines, pattern, 0, chunk.is_end_of_file ?? false)
      length = pattern.length
    }
    if (found === -1) {
      unresolved.push(chunk)
      continue
    }
    positioned.push({ chunk, start: found, len: length })
  }
  positioned.sort((a, b) => a.start - b.start)
  for (let i = 1; i < positioned.length; i++) {
    const prev = positioned[i - 1]
    const next = positioned[i]
    if (prev && next && next.start < prev.start + prev.len) {
      throw new Error(
        `overlapping chunks in ${filePath} (lines ${next.start + 1}..${next.start + next.len} overlap lines ${prev.start + 1}..${prev.start + prev.len}): split them into separate non-overlapping sections`,
      )
    }
  }
  return [...positioned.map((p) => p.chunk), ...floating, ...unresolved]
}
