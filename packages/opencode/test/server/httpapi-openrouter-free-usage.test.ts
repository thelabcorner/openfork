import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { ExperimentalPaths } from "../../src/server/routes/instance/httpapi/groups/experimental"
import { Database } from "@opencode-ai/core/database/database"
import { Session } from "@/session/session"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(Layer.mergeAll(LayerNode.compile(LayerNode.group([Session.node, Database.node])), httpApiLayer))

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  return response.json.pipe(Effect.map((value) => value as T))
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("OpenRouter free usage HttpApi", () => {
  it.instance("returns a degraded report instead of 500 when no key is configured", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const response = yield* requestInDirectory(ExperimentalPaths.openrouterFreeUsage, tmp.directory)

      expect(response.status).toBe(200)
      expect(yield* json(response)).toMatchObject({
        free: {
          limit: 50,
          remaining: 0,
          status: "depleted",
        },
        source: {
          stale: true,
          upstreamCalls: 0,
        },
      })
    }),
  )

  it.instance("returns a degraded report when OpenRouter rejects the key", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const previousKey = process.env.OPENROUTER_MANAGEMENT_KEY
      const previousFetch = globalThis.fetch
      process.env.OPENROUTER_MANAGEMENT_KEY = "test-management-key"
      globalThis.fetch = Object.assign(
        (async () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })) as unknown as typeof fetch,
        { preconnect: previousFetch.preconnect },
      )
      try {
        const response = yield* requestInDirectory(ExperimentalPaths.openrouterFreeUsage, tmp.directory)

        expect(response.status).toBe(200)
        expect(yield* json(response)).toMatchObject({
          free: { status: "depleted" },
          source: { stale: true },
        })
      } finally {
        if (previousKey === undefined) delete process.env.OPENROUTER_MANAGEMENT_KEY
        else process.env.OPENROUTER_MANAGEMENT_KEY = previousKey
        globalThis.fetch = previousFetch
      }
    }),
  )
})
