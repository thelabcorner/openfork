import { expect, test } from "bun:test"
import { Database as BunSqlite } from "bun:sqlite"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteScanProcessClient } from "../../src/database/sqlite-scan-process"

test("read-only scanner admission blocks hidden CTE DML and external ATTACH without false positives in SQL literals", async () => {
  const folder=await mkdtemp(join(tmpdir(),"openfork-isolated-authorizer-"))
  const filename=join(folder,"main.sqlite")
  const escaped=join(folder,"unauthorized.sqlite")
  const seed=new BunSqlite(filename)
  seed.run("CREATE TABLE witness(v INTEGER NOT NULL)")
  seed.run("INSERT INTO witness VALUES(1)")
  seed.close()
  // On Windows Bun's prepared-statement cache may retain closed SQLite file
  // handles until GC, independently of the isolated subprocess lifecycle.
  Bun.gc(true)
  const reader=new SqliteScanProcessClient({filename,readonly:true,permitLane:"scan",queryTimeoutMs:3_000})
  const query=(sql:string)=>reader.request({
    kind:"query",query:sql,params:[],arrays:false,safeIntegers:false,
  })
  try {
    await reader.ready
    await expect(query("WITH x(v) AS (SELECT 99) INSERT INTO witness SELECT v FROM x"))
      .rejects.toThrow(/Read-only scan SQL admission rejected WITH/i)
    await expect(query(`EXPLAIN ATTACH DATABASE '${escaped.replaceAll("'","''")}' AS sneaky`))
      .rejects.toThrow(/Read-only scan SQL admission rejected EXPLAIN/i)
    await expect(stat(escaped)).rejects.toMatchObject({code:"ENOENT"})
    expect(await query("SELECT count(*) AS count FROM witness")).toEqual([{count:1}])
    // Reader setup stays legal, while checkpoint/administrative PRAGMAs and
    // attempted per-connection relaxation are rejected *before* worker IPC.
    await query("PRAGMA query_only = ON")
    await query("PRAGMA busy_timeout = 250")
    await query("PRAGMA cache_size = -32000")
    await query("PRAGMA foreign_keys = ON")
    expect(await query("PRAGMA table_info(witness)")).toHaveLength(1)
    for (const hostile of [
      "PRAGMA query_only = OFF",
      "PRAGMA wal_checkpoint(TRUNCATE)",
      "PRAGMA journal_mode = DELETE",
      "PRAGMA writable_schema = ON",
      "PRAGMA busy_timeout = 500000",
      "PRAGMA cache_size = -4000000",
      "PRAGMA data_version; VACUUM INTO 'rogue.db'",
    ]) {
      await expect(query(hostile)).rejects.toMatchObject({code:"SQLITE_SCAN_READONLY_ADMISSION"})
    }
    expect(await query("WITH x(v) AS (SELECT 'UPDATE' /* DELETE */) SELECT v FROM x"))
      .toEqual([{v:"UPDATE"}])
  } finally {
    await reader.close()
    await rm(folder,{recursive:true,force:true,maxRetries:5,retryDelay:75})
  }
},10_000)
