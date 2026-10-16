import { expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { layer as sqliteNodeLayer } from "../../src/database/sqlite.node"

test("real SqliteNode analytics layer kills runaway SELECT and recovers on its next query", async () => {
  const dir=await mkdtemp(join(tmpdir(),"openfork-sqlite-node-hard-scan-"))
  const filename=join(dir,"probe.sqlite")
  const seed=new SQLite(filename)
  seed.exec("CREATE TABLE proof(v INTEGER NOT NULL); INSERT INTO proof VALUES (7)")
  seed.close()
  try {
    await Effect.runPromise(Effect.scoped(
      Effect.gen(function* () {
        const reader=yield* EffectDrizzleSqlite.makeWithDefaults()
        expect(yield* reader.get<{v:number}>("SELECT v FROM proof")).toEqual({v:7})
        const began=performance.now()
        const result=yield* Effect.exit(reader.get(`WITH RECURSIVE r(n) AS (
          SELECT 1 UNION ALL SELECT n+1 FROM r WHERE n < 700000000
        ) SELECT sum(n) AS sum FROM r`))
        expect(Exit.isFailure(result)).toBe(true)
        expect(performance.now()-began).toBeLessThan(2500)
        expect(yield* reader.get<{v:number}>("SELECT v FROM proof")).toEqual({v:7})
        const writes=yield* Effect.exit(reader.run("INSERT INTO proof VALUES (99)"))
        expect(Exit.isFailure(writes)).toBe(true)
        expect(yield* reader.get<{count:number}>("SELECT COUNT(*) AS count FROM proof")).toEqual({count:1})
      }).pipe(Effect.provide(sqliteNodeLayer({
        filename, readonly:true,permitLane:"scan",disableWAL:true,
        checkpointOnClose:false, queryTimeoutMs:350,
      }))),
    ))
  } finally {
    await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50})
  }
},20_000)

test("cancelling an active read-only native SELECT releases the caller promptly and retains the database", async () => {
  const dir=await mkdtemp(join(tmpdir(),"openfork-sqlite-interrupt-scan-"))
  const filename=join(dir,"probe.sqlite")
  const seed=new SQLite(filename)
  seed.exec("CREATE TABLE proof(v INTEGER NOT NULL); INSERT INTO proof VALUES (101)")
  seed.close()
  try {
    await Effect.runPromise(Effect.scoped(
      Effect.gen(function* () {
        const reader=yield* EffectDrizzleSqlite.makeWithDefaults()
        const started=yield* Deferred.make<void>()
        const slow=yield* Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined)
          return yield* reader.get(`WITH RECURSIVE r(n) AS (
            SELECT 1 UNION ALL SELECT n+1 FROM r WHERE n < 800000000
          ) SELECT sum(n) AS total FROM r`)
        }).pipe(Effect.forkScoped)
        yield* Deferred.await(started)
        yield* Effect.sleep("75 millis")
        const before=performance.now()
        yield* Fiber.interrupt(slow)
        expect(performance.now()-before).toBeLessThan(500)
        expect(yield* reader.get<{v:number}>("SELECT v FROM proof")).toEqual({v:101})
      }).pipe(Effect.provide(sqliteNodeLayer({
        filename,readonly:true,permitLane:"scan",disableWAL:true,
        checkpointOnClose:false,queryTimeoutMs:5000,
      }))),
    ))
  } finally {
    await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:70})
  }
},20_000)

test("interrupting an in-flight read transaction cannot strand the read connection or WAL lease", async () => {
  const dir=await mkdtemp(join(tmpdir(),"openfork-sqlite-read-tx-kill-"))
  const filename=join(dir,"transaction.sqlite")
  const seed=new SQLite(filename)
  seed.exec("CREATE TABLE proof(v INTEGER NOT NULL); INSERT INTO proof VALUES (203)")
  seed.close()
  try {
    await Effect.runPromise(Effect.scoped(
      Effect.gen(function* () {
        const reader=yield* EffectDrizzleSqlite.makeWithDefaults()
        const started=yield* Deferred.make<void>()
        const slow=yield* reader.transaction((tx) => Effect.gen(function* () {
          expect(yield* tx.get<{v:number}>("SELECT v FROM proof")).toEqual({v:203})
          yield* Deferred.succeed(started, undefined)
          return yield* tx.get(`WITH RECURSIVE r(n) AS (
            SELECT 1 UNION ALL SELECT n+1 FROM r WHERE n < 800000000
          ) SELECT sum(n) AS total FROM r`)
        }), { behavior:"deferred" }).pipe(Effect.forkScoped)
        yield* Deferred.await(started)
        yield* Effect.sleep("75 millis")
        const before=performance.now()
        yield* Fiber.interrupt(slow)
        expect(performance.now()-before).toBeLessThan(2000)
        expect(yield* reader.get<{v:number}>("SELECT v FROM proof")).toEqual({v:203})
        expect(yield* reader.get<{count:number}>("SELECT COUNT(*) AS count FROM proof")).toEqual({count:1})
      }).pipe(Effect.provide(sqliteNodeLayer({
        filename,readonly:true,permitLane:"scan",disableWAL:true,
        checkpointOnClose:false,queryTimeoutMs:5000,
      }))),
    ))
  } finally {
    await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:70})
  }
},20_000)

test("interactive read-only lane survives a native SQLite C-loop without delaying its next lookup", async () => {
  const dir=await mkdtemp(join(tmpdir(),"openfork-sqlite-interactive-"))
  const filename=join(dir,"interactive.sqlite")
  const seed=new SQLite(filename)
  seed.exec("CREATE TABLE proof(v INTEGER NOT NULL); INSERT INTO proof VALUES (515)")
  seed.close()
  try {
    await Effect.runPromise(Effect.scoped(
      Effect.gen(function* () {
        const reader=yield* EffectDrizzleSqlite.makeWithDefaults()
        expect(yield* reader.get<{v:number}>("SELECT v FROM proof")).toEqual({v:515})
        const begin=performance.now()
        const timed=yield* Effect.exit(reader.get(`WITH RECURSIVE r(n) AS (
          SELECT 1 UNION ALL SELECT n+1 FROM r WHERE n < 750000000
        ) SELECT sum(n) AS total FROM r`))
        expect(Exit.isFailure(timed)).toBe(true)
        expect(performance.now()-begin).toBeLessThan(2500)
        expect(yield* reader.get<{v:number}>("SELECT v FROM proof")).toEqual({v:515})
      }).pipe(Effect.provide(sqliteNodeLayer({
        filename, readonly:true, permitLane:"interactive", disableWAL:true,
        checkpointOnClose:false, queryTimeoutMs:350,
      }))),
    ))
  } finally {
    await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:70})
  }
},20_000)
