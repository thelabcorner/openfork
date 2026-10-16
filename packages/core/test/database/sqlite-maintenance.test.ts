import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { DatabaseShape } from "../../src/database/database"
import { makeSqliteMaintenanceQuietGate } from "../../src/database/sqlite-maintenance"

describe("SQLite maintenance quiet gate", () => {
  test("pays one quiet observation and re-arms only after an external data_version change", async () => {
    let version = 1
    let reads = 0
    const db = {
      get: () => {
        reads++
        return Effect.succeed({ data_version: version })
      },
    } as unknown as DatabaseShape

    const gate = makeSqliteMaintenanceQuietGate(db, { quietMs: 12, pollMs: 2 })

    await Effect.runPromise(gate.wait())
    const afterInitial = reads
    expect(afterInitial).toBeGreaterThan(1)

    await Effect.runPromise(gate.wait())
    expect(reads - afterInitial).toBe(1)

    version++
    const beforeExternal = reads
    await Effect.runPromise(gate.wait())
    expect(reads - beforeExternal).toBeGreaterThan(1)
  })

  test.serial("wall-clock jumps never bypass or strand a monotonic quiet interval", async () => {
    let version = 1
    const original = Date.now
    let wallNow = original()
    Date.now = () => wallNow
    try {
      const db = {
        get: () => Effect.succeed({ data_version: version }),
      } as unknown as DatabaseShape
      const gate = makeSqliteMaintenanceQuietGate(db, { quietMs: 45, pollMs: 4 })
      await Effect.runPromise(gate.wait())

      wallNow += 3_600_000 // OS clock sync jumped forward an hour
      version++
      let started = performance.now()
      await Effect.runPromise(gate.wait().pipe(Effect.timeout(500)))
      expect(performance.now() - started).toBeGreaterThanOrEqual(35)

      wallNow -= 7_200_000 // OS clock sync jumped backward two hours
      version++
      started = performance.now()
      await Effect.runPromise(gate.wait().pipe(Effect.timeout(500)))
      const elapsed = performance.now() - started
      expect(elapsed).toBeGreaterThanOrEqual(35)
      expect(elapsed).toBeLessThan(400)
    } finally {
      Date.now = original
    }
  })
})
