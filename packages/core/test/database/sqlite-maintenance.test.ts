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
})
