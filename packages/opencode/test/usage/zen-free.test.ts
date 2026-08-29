import { describe, expect } from "bun:test"
import path from "path"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import * as ZenFreeUsage from "@/usage/zen-free"
import { testEffect } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"

const TODAY = ZenFreeUsage.zenUtcDayStart(Date.now())
const DAY = TODAY - ZenFreeUsage.ZEN_FREE_DAY_MS
const REQUEST_ONE = DAY + 10_000
const REQUEST_TWO = DAY + 20_000
const PAID_REQUEST = DAY + 25_000
const LIMIT_HIT = DAY + 30_000

function assistant(input: {
  providerID: string
  modelID: string
  created: number
  completed?: number
  error?: unknown
}) {
  return JSON.stringify({
    role: "assistant",
    time: {
      created: input.created,
      ...(input.completed !== undefined ? { completed: input.completed } : {}),
    },
    providerID: input.providerID,
    modelID: input.modelID,
    parentID: "msg_parent",
    mode: "primary",
    agent: "build",
    path: { cwd: "/repo", root: "/repo" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...(input.error !== undefined ? { error: input.error } : {}),
  })
}

function stepFinish() {
  return JSON.stringify({
    type: "step-finish",
    reason: "stop",
    cost: 0,
    tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
  })
}

const seedDatabase = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db.run(sql`
    INSERT INTO project (id, worktree, name, sandboxes, time_created, time_updated)
    VALUES ('p1', '/repo', 'repo', '[]', ${DAY}, ${DAY})
  `)
  yield* db.run(sql`
    INSERT INTO session (id, project_id, directory, slug, title, version, time_created, time_updated)
    VALUES ('s1', 'p1', '/repo', 's1', 'Zen', '1', ${DAY}, ${LIMIT_HIT})
  `)

  yield* db.run(sql`
    INSERT INTO message (id, session_id, time_created, time_updated, data)
    VALUES
      ('msg_free', 's1', ${REQUEST_ONE}, ${REQUEST_TWO}, ${assistant({
        providerID: "opencode",
        modelID: "mimo-v2.5-free",
        created: REQUEST_ONE,
        completed: REQUEST_TWO,
      })}),
      ('msg_paid', 's1', ${PAID_REQUEST}, ${PAID_REQUEST}, ${assistant({
        providerID: "opencode",
        modelID: "some-paid-model",
        created: PAID_REQUEST,
        completed: PAID_REQUEST,
      })}),
      ('msg_limit', 's1', ${LIMIT_HIT}, ${LIMIT_HIT}, ${assistant({
        providerID: "opencode",
        modelID: "mimo-v2.5-free",
        created: LIMIT_HIT,
        error: {
          name: "APIError",
          data: {
            message: "Free usage exceeded",
            statusCode: 429,
            isRetryable: true,
            responseBody: '{"name":"FreeUsageLimitError"}',
          },
        },
      })}),
      ('msg_limit_again', 's1', ${LIMIT_HIT + 1_000}, ${LIMIT_HIT + 1_000}, ${assistant({
        providerID: "opencode",
        modelID: "mimo-v2.5-free",
        created: LIMIT_HIT + 1_000,
        error: {
          name: "APIError",
          data: {
            message: "Free usage exceeded",
            statusCode: 429,
            isRetryable: true,
            responseBody: '{"name":"FreeUsageLimitError"}',
          },
        },
      })})
  `)

  yield* db.run(sql`
    INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
    VALUES
      ('prt_free_1', 'msg_free', 's1', ${REQUEST_ONE}, ${REQUEST_ONE}, ${stepFinish()}),
      ('prt_free_2', 'msg_free', 's1', ${REQUEST_TWO}, ${REQUEST_TWO}, ${stepFinish()}),
      ('prt_paid', 'msg_paid', 's1', ${PAID_REQUEST}, ${PAID_REQUEST}, ${stepFinish()})
  `)
})

await using tmp = await tmpdir()
const dbPath = path.join(tmp.path, "opencode.db")
const databaseLayer = Database.layerFromPath(dbPath)
await Effect.runPromise(seedDatabase.pipe(Effect.provide(databaseLayer)))

const zenLayer = LayerNode.compile(ZenFreeUsage.node, [[Database.node, databaseLayer]])
const it = testEffect(zenLayer)

describe("Zen free usage DB scanner", () => {
  it.live("counts provider generation steps, excludes paid Zen traffic, and recovers limit hits", () =>
    Effect.gen(function* () {
      const usage = yield* ZenFreeUsage.Service
      const snapshot = yield* usage.snapshot()
      const day = snapshot.days.find((item) => item.start === DAY)

      // One assistant message contains two successful generation steps around
      // tool activity. Zen's gateway counts two requests, not one message.
      expect(day?.requests).toBe(2)

      // The non-free OpenCode model has its own step-finish but is excluded.
      expect(snapshot.days.reduce((sum, item) => sum + item.requests, 0)).toBe(2)

      // Repeated post-exhaustion errors on the same UTC day are one calibration
      // episode, measured against the two successful requests before the hit.
      expect(snapshot.limitHits).toHaveLength(1)
      expect(snapshot.limitHits[0]?.requests).toBe(2)
      expect(snapshot.limitHits[0]?.modelID).toBe("mimo-v2.5-free")
      expect(snapshot.limitHits[0]?.at).toBe(LIMIT_HIT)
    }),
  )
})
