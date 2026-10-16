/**
 * Explicit, single bounded historical-FTS repair operation.
 *
 * Example:
 *   bun run script/repair-memory-session-index.ts --db <absolute-path-to-openfork.db> --rows 32
 *
 * This command is not run by memory queries, runtime startup, or UI reads.
 * A human/operator chooses when to spend a bounded write budget. It leverages
 * the existing SessionSearch single-chunk transactional cursor + own-connection
 * retry/timeout policy; no independent index migration implementation.
 */
import { existsSync } from "node:fs"
import { isAbsolute } from "node:path"
import { Effect } from "effect"
import { SessionSearch } from "@opencode-ai/core/session/search"

const args = process.argv.slice(2)
const option = (flag: string) => {
  const i = args.indexOf(flag)
  return i < 0 ? undefined : args[i + 1]
}
const db = option("--db")
const rowsRaw = option("--rows") ?? "32"
const timeoutRaw = option("--timeout-ms") ?? "2000"
const validInteger = (value: string, min: number, max: number) => {
  const n = Number(value)
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined
}
const rows = validInteger(rowsRaw, 1, 128)
const timeoutMs = validInteger(timeoutRaw, 100, 5_000)
if (!db || !isAbsolute(db) || !existsSync(db) || rows === undefined || timeoutMs === undefined) {
  console.error(
    "Usage: bun run script/repair-memory-session-index.ts --db <existing-absolute-db-path> " +
    "[--rows 1..128] [--timeout-ms 100..5000]",
  )
  process.exit(2)
}
const start = performance.now()
try {
  const result = await Effect.runPromise(SessionSearch.repairOnOwnConnection(db, {
    maxRows: rows,
    timeoutMs,
  }))
  const complete =
    result.sessionMessages.done && result.parts.done &&
    result.toolRecallV1.done && result.toolRecallV2.done
  console.log(JSON.stringify({
    action: "bounded-session-index-repair",
    rowsBudgetPerStore: rows,
    elapsedMs: Math.round(performance.now() - start),
    complete,
    ...result,
    note: "This is a single bounded repair pass. The absence of rows or incomplete cursors is not full index coverage.",
  }))
  process.exit(result.timedOut ? 3 : 0)
} catch {
  // Do not print file paths, database data, or query contents into CLI logs.
  console.error("Bounded session-index repair failed; verify database access and try another maintenance window.")
  process.exit(1)
}
