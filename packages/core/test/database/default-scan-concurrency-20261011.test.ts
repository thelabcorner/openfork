import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Fiber } from "effect"
import { Database } from "../../src/database/database"

test("the default file-backed scanner admits two independent reads under a pinned analytics lease", async () => {
  const dir=await mkdtemp(join(tmpdir(),"openfork-default-scan-"))
  try {
    await Effect.runPromise(Effect.scoped(
      Effect.gen(function* () {
        const {db,withScanDb}=yield* Database.Service
        expect(withScanDb).toBeDefined()
        yield* db.run("CREATE TABLE scan_probe(v INTEGER NOT NULL)")
        yield* db.run("INSERT INTO scan_probe VALUES (73)")
        const entered=yield* Deferred.make<void>()
        const release=yield* Deferred.make<void>()
        // This keeps an entire scan lease pinned, just like a pathological
        // query; a second short search must not queue behind this connection.
        const pinned=yield* withScanDb!((conn)=>Effect.gen(function*(){
          const row=yield* conn.get<{v:number}>("SELECT v FROM scan_probe")
          yield* Deferred.succeed(entered,undefined)
          yield* Deferred.await(release)
          return row
        })).pipe(Effect.forkScoped)
        yield* Deferred.await(entered)
        const started=performance.now()
        const other=yield* withScanDb!((conn)=>conn.get<{v:number}>("SELECT v FROM scan_probe"))
          .pipe(Effect.timeout("2 seconds"))
        const elapsed=performance.now()-started
        expect(other).toEqual({v:73})
        expect(elapsed).toBeLessThan(1000)
        yield* Deferred.succeed(release,undefined)
        expect(yield* Fiber.join(pinned)).toEqual({v:73})
      }).pipe(Effect.provide(Database.layerFromPath(join(dir,"pool.sqlite")))),
    ))
  } finally {
    await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:75})
  }
},20_000)
