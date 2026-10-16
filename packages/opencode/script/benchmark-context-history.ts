/**
 * Read-only synthetic benchmark for cold V1 Context history.
 *
 * Run from packages/opencode:
 *   bun script/benchmark-context-history.ts 5000
 *   bun script/benchmark-context-history.ts 5000 --no-compaction
 *
 * Generates a temporary SQLite database, never touches the running sidecar,
 * and compares the old stream+filter reader to streamCompacted using exactly
 * the same durable messages and compaction-tail semantics.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { MessageV2 } from "../src/session/message-v2"
import { ContextInspection } from "../src/session/context/inspection"
import { readPage as readContextLedgerPage } from "../src/session/context/page"
import { readTotals as readContextLedgerTotals } from "../src/session/context/totals"
import { SessionID } from "../src/session/schema"

const count = Math.max(100, Math.min(40_000, Number(process.argv[2] ?? 5000) || 5000))
const withCompaction = !process.argv.includes("--no-compaction")
const repeats = 5
const folder = mkdtempSync(join(tmpdir(), "openfork-context-perf-"))
const dbFile = join(folder, "context.db")
const sessionID = SessionID.make("ses_context_benchmark")
const padding = (value: number) => String(value).padStart(7, "0")
const user = (id: string, created: number) => JSON.stringify({
  id, sessionID, role: "user", time: { created },
})
const assistant = (id: string, created: number, parentID: string) => JSON.stringify({
  id, sessionID, role: "assistant", time: { created }, parentID,
  summary: withCompaction, finish: "stop",
})
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

try {
  const output = await Effect.runPromise(Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.run(sql`
      INSERT INTO project (id, worktree, name, sandboxes, time_created, time_updated)
      VALUES ('p_context_benchmark', '/context-benchmark', 'context-benchmark', '[]', 1000, 1000)
    `)
    yield* db.run(sql`
      INSERT INTO session (id, project_id, directory, slug, title, version, time_created, time_updated)
      VALUES (${sessionID}, 'p_context_benchmark', '/context-benchmark', 'context-benchmark', 'Context benchmark', '1', 1000, 1000)
    `)

    // Bounded inserts; only 100 rows / 500 bind parameters per SQLite batch.
    for (let offset = 0; offset < count; offset += 100) {
      const batch = Array.from({ length: Math.min(100, count - offset) }, (_, index) => {
        const n = offset + index
        const id = `msg_bench_old_${padding(n)}`
        const time = 1000 + n
        return sql`(${id}, ${sessionID}, ${time}, ${time}, ${user(id, time)})`
      })
      yield* db.run(sql`
        INSERT INTO message (id, session_id, time_created, time_updated, data)
        VALUES ${sql.join(batch, sql`, `)}
      `)
    }

    const tail = Array.from({ length: 15 }, (_, n) => {
      const id = `msg_bench_tail_${padding(n)}`
      const time = count + 2000 + n
      return sql`(${id}, ${sessionID}, ${time}, ${time}, ${user(id, time)})`
    })
    const boundary = "msg_bench_compaction"
    const summary = "msg_bench_summary"
    const latest = "msg_bench_new"
    const t = count + 3000
    yield* db.run(sql`
      INSERT INTO message (id, session_id, time_created, time_updated, data)
      VALUES ${sql.join([
        ...tail,
        sql`(${boundary}, ${sessionID}, ${t}, ${t}, ${user(boundary, t)})`,
        sql`(${summary}, ${sessionID}, ${t + 1}, ${t + 1}, ${assistant(summary, t + 1, boundary)})`,
        sql`(${latest}, ${sessionID}, ${t + 2}, ${t + 2}, ${user(latest, t + 2)})`,
      ], sql`, `)}
    `)
    if (withCompaction) {
      yield* db.run(sql`
        INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
        VALUES ('prt_bench_compaction', ${boundary}, ${sessionID}, ${t}, ${t},
          ${JSON.stringify({ type: "compaction", tail_start_id: "msg_bench_tail_0000000" })})
      `)
    }

    const baseline = () => MessageV2.stream(sessionID).pipe(Effect.map(MessageV2.filterCompacted))
    const optimized = () => MessageV2.streamCompacted(sessionID)
    const inspection = () => ContextInspection.read(sessionID)
    const ledgerPage = () => readContextLedgerPage({ sessionID, limit: 50 })
    const ledgerTotals = () => readContextLedgerTotals(sessionID)
    const reference = yield* baseline()
    const newer = yield* optimized()
    if (JSON.stringify(reference) !== JSON.stringify(newer))
      throw new Error("Effective-history equivalence failed")
    const firstInspection = yield* inspection()
    if (JSON.stringify(firstInspection.messages) !== JSON.stringify(reference))
      throw new Error("Adaptive inspection diverged from canonical history")
    const initialPage = yield* ledgerPage()
    if (initialPage.entries.length !== Math.min(50, reference.length))
      throw new Error("Ledger first page cardinality mismatch")

    const original: number[] = []
    const bounded: number[] = []
    const inspected: number[] = []
    const ledgerPaged: number[] = []
    const ledgerAggregated: number[] = []
    for (let i = 0; i < repeats; i++) {
      // Alternate order to reduce systematic warm-cache/scheduling bias.
      for (const mode of i % 2
        ? ["inspection", "bounded", "original"] as const
        : ["original", "bounded", "inspection"] as const) {
        const started = performance.now()
        const history = mode === "inspection"
          ? (yield* inspection()).messages
          : yield* (mode === "original" ? baseline() : optimized())
        const elapsed = performance.now() - started
        if (history.length !== reference.length) throw new Error("Length mismatch")
        ;(mode === "original" ? original : mode === "bounded" ? bounded : inspected).push(elapsed)
      }
      const startedPage = performance.now()
      const firstPage = yield* ledgerPage()
      if (firstPage.entries.length !== Math.min(50, reference.length))
        throw new Error("Inconsistent ledger first page cardinality")
      ledgerPaged.push(performance.now() - startedPage)
      const startedTotals = performance.now()
      const totals = yield* ledgerTotals()
      if (!withCompaction && totals.totals?.messageCount !== count + 18)
        throw new Error("Authoritative Context totals lost physical V1 messages")
      ledgerAggregated.push(performance.now() - startedTotals)
    }
    const originalMs = median(original)
    const boundedMs = median(bounded)
    return {
      compaction: withCompaction,
      totalMessages: count + 18,
      effectiveMessages: reference.length,
      oldMedianMs: Number(originalMs.toFixed(3)),
      optimizedMedianMs: Number(boundedMs.toFixed(3)),
      inspectionMedianMs: Number(median(inspected).toFixed(3)),
      firstPageMedianMs: Number(median(ledgerPaged).toFixed(3)),
      totalsMedianMs: Number(median(ledgerAggregated).toFixed(3)),
      speedup: Number((originalMs / boundedMs).toFixed(2)),
      inspectionSpeedup: Number((originalMs / median(inspected)).toFixed(2)),
      samples: { original, bounded, inspected, ledgerPaged, ledgerAggregated },
    }
  }).pipe(Effect.provide(Database.layerFromPath(dbFile))))
  console.log(JSON.stringify(output, null, 2))
} finally {
  rmSync(folder, { recursive: true, force: true })
}
