import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"

test("file-backed foreground, control and maintenance writers never run automatic checkpoints on COMMIT", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openfork-checkpoint-owner-"))
  const filename = join(directory, "checkpoints.sqlite")
  try {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Database.Service
          const readThreshold = (db: Database.DatabaseShape) =>
            db.get<{ wal_autocheckpoint: number }>("PRAGMA wal_autocheckpoint")
          const primary = yield* readThreshold(service.db)
          const control = yield* readThreshold(service.controlDb ? yield* service.controlDb() : service.db)
          const maintenance = yield* Database.withBackfillDb(
            filename,
            (db) => readThreshold(db),
            { busyTimeoutMs: 0 },
          )
          return { primary, control, maintenance }
        }).pipe(Effect.provide(Database.layerFromPath(filename))),
      ),
    )
    expect(result.primary?.wal_autocheckpoint).toBe(0)
    expect(result.control?.wal_autocheckpoint).toBe(0)
    expect(result.maintenance?.wal_autocheckpoint).toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 })
  }
}, 20_000)
