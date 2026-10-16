import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { Database } from "../../src/database/database"

test("48 primary writes, 24 control reads, and 12 scans finish with correct durable rows and no stranded permits", async () => {
  const dir=await mkdtemp(join(tmpdir(),"openfork-sqlite-3lane-stress-"))
  try {
    const elapsed=await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { db, controlDb, withScanDb }=yield* Database.Service
      if (!withScanDb || !controlDb) throw Error("Expected production lease and control lanes")
      yield* db.run("CREATE TABLE lane_stress(id INTEGER PRIMARY KEY, value INTEGER NOT NULL)")
      const begin=performance.now()
      const writes=Effect.forEach(Array.from({length:48},(_,i)=>i+1),
        (id)=>db.run(`INSERT INTO lane_stress(id,value) VALUES (${id},${id*2})`),
        {concurrency:12,discard:true})
      const controls=Effect.forEach(Array.from({length:24},(_,i)=>i),
        ()=>Effect.flatMap(controlDb(), conn=>conn.get("SELECT count(*) AS count FROM lane_stress")),
        {concurrency:8,discard:true})
      const recalls=Effect.forEach(Array.from({length:12},(_,i)=>i),
        ()=>withScanDb(conn=>conn.get(`WITH RECURSIVE r(x) AS (
          SELECT 0 UNION ALL SELECT x+1 FROM r WHERE x<100000
        ) SELECT sum(x) AS result FROM r`)),{concurrency:4,discard:true})
      yield* Effect.all([writes,controls,recalls],{concurrency:3,discard:true})
        .pipe(Effect.timeout("12 seconds"))
      const count=yield* db.get<{count:number,total:number}>(
        "SELECT count(*) AS count, sum(value) AS total FROM lane_stress")
      expect(count).toEqual({count:48,total:2352})
      return performance.now()-begin
    }).pipe(Effect.provide(Database.layerFromPath(join(dir,"stress.sqlite"))))))
    console.log("three-lane-stress elapsed_ms="+elapsed.toFixed(1)+" writes=48 controls=24 scans=12")
    expect(elapsed).toBeLessThan(12_000)
  } finally {
    await rm(dir,{recursive:true,force:true,maxRetries:8,retryDelay:90})
  }
},25_000)
