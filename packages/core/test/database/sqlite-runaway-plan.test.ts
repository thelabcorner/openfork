import { describe, expect, test } from "bun:test"
import { SqliteWorkerClient } from "../../src/database/sqlite-worker-client"
import { SqliteBunWorkerClient } from "../../src/database/sqlite-bun-worker-client"
import {
  sqliteFingerprint,
  sqlitePlanProbeFingerprint,
  summarizeSqlitePlan,
} from "../../src/database/sqlite-query-forensics"

type Reader = {
  ready: Promise<void>
  request(request: {
    kind: "query"
    query: string
    params: ReadonlyArray<unknown>
    arrays: boolean
    safeIntegers: boolean
    diagnosePlan?: string
  }): Promise<unknown>
  close(): Promise<void>
}

async function exercise(
  create: (sink: (entry: unknown) => void) => Reader,
) {
  const messages: unknown[] = []
  const worker = create((entry) => messages.push(entry))
  try {
    await worker.ready
    const run = (query: string, params: ReadonlyArray<unknown> = [], diagnosePlan?: string) =>
      worker.request({ kind: "query", query, params, arrays: false, safeIntegers: false, diagnosePlan })
    await run("CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
    await run("CREATE INDEX probe_value_idx ON probe(value)")
    await run("INSERT INTO probe VALUES (1, 'first'), (2, 'second')")
    const first = await run("SELECT id FROM probe WHERE value = ?", ["second"], "synthetic-plan-hash")
    expect(first).toEqual([{ id: 2 }])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      hash: "synthetic-plan-hash",
      steps: 1,
      searches: 1,
      scans: 0,
      status: "ok",
    })
    // Repeating the shape must not spam process-level incident logs.
    await run("SELECT id FROM probe WHERE value = ?", ["first"], "synthetic-plan-hash")
    expect(messages).toHaveLength(1)
    const normal = await run("SELECT id FROM probe ORDER BY id")
    expect(normal).toEqual([{ id: 1 }, { id: 2 }])
    // An unavailable plan never blocks the actual query execution.
    const diagnostic = await run("SELECT id FROM probe", [], "another-plan-hash")
    expect(diagnostic).toHaveLength(2)
    expect(messages).toHaveLength(2)
    expect(JSON.stringify(messages)).not.toContain("probe_value_idx")
    expect(JSON.stringify(messages)).not.toContain("first")
    expect(JSON.stringify(messages)).not.toContain("second")
  } finally {
    await worker.close()
  }
}

describe("privacy-safe runaway SQLite plan probes", () => {
  test("Node native worker retains query correctness and reports index/scan plan once", () =>
    exercise((sink) => new SqliteWorkerClient({
      filename: ":memory:", checkpointOnClose: false, disableWAL: true,
    }, sink)),
  )

  test("Bun native worker retains query correctness and reports index/scan plan once", () =>
    exercise((sink) => new SqliteBunWorkerClient({
      filename: ":memory:", checkpointOnClose: false, disableWAL: true,
    }, sink)),
  )

  test("fingerprints retain the historical sampling algorithm and require exact bad-shape pairs", () => {
    expect(sqliteFingerprint("SELECT 1")).toBe(sqliteFingerprint("SELECT 1"))
    expect(sqliteFingerprint("SELECT 1")).not.toBe(sqliteFingerprint("SELECT 2"))
    expect(sqlitePlanProbeFingerprint("SELECT 1")).toBeUndefined()
    expect(sqlitePlanProbeFingerprint("x".repeat(1065))).toBeUndefined()
    expect(summarizeSqlitePlan("test", [
      { detail: "SCAN secret_table" },
      { detail: "SEARCH private_table USING COVERING INDEX private_index" },
      { detail: "USE TEMP B-TREE FOR ORDER BY" },
    ])).toEqual({
      hash: "test", steps: 3, scans: 1, searches: 1, tempSorts: 1,
      covering: 1, automaticIndexes: 0, status: "ok",
    })
  })
})
