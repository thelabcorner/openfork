import { expect, test } from "bun:test"
import { Database as Native } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { layer as bunWorkerLayer } from "../../src/database/sqlite.bun-worker"

test("Bun's real read-only Effect SQL adapter uses killable subprocess, survives timeout and can cancel", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openfork-bun-killable-integration-"))
  const filename = join(dir, "probe.sqlite")
  const seed = new Native(filename)
  seed.exec("PRAGMA journal_mode=WAL; CREATE TABLE witness(v INTEGER NOT NULL); INSERT INTO witness VALUES (301)")
  seed.close()
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      expect(yield* db.get<{v:number}>("SELECT v FROM witness")).toEqual({v:301})
      const started=performance.now()
      const timeout=yield* Effect.exit(db.get(`WITH RECURSIVE r(x) AS (
        SELECT 0 UNION ALL SELECT x+1 FROM r WHERE x < 800000000
      ) SELECT sum(x) AS sum FROM r`))
      expect(Exit.isFailure(timeout)).toBe(true)
      expect(performance.now()-started).toBeLessThan(2500)
      expect(yield* db.get<{v:number}>("SELECT v FROM witness")).toEqual({v:301})
      const entered=yield* Deferred.make<void>()
      const slow=yield* Effect.gen(function* () {
        yield* Deferred.succeed(entered,undefined)
        return yield* db.get(`WITH RECURSIVE r(x) AS (
          SELECT 0 UNION ALL SELECT x+1 FROM r WHERE x < 800000000
        ) SELECT sum(x) AS sum FROM r`)
      }).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      yield* Effect.sleep("55 millis")
      const cancelStart=performance.now()
      yield* Fiber.interrupt(slow)
      expect(performance.now()-cancelStart).toBeLessThan(900)
      expect(yield* db.get<{v:number}>("SELECT v FROM witness")).toEqual({v:301})
    }).pipe(Effect.provide(bunWorkerLayer({
      filename,readonly:true,permitLane:"scan",disableWAL:true,
      checkpointOnClose:false,queryTimeoutMs:300,
    })))))
  } finally {
    await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50})
  }
},20_000)
