import { test, expect } from "bun:test"
import { Database as Native } from "bun:sqlite"
import { mkdtemp, rm, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteScanProcessClient } from "../../src/database/sqlite-scan-process"

const runaway = `WITH RECURSIVE n(x) AS (
  SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < 700000000
) SELECT sum(x) FROM n`

test("expired scanners fully relinquish SQLite handles before close returns, including after recovery", async () => {
  for (let iteration = 0; iteration < 8; iteration++) {
    const dir = await mkdtemp(join(tmpdir(), "openfork-scan-reap-"))
    const file = join(dir, "proof.db")
    const seed = new Native(file)
    seed.exec("PRAGMA journal_mode=WAL; CREATE TABLE proof(x INTEGER); INSERT INTO proof VALUES(90)")
    seed.close()
    // Prevent Bun's own local prepared-statement cache from impersonating
    // an orphaned subprocess handle in this Windows file deletion test.
    Bun.gc(true)
    const client = new SqliteScanProcessClient({
      filename:file,readonly:true,permitLane:"scan",queryTimeoutMs:120,
    })
    try {
      await client.ready
      const run = (query:string) => client.request({
        kind:"query" as const, query, params:[], arrays:false, safeIntegers:false,
      })
      await expect(run(runaway)).rejects.toMatchObject({code:"SQLITE_SCAN_DEADLINE"})
      // Force recovery to race against the terminated process' real exit.
      expect(await run("SELECT x FROM proof")).toEqual([{x:90}])
      await expect(run(runaway)).rejects.toMatchObject({code:"SQLITE_SCAN_DEADLINE"})
      await client.close()
      // Windows open-handle deletion is strong evidence that both generations
      // were reaped, not just that kill() was requested.
      await unlink(file)
      await rm(dir, {recursive:true,force:true,maxRetries:2,retryDelay:20})
    } finally {
      await client.close()
      await rm(dir, {recursive:true,force:true,maxRetries:2,retryDelay:20})
    }
  }
}, 30_000)
