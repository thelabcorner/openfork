import { expect, test } from "bun:test"
import { Database as BunSqlite } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteScanProcessClient } from "../../src/database/sqlite-scan-process"

test("native read-only SELECT is forcibly terminated; the next request reopens a safe connection", async () => {
  const dir=await mkdtemp(join(tmpdir(),"openfork-hard-query-budget-"))
  const file=join(dir,"probe.sqlite")
  const seed=new BunSqlite(file)
  seed.exec("CREATE TABLE witness(value INTEGER NOT NULL); INSERT INTO witness VALUES (42); PRAGMA journal_mode=WAL")
  seed.close()
  const client=new SqliteScanProcessClient({
    filename:file,permitLane:"scan",readonly:true,queryTimeoutMs:350,
    checkpointOnClose:false,disableWAL:true,
  })
  const query=(text:string) => client.request({
    kind:"query",query:text,params:[],arrays:false,safeIntegers:false,
  }) as Promise<Array<Record<string,number>>>
  try {
    await client.ready
    expect(await query("SELECT value FROM witness")).toEqual([{value:42}])
    const started=performance.now()
    await expect(query(`WITH RECURSIVE r(x) AS (
      SELECT 1 UNION ALL SELECT x+1 FROM r WHERE x < 500000000
    ) SELECT sum(x) AS result FROM r`)).rejects.toMatchObject({
      code:"SQLITE_SCAN_DEADLINE",name:"SqliteScanDeadlineExceeded",
    })
    expect(performance.now()-started).toBeLessThan(2500)
    // A new connection is spawned after the timed-out worker was killed.
    expect(await query("SELECT value FROM witness")).toEqual([{value:42}])
    // IPC must retain native precision and blobs; JSON serialization would
    // silently fail on 64-bit SQLite integers after moving out of process.
    const rich = await client.request({
      kind:"query",query:"SELECT ? AS big, ? AS bytes",
      params:[9007199254740993n, Buffer.from([0, 1, 254, 255])],
      arrays:false,safeIntegers:true,
    }) as Array<{big:bigint;bytes:Uint8Array}>
    expect(rich[0]?.big).toBe(9007199254740993n)
    expect(Array.from(rich[0]!.bytes)).toEqual([0, 1, 254, 255])
    // SQLite itself must reject writes; never trust mutable PRAGMA query_only.
    await expect(query("INSERT INTO witness VALUES (99)")).rejects.toThrow()
    expect(await query("SELECT count(*) AS n FROM witness")).toEqual([{n:1}])
    expect(client.activitySnapshot()).toContain("processStage=idle")
  } finally {
    await client.close()
    await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:70})
  }
},20_000)

test("write-capable lanes cannot instantiate a killable process", () => {
  expect(() => new SqliteScanProcessClient({filename:":memory:",permitLane:"primary",readonly:false})).toThrow(
    "restricted to approved read-only lanes",
  )
})

test("a runaway native SELECT does not starve a second scanner or a concurrent WAL writer", async () => {
  const dir=await mkdtemp(join(tmpdir(),"openfork-hard-scan-parallel-"))
  const file=join(dir,"parallel.sqlite")
  const db=new BunSqlite(file)
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE proof(v INTEGER NOT NULL); INSERT INTO proof VALUES (10)")
  const slow=new SqliteScanProcessClient({
    filename:file,permitLane:"scan",readonly:true,queryTimeoutMs:600,
  })
  const fast=new SqliteScanProcessClient({
    filename:file,permitLane:"scan-pool",readonly:true,queryTimeoutMs:600,
  })
  const query=(client:SqliteScanProcessClient,text:string)=>client.request({
    kind:"query",query:text,params:[],arrays:false,safeIntegers:false,
  }) as Promise<Array<Record<string,number>>>
  try {
    await Promise.all([slow.ready,fast.ready])
    const runaway=query(slow,`WITH RECURSIVE r(n) AS (
      SELECT 0 UNION ALL SELECT n+1 FROM r WHERE n < 900000000
    ) SELECT sum(n) AS total FROM r`).then(
      () => "unexpected-success",
      (reason) => (reason as { code?:string }).code,
    )
    await new Promise((resolve)=>setTimeout(resolve,35))
    const started=performance.now()
    expect(await query(fast,"SELECT v FROM proof")).toEqual([{v:10}])
    db.exec("UPDATE proof SET v = 11")
    expect(await query(fast,"SELECT v FROM proof")).toEqual([{v:11}])
    expect(performance.now()-started).toBeLessThan(450)
    expect(await runaway).toBe("SQLITE_SCAN_DEADLINE")
    expect(await query(slow,"SELECT v FROM proof")).toEqual([{v:11}])
  } finally {
    await Promise.all([slow.close(),fast.close()])
    db.close()
    await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50})
  }
},20_000)

test("Bun-native subprocess can host the same killable SQLite VM without external Node installation", async () => {
  if (!process.versions.bun) return
  const dir=await mkdtemp(join(tmpdir(),"openfork-bun-child-"))
  const file=join(dir,"probe.sqlite")
  const db=new BunSqlite(file)
  db.exec("CREATE TABLE proof(v INTEGER NOT NULL); INSERT INTO proof VALUES (81)")
  db.close()
  const client=new SqliteScanProcessClient({
    filename:file,permitLane:"scan",readonly:true,
    processBinary:process.execPath,queryTimeoutMs:350,
  })
  const query=(q:string)=>client.request({kind:"query",query:q,params:[],arrays:false,safeIntegers:false}) as Promise<Array<{v:number}>>
  try {
    await client.ready
    expect(await query("SELECT v FROM proof")).toEqual([{v:81}])
    await expect(query(`WITH RECURSIVE r(n) AS (
      SELECT 0 UNION ALL SELECT n+1 FROM r WHERE n < 800000000
    ) SELECT sum(n) AS v FROM r`)).rejects.toMatchObject({code:"SQLITE_SCAN_DEADLINE"})
    expect(await query("SELECT v FROM proof")).toEqual([{v:81}])
  } finally {
    await client.close()
    await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50})
  }
},20_000)
