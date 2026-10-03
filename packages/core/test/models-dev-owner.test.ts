import path from "node:path"
import { rm } from "node:fs/promises"
import { afterAll, describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Global } from "@opencode-ai/core/global"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Hash } from "@opencode-ai/core/util/hash"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { testEffect } from "./lib/effect"

const source = `https://models-dev-owner-${crypto.randomUUID()}.example`
const cachePath = path.join(Global.Path.cache, `models-${Hash.fast(source)}.json`)
const previous = {
  source: Flag.OPENCODE_MODELS_URL,
  path: Flag.OPENCODE_MODELS_PATH,
  disabled: Flag.OPENCODE_DISABLE_MODELS_FETCH,
}
Flag.OPENCODE_MODELS_URL = source
Flag.OPENCODE_MODELS_PATH = undefined
Flag.OPENCODE_DISABLE_MODELS_FETCH = false

let fetchCount = 0
let requestGate: Effect.Effect<void> | undefined
let requestStarted: Deferred.Deferred<void> | undefined
const client = HttpClient.make((request) =>
  Effect.gen(function* () {
    fetchCount++
    expect(request.url).toBe(`${source}/api.json?type=all`)
    if (requestStarted) yield* Deferred.succeed(requestStarted, undefined)
    if (requestGate) yield* requestGate
    return HttpClientResponse.fromWeb(
      request,
      new Response(
        JSON.stringify({
          acme: {
            id: "acme",
            name: "Acme",
            env: ["ACME_API_KEY"],
            npm: "@ai-sdk/openai-compatible",
            api: "https://api.acme.example/v1",
            models: {},
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )
  }),
)
const it = testEffect(
  LayerNode.compile(ModelsDev.node, [[httpClient, Layer.succeed(HttpClient.HttpClient, client)]]),
)

describe("ModelsDev selected-provider ownership", () => {
  it.effect("retries cold population after the initiating request is interrupted", () =>
    Effect.gen(function* () {
      fetchCount = 0
      yield* Effect.promise(() => rm(cachePath, { force: true }))
      const modelsDev = yield* ModelsDev.Service
      requestStarted = yield* Deferred.make<void>()
      requestGate = Effect.never
      yield* Effect.gen(function* () {
        const first = yield* modelsDev.getForSelectedProvider("acme").pipe(Effect.forkScoped)
        yield* Deferred.await(requestStarted!)
        yield* Fiber.interrupt(first)
        requestGate = undefined
        requestStarted = undefined
        expect(Object.keys(yield* modelsDev.getForSelectedProvider("acme"))).toEqual(["acme"])
        expect(fetchCount).toBe(2)
        expect(Object.keys(yield* modelsDev.getCached())).toEqual(["acme"])
      }).pipe(Effect.ensuring(Effect.sync(() => {
        requestGate = undefined
        requestStarted = undefined
      })))
    }),
    30000,
  )
  it.effect("keeps reads cold and coalesces a cold selected-provider miss", () =>
    Effect.gen(function* () {
      fetchCount = 0
      yield* Effect.promise(() => rm(cachePath, { force: true }))
      const modelsDev = yield* ModelsDev.Service

      expect(yield* modelsDev.getCached()).toEqual({})
      expect(fetchCount).toBe(0)

      const [first, second] = yield* Effect.all(
        [modelsDev.getForSelectedProvider("acme"), modelsDev.getForSelectedProvider("acme")],
        { concurrency: 2 },
      )
      expect(Object.keys(first)).toEqual(["acme"])
      expect(Object.keys(second)).toEqual(["acme"])
      expect(fetchCount).toBe(1)
      expect(Object.keys(yield* modelsDev.getCached())).toEqual(["acme"])

      // A nonempty catalog miss is a genuine not-found result, not permission
      // to fetch for an arbitrary typo or a configured/custom provider.
      const typo = yield* modelsDev.getForSelectedProvider("acme-typo")
      expect(typo.acme?.id).toBe("acme")
      expect(Object.hasOwn(typo, "acme-typo")).toBe(false)
      expect(fetchCount).toBe(1)
    }),
    30000,
  )
})

afterAll(async () => {
  Flag.OPENCODE_MODELS_URL = previous.source
  Flag.OPENCODE_MODELS_PATH = previous.path
  Flag.OPENCODE_DISABLE_MODELS_FETCH = previous.disabled
  await rm(cachePath, { force: true })
})
