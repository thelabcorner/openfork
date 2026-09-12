import { readFile, stat } from "node:fs/promises"
import { extname } from "node:path"
import { DEFAULT_SPAD_CONFIG } from "../src/session/spad/config"
import { makeTurnPolicy } from "../src/session/spad/intent"
import { SpadSupervisor } from "../src/session/spad/supervisor"
import type { SpadAction } from "../src/session/spad/types"

const MAX_BYTES_PER_FILE = 128 * 1024
const MAX_FILES_PER_CLASS = 40

const extensionClass: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "jsx",
  ".md": "markdown",
  ".json": "json",
  ".jsonc": "jsonc",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
  ".sql": "sql",
  ".txt": "text",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
}

function runText(text: string): SpadAction | undefined {
  const sup = new SpadSupervisor(DEFAULT_SPAD_CONFIG)
  sup.beginTurn(makeTurnPolicy("Continue reviewing the repository content."))
  sup.startPart("text")
  for (let at = 0, i = 0; at < text.length; i++) {
    const size = [1, 7, 31, 127, 521][i % 5]!
    const action = sup.push(text.slice(at, at + size))
    if (action) return action
    at += size
  }
  return undefined
}

function isDestructive(action: SpadAction | undefined) {
  return action?.type === "recover" || action?.type === "abort"
}

const git = Bun.spawn(["git", "ls-files", "-z"], { cwd: "../..", stdout: "pipe", stderr: "pipe" })
const stdout = await new Response(git.stdout).text()
const stderr = await new Response(git.stderr).text()
const exit = await git.exited
if (exit !== 0) throw new Error(`git ls-files failed (${exit}): ${stderr}`)

const grouped = new Map<string, string[]>()
for (const file of stdout.split("\0")) {
  if (!file) continue
  const cls = extensionClass[extname(file).toLowerCase()]
  if (!cls) continue
  const list = grouped.get(cls) ?? []
  list.push(file)
  grouped.set(cls, list)
}

type Row = {
  class: string
  files: number
  codeUnits: number
  destructiveInterventions: number
  observations: number
}

const rows: Row[] = []
const incidents: Array<{
  file: string
  class: string
  action: string
  lane: string
  source: string
  period: number
  runStart: number
  runEnd: number
  runLength: number
  policyReason: string | null
}> = []
const observed: Array<{
  file: string
  class: string
  action: string
  lane: string
  source: string
  period: number
  runLength: number
  policyReason: string | null
}> = []

for (const [cls, files] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  const selected: string[] = []
  for (const file of files.sort()) {
    if (selected.length >= MAX_FILES_PER_CLASS) break
    const info = await stat(`../../${file}`).catch(() => undefined)
    if (!info?.isFile() || info.size === 0 || info.size > MAX_BYTES_PER_FILE) continue
    selected.push(file)
  }
  const row: Row = { class: cls, files: 0, codeUnits: 0, destructiveInterventions: 0, observations: 0 }
  for (const file of selected) {
    const text = await readFile(`../../${file}`, "utf8").catch(() => undefined)
    if (text === undefined || text.includes("\u0000")) continue
    const action = runText(text)
    row.files++
    row.codeUnits += text.length
    if (action) {
      row.observations++
      observed.push({
        file,
        class: cls,
        action: action.type,
        lane: action.detection.lane,
        source: action.detection.source,
        period: action.detection.period,
        runStart: action.detection.runStart,
        runEnd: action.detection.runEnd,
        runLength: action.detection.runLength,
        policyReason: action.policyReason ?? null,
      })
    }
    if (isDestructive(action)) {
      row.destructiveInterventions++
      incidents.push({
        file,
        class: cls,
        action: action!.type,
        lane: action!.detection.lane,
        source: action!.detection.source,
        period: action!.detection.period,
        runLength: action!.detection.runLength,
        policyReason: action!.policyReason ?? null,
      })
    }
  }
  if (row.files > 0) rows.push(row)
}

console.log(JSON.stringify({
  schemaVersion: 1,
  limits: { maxBytesPerFile: MAX_BYTES_PER_FILE, maxFilesPerClass: MAX_FILES_PER_CLASS },
  totals: {
    classes: rows.length,
    files: rows.reduce((sum, row) => sum + row.files, 0),
    codeUnits: rows.reduce((sum, row) => sum + row.codeUnits, 0),
    observations: rows.reduce((sum, row) => sum + row.observations, 0),
    destructiveInterventions: rows.reduce((sum, row) => sum + row.destructiveInterventions, 0),
  },
  classes: rows,
  observed,
  incidents,
}, null, 2))

if (incidents.length > 0) process.exitCode = 2
