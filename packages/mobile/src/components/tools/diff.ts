export type DiffLine = {
  kind: "add" | "del" | "context" | "hunk"
  oldNo?: number
  newNo?: number
  text: string
}

export type DiffHunk = {
  header: string
  lines: DiffLine[]
}

export type ParsedDiff = {
  hunks: DiffHunk[]
  additions: number
  deletions: number
}

// Parses a unified diff (git format) into structured hunks. Tolerates missing
// headers, "No newline at end of file" markers, and CRLF output.
export function parseUnifiedDiff(patch: string): ParsedDiff | undefined {
  if (!patch) return undefined
  const raw = patch.replace(/\r\n?/g, "\n").split("\n")
  if (raw.length && raw[raw.length - 1] === "") raw.pop()

  const hunks: DiffHunk[] = []
  let additions = 0
  let deletions = 0
  let current: DiffHunk | undefined

  let oldNo = 0
  let newNo = 0

  const pushLine = (line: DiffLine) => {
    if (!current) return
    current.lines.push(line)
    if (line.kind === "add") additions++
    else if (line.kind === "del") deletions++
  }

  for (const line of raw) {
    if (line.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      oldNo = match ? Number(match[1]) : 1
      newNo = match ? Number(match[2]) : 1
      current = { header: line.trim(), lines: [] }
      hunks.push(current)
      continue
    }
    // File headers and mode lines outside hunks are skipped; inside they cannot appear.
    // Skip these BEFORE the implicit-hunk opener below ("---"/"+++" look like change rows).
    if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) continue
    if (!current) {
      // Some servers emit bare patch bodies with no @@ header; open an
      // implicit hunk for them, but only on a true change line so log noise
      // (anything not starting with +/-) stays unparsed.
      if (!line.startsWith("+") && !line.startsWith("-")) continue
      current = { header: "@@ -1 +1 @@", lines: [] }
      hunks.push(current)
    }
    if (line.startsWith("+")) {
      pushLine({ kind: "add", newNo, text: line.slice(1) })
      newNo++
      continue
    }
    if (line.startsWith("-")) {
      pushLine({ kind: "del", oldNo, text: line.slice(1) })
      oldNo++
      continue
    }
    if (line.startsWith(" ")) {
      pushLine({ kind: "context", oldNo, newNo, text: line.slice(1) })
      oldNo++
      newNo++
      continue
    }
    if (line === "\\ No newline at end of file" || line.startsWith("\\")) continue
    // Tolerate malformed context rows that lost their leading space.
    pushLine({ kind: "context", oldNo, newNo, text: line })
    oldNo++
    newNo++
  }

  if (hunks.length === 0) return undefined
  return { hunks, additions, deletions }
}

// Classical LCS table kept bounded — files beyond the cap collapse into a
// single replace hunk instead of stalling a phone CPU.
const SYNTH_LINE_CAP = 2000

function isShortEnough(a: string[], b: string[]) {
  return a.length + b.length <= SYNTH_LINE_CAP
}

function lcsTable(a: string[], b: string[]): Uint16Array {
  const width = b.length + 1
  const table = new Uint16Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!)
    }
  }
  return table
}

type RawChange = { kind: "add" | "del" | "context"; text: string }

function diffLines(a: string[], b: string[]): RawChange[] {
  if (!isShortEnough(a, b)) {
    return [
      ...a.map((text): RawChange => ({ kind: "del", text })),
      ...b.map((text): RawChange => ({ kind: "add", text })),
    ]
  }
  const table = lcsTable(a, b)
  const width = b.length + 1
  const out: RawChange[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "context", text: a[i]! })
      i++
      j++
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      out.push({ kind: "del", text: a[i]! })
      i++
    } else {
      out.push({ kind: "add", text: b[j]! })
      j++
    }
  }
  while (i < a.length) out.push({ kind: "del", text: a[i++]! })
  while (j < b.length) out.push({ kind: "add", text: b[j++]! })
  return out
}

export function splitLines(text: string): string[] {
  if (!text) return []
  const normalized = text.replace(/\r\n?/g, "\n")
  const lines = normalized.split("\n")
  if (lines.length && lines[lines.length - 1] === "") lines.pop()
  return lines
}

// Builds a pseudo unified diff from two full file contents so edit tools whose
// metadata carries before/after (but no server patch) still render a real diff.
export function synthesizeDiff(before: string, after: string): ParsedDiff | undefined {
  if (!before && !after) return undefined
  const changes = diffLines(splitLines(before), splitLines(after))
  const additions = changes.filter((c) => c.kind === "add").length
  const deletions = changes.filter((c) => c.kind === "del").length
  if (additions === 0 && deletions === 0) return undefined

  // Collapse long unchanged runs around edits into standard 3-line context.
  const CONTEXT = 3
  const keep = new Array(changes.length).fill(false)
  changes.forEach((change, index) => {
    if (change.kind === "context") return
    for (let k = Math.max(0, index - CONTEXT); k <= Math.min(changes.length - 1, index + CONTEXT); k++) keep[k] = true
  })

  let oldNo = 1
  let newNo = 1
  const hunks: DiffHunk[] = []
  let current: DiffHunk | undefined
  const flush = () => {
    current = undefined
  }

  changes.forEach((change, index) => {
    if (!keep[index]) {
      if (current) flush()
      if (change.kind !== "context") return
      oldNo++
      newNo++
      return
    }
    if (!current) {
      current = { header: `@@ -${oldNo} +${newNo} @@`, lines: [] }
      hunks.push(current)
    }
    if (change.kind === "add") {
      current.lines.push({ kind: "add", newNo, text: change.text })
      newNo++
    } else if (change.kind === "del") {
      current.lines.push({ kind: "del", oldNo, text: change.text })
      oldNo++
    } else {
      current.lines.push({ kind: "context", oldNo, newNo, text: change.text })
      oldNo++
      newNo++
    }
  })

  if (hunks.length === 0) return undefined
  return { hunks, additions, deletions }
}
