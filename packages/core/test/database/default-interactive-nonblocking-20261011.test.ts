import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber } from "effect"
import { Database } from "../../src/database/database"

const expensive = `WITH RECURSIVE n(x) AS (
  VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 3500000
) SELECT sum(x) AS total FROM n`

test("file-backed interactive reader defaults to asynchronous execution; long SQL cannot freeze controls", async () => {
  const dir=await mkdtemp(join(tmpdir(),"openfork-interactive-default-"))
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const {readDb,db}=yield* Database.Service
      yield* db.run("CREATE TABLE instant(v INTEGER NOT NULL)")
      yield* db.run("INSERT INTO instant VALUES(112)")
      const slow=yield* readDb.get<{total:number}>(expensive).pipe(Effect.forkScoped)
      yield* Effect.sleep("20 millis")
      const now=performance.now()
      // During a native SELECT the control event loop must still make progress.
      yield* Effect.sleep("40 millis")
      const delay=performance.now()-now
      expect(delay).toBeLessThan(200)
      const result=yield* Fiber.join(slow)
      expect(result?.total).toBe(6_125_001_750_000)
      expect(yield* db.get<{v:number}>("SELECT v FROM instant")).toEqual({v:112})
    }).pipe(Effect.provide(Database.layerFromPath(join(dir,"fixture.sqlite"))))))
  } finally {
    await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:65})
  }
},20_000)
