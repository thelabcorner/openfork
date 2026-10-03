import { afterAll, describe, expect } from "bun:test"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import {
  observeYieldStatistic,
  statisticalKeyID,
  type YieldStatisticState,
} from "@opencode-ai/core/usage/yield-statistics"
import { Capacity } from "@/capacity/capacity"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const tmp = await tmpdir()
const databasePath = path.join(tmp.path, "capacity-cache-invalidation.db")

// File-backed on purpose. Capacity's usage cache is shared-database state, so a
// `:memory:` database could never reproduce the second-writer case.
const modelsDevStub = Layer.succeed(
  ModelsDev.Service,
  ModelsDev.Service.of({
    getCached: () => Effect.succeed({}),
    getForSelectedProvider: () => Effect.succeed({}),
    get: () => Effect.succeed({}),
    getDecisionModels: () => Effect.succeed({}),
    refresh: () => Effect.void,
  }),
)

const layer = LayerNode.compile(Capacity.node, [
  [Database.node, Database.layerFromPath(databasePath)],
  [ModelsDev.node, modelsDevStub],
])
const it = testEffect(layer)

afterAll(async () => {
  await tmp[Symbol.asyncDispose]()
})

const key = { providerID: "opencode-go", baseModelID: "deepseek-v4.1-flash" } as const

type Observation = { readonly sessionID: string; readonly completedAt: number; readonly input: number }

/**
 * A settlement committed by a different connection to the same database file —
 * i.e. the second OpenFork host that shares this database (Desktop sidecar plus
 * ACP, or another CLI). Raw SQL on purpose: an external writer has no access to
 * this process's `UsageRecord` service and therefore cannot advance its
 * in-memory revision.
 */
const commitFromAnotherHost = (observations: readonly Observation[]) => {
  const state = observations.reduce<YieldStatisticState | undefined>(
    (current, observation) =>
      observeYieldStatistic(current, {
        sessionID: observation.sessionID,
        completedAt: observation.completedAt,
        tokens: { input: observation.input, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
      }),
    undefined,
  )
  const updatedAt = Math.max(...observations.map((observation) => observation.completedAt))
  return Database.withBackfillDb(
    databasePath,
    (conn) =>
      conn
        .run(sql`
          INSERT OR REPLACE INTO usage_yield_stat
            (stat_key, provider_id, base_model_id, account_id, state, updated_at)
          VALUES (
            ${statisticalKeyID(key)},
            ${key.providerID},
            ${key.baseModelID},
            NULL,
            ${JSON.stringify(state)},
            ${updatedAt}
          )
        `)
        .pipe(Effect.orDie),
    { busyTimeoutMs: 1_000 },
  ).pipe(Effect.orDie)
}

describe("Capacity usage cache invalidation", () => {
  it.live("serves the memoized projection while no other host commits", () =>
    Effect.gen(function* () {
      const capacity = yield* Capacity.Service

      const first = yield* capacity.general()
      const second = yield* capacity.general()
      const third = yield* capacity.general()

      // Identity, not equality: the cache must still exist and still be reused.
      // Without the watermark there is no way to prove a re-read did not occur.
      expect(second).toBe(first)
      expect(third).toBe(first)
    }),
  )

  it.live("observes another host's settlement immediately, without a TTL", () =>
    Effect.gen(function* () {
      const capacity = yield* Capacity.Service
      const before = yield* capacity.general()
      expect(before.evidence.observations).toBe(0)

      // No local UsageRecord settlement, no in-process event, no local revision
      // change, and no wall-clock wait: the only signal is the other host's
      // commit.
      yield* commitFromAnotherHost([{ sessionID: "ses-peer-1", completedAt: 1_000, input: 400 }])

      const after = yield* capacity.general()
      expect(after).not.toBe(before)
      expect(after.evidence.observations).toBe(1)
      expect(after.fingerprint).not.toBe(before.fingerprint)
    }),
  )

  it.live("observes another host's update that leaves row count and newest timestamp unchanged", () =>
    Effect.gen(function* () {
      const capacity = yield* Capacity.Service
      const before = yield* capacity.general()
      expect(before.evidence.observations).toBe(1)

      // The newest observation timestamp is unchanged, so neither the row count
      // nor `updated_at` moves. Only the commit watermark can see this.
      yield* commitFromAnotherHost([
        { sessionID: "ses-peer-1", completedAt: 1_000, input: 400 },
        { sessionID: "ses-peer-2", completedAt: 500, input: 900 },
      ])

      const after = yield* capacity.general()
      expect(after).not.toBe(before)
      expect(after.evidence.observations).toBe(2)
      expect(after.fingerprint).not.toBe(before.fingerprint)

      // Reuse resumes once the durable state is quiet again.
      expect(yield* capacity.general()).toBe(after)
    }),
  )
})
