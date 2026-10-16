import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber } from "effect"
import { Database } from "../../src/database/database"

test("file-backed primary worker is asynchronous by default: native sqlite3_step never blocks OXP JS controls", async () => {
  const dir=await mkdtemp(join(tmpdir(),"openfork-default-primary-worker-"))
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const {db,readDb}=yield* Database.Service
      yield* db.run("CREATE TABLE proof(v INTEGER NOT NULL)")
      yield* db.run("INSERT INTO proof VALUES (311)")
      const slow=yield* db.get<{total:number}>(`WITH RECURSIVE n(x) AS (
        VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 3500000
      ) SELECT sum(x) AS total FROM n`).pipe(Effect.forkScoped)
      yield* Effect.sleep("20 millis")
      const started=performance.now()
      yield* Effect.sleep("40 millis")
      const elapsed=performance.now()-started
      expect(elapsed).toBeLessThan(250)
      // Read-only connection is not admitted on the primary worker.
      expect(yield* readDb.get<{v:number}>("SELECT v FROM proof")).toEqual({v:311})
      expect((yield* Fiber.join(slow))?.total).toBe(6_125_001_750_000)
    }).pipe(Effect.provide(Database.layerFromPath(join(dir,"storage.sqlite"))))))
  } finally {
    await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50})
  }
},20_000)
