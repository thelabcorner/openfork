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
const ACCOUNT_FREE_REQUEST = DAY + 15_000
const UNKNOWN_FREE_REQUEST = DAY + 17_000
const REQUEST_TWO = DAY + 20_000
const PAID_REQUEST = DAY + 25_000
const UNKNOWN_FREE_LIMIT_HIT = DAY + 28_000
const ACCOUNT_FREE_LIMIT_HIT = DAY + 29_000
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
       ('msg_account_free', 's1', ${ACCOUNT_FREE_REQUEST}, ${ACCOUNT_FREE_REQUEST}, ${assistant({
         providerID: "opencode",
         modelID: "mimo-v2.5-free",
         created: ACCOUNT_FREE_REQUEST,
         completed: ACCOUNT_FREE_REQUEST,
       })}),
       ('msg_unknown_free', 's1', ${UNKNOWN_FREE_REQUEST}, ${UNKNOWN_FREE_REQUEST}, ${assistant({
         providerID: "opencode",
         modelID: "mimo-v2.5-free",
         created: UNKNOWN_FREE_REQUEST,
         completed: UNKNOWN_FREE_REQUEST,
       })}),
       ('msg_paid', 's1', ${PAID_REQUEST}, ${PAID_REQUEST}, ${assistant({
         providerID: "opencode",
         modelID: "some-paid-model",
         created: PAID_REQUEST,
         completed: PAID_REQUEST,
       })}),
       ('msg_unknown_limit', 's1', ${UNKNOWN_FREE_LIMIT_HIT}, ${UNKNOWN_FREE_LIMIT_HIT}, ${assistant({
         providerID: "opencode",
         modelID: "mimo-v2.5-free",
         created: UNKNOWN_FREE_LIMIT_HIT,
         error: {
           name: "APIError",
           data: {
             message: "Unknown-route free-shaped failure",
             statusCode: 429,
             isRetryable: true,
             responseBody: '{"name":"FreeUsageLimitError"}',
           },
         },
       })}),
       ('msg_account_limit', 's1', ${ACCOUNT_FREE_LIMIT_HIT}, ${ACCOUNT_FREE_LIMIT_HIT}, ${assistant({
         providerID: "opencode",
         modelID: "mimo-v2.5-free",
         created: ACCOUNT_FREE_LIMIT_HIT,
         error: {
           name: "APIError",
           data: {
             message: "Free-shaped account-route failure",
             statusCode: 429,
             isRetryable: true,
             responseBody: '{"name":"FreeUsageLimitError"}',
           },
         },
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
       ('prt_account_free', 'msg_account_free', 's1', ${ACCOUNT_FREE_REQUEST}, ${ACCOUNT_FREE_REQUEST}, ${stepFinish()}),
       ('prt_unknown_free', 'msg_unknown_free', 's1', ${UNKNOWN_FREE_REQUEST}, ${UNKNOWN_FREE_REQUEST}, ${stepFinish()}),
       ('prt_free_2', 'msg_free', 's1', ${REQUEST_TWO}, ${REQUEST_TWO}, ${stepFinish()}),
       ('prt_paid', 'msg_paid', 's1', ${PAID_REQUEST}, ${PAID_REQUEST}, ${stepFinish()})
   `)

   // Route settlement, not model naming, is the quota authority. The account
   // rows deliberately use a free-looking model/error shape and must not enter
   // the public learner.
   yield* db.run(sql`
     INSERT INTO usage_record (
       message_id, session_id, provider_id, model_id, base_model_id,
       route_kind, account_id, completed_at,
       input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens
     ) VALUES
       ('msg_free', 's1', 'opencode', 'mimo-v2.5-free', 'mimo-v2.5-free',
        'public', NULL, ${REQUEST_TWO}, 20, 0, 0, 10, 0),
       ('msg_account_free', 's1', 'opencode', 'mimo-v2.5-free', 'mimo-v2.5-free',
        'account', 'acct-paid', ${ACCOUNT_FREE_REQUEST}, 10, 0, 0, 5, 0),
       ('msg_unknown_free', 's1', 'opencode', 'mimo-v2.5-free', 'mimo-v2.5-free',
        'unknown', NULL, ${UNKNOWN_FREE_REQUEST}, 10, 0, 0, 5, 0),
       ('msg_paid', 's1', 'opencode', 'some-paid-model', 'some-paid-model',
        'account', 'acct-paid', ${PAID_REQUEST}, 10, 0, 0, 5, 0),
       ('msg_unknown_limit', 's1', 'opencode', 'mimo-v2.5-free', 'mimo-v2.5-free',
        'unknown', NULL, ${UNKNOWN_FREE_LIMIT_HIT}, 0, 0, 0, 0, 0),
       ('msg_account_limit', 's1', 'opencode', 'mimo-v2.5-free', 'mimo-v2.5-free',
        'account', 'acct-paid', ${ACCOUNT_FREE_LIMIT_HIT}, 0, 0, 0, 0, 0),
       ('msg_limit', 's1', 'opencode', 'mimo-v2.5-free', 'mimo-v2.5-free',
        'public', NULL, ${LIMIT_HIT}, 0, 0, 0, 0, 0),
       ('msg_limit_again', 's1', 'opencode', 'mimo-v2.5-free', 'mimo-v2.5-free',
        'public', NULL, ${LIMIT_HIT + 1_000}, 0, 0, 0, 0, 0)
   `)
 })

await using tmp = await tmpdir()
const dbPath = path.join(tmp.path, "openfork.db")
const databaseLayer = Database.layerFromPath(dbPath)

const zenLayer = LayerNode.compile(LayerNode.group([ZenFreeUsage.node, Database.node]), [
  [Database.node, databaseLayer],
])
const it = testEffect(zenLayer)

describe("Zen free usage DB scanner", () => {
  it.live("counts provider generation steps, excludes paid Zen traffic, and recovers limit hits", () =>
    Effect.gen(function* () {
      yield* seedDatabase
      const usage = yield* ZenFreeUsage.Service
      const { readDb } = yield* Database.Service
      const settled = yield* readDb.all<{ message_id: string; route_kind: string | null }>(sql`
        SELECT message_id, route_kind
        FROM usage_record
        ORDER BY message_id
      `)
      expect(settled.filter((row) => row.route_kind === "public").map((row) => row.message_id)).toEqual([
        "msg_free",
        "msg_limit",
        "msg_limit_again",
      ])
      const snapshot = yield* usage.snapshot()
      const day = snapshot.days.find((item) => item.start === DAY)

      // One assistant message contains two successful generation steps around
      // tool activity. Zen's gateway counts two requests, not one message.
      expect(day?.requests).toBe(2)

      // The non-free, account-routed, and unknown-route free-looking models
      // all have step-finish rows, but none is Public quota evidence.
      expect(snapshot.days.reduce((sum, item) => sum + item.requests, 0)).toBe(2)

      // Earlier unknown-route and account-routed FreeUsageLimitError-shaped
      // failures are also excluded. Repeated genuine Public errors collapse to one calibration
      // episode, measured against the two successful requests before the hit.
      expect(snapshot.limitHits).toHaveLength(1)
      expect(snapshot.limitHits[0]?.requests).toBe(2)
      expect(snapshot.limitHits[0]?.modelID).toBe("mimo-v2.5-free")
      expect(snapshot.limitHits[0]?.at).toBe(LIMIT_HIT)
    }),
  )
})
