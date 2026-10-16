import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "../../src/database/database"
import { SessionInspection } from "../../src/session/inspection"

/**
 * Fail closed if full-text search/recall regresses to the primary or the
 * latency-sensitive interactive SQLite connection. A long native FTS SELECT
 * must own only a leased, dedicated scan worker's permit.
 */
describe("session search SQLite connection isolation", () => {
  test("search and recall execute all SQL on a scan lease, not the interactive reader", async () => {
    let interactiveQueries = 0
    let scanQueries = 0
    let leases = 0
    const interactive = {
      all: () => { interactiveQueries++; return Effect.succeed([]) },
      select: () => { interactiveQueries++; throw new Error("interactive SELECT used") },
    }
    const scan = {
      all: () => { scanQueries++; return Effect.succeed([]) },
      select: () => ({
        from: () => ({
          where: () => ({
            get: () => { scanQueries++; return Effect.succeed({ done: 1 }) },
          }),
        }),
      }),
    }
    const database = {
      readDb: interactive,
      withScanDb: <A, E, R>(body: (reader: Database.DatabaseShape) => Effect.Effect<A, E, R>) => {
        leases++
        return body(scan as never)
      },
      // Intentionally do not expose a primary connection: accidental access
      // must fail rather than silently fall back to an unsafe lane.
    } as never
    const implementation = SessionInspection.node.implementation as Layer.Layer<
      SessionInspection.Service,
      never,
      Database.Service
    >
    const provider = Layer.provide(
      implementation,
      Layer.succeed(Database.Service, database),
    )
    const service = await Effect.runPromise(
      Effect.provide(SessionInspection.Service, provider),
    )
    const scope = { query: "needle", directoryPrefixes: ["/approved"], limit: 10 }
    await Effect.runPromise(service.search(scope))
    await Effect.runPromise(service.recall(scope))
    expect(interactiveQueries).toBe(0)
    expect(leases).toBe(2)
    expect(scanQueries).toBeGreaterThanOrEqual(6)
  })
})
