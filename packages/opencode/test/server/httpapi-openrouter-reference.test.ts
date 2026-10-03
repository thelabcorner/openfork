import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect, Layer, Option, Ref } from "effect"
import { HttpClient, HttpClientResponse, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ServerAuth } from "../../src/server/auth"
import {
  OpenRouterReferenceApi,
  OpenRouterReferencePaths,
} from "../../src/server/routes/instance/httpapi/groups/openrouter-reference"
import { openRouterReferenceHandlers } from "../../src/server/routes/instance/httpapi/handlers/openrouter-reference"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { testEffect } from "../lib/effect"
import { request } from "./httpapi-layer"

const upstreamCalls = Ref.makeUnsafe(0)
const upstreamUrls = Ref.makeUnsafe<string[]>([])
const upstreamActive = Ref.makeUnsafe(0)
const upstreamPeak = Ref.makeUnsafe(0)

const fakeHttp = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.gen(function* () {
      yield* Ref.update(upstreamCalls, (value) => value + 1)
      yield* Ref.update(upstreamUrls, (value) => [...value, request.url])
      const active = yield* Ref.modify(upstreamActive, (value) => [value + 1, value + 1] as const)
      yield* Ref.update(upstreamPeak, (value) => Math.max(value, active))
      if (
        request.url.includes("concurrency-") ||
        request.url.includes("singleflight") ||
        request.url.includes("/api/frontend/v1/author-models")
      ) {
        yield* Effect.sleep("25 millis")
      }
      yield* Ref.update(upstreamActive, (value) => value - 1)
      if (request.url.includes("missing-model")) {
        return HttpClientResponse.fromWeb(request, new Response(null, { status: 404 }))
      }
      if (request.url.includes("/api/frontend/v1/author-models")) {
        return HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({
              data: {
                models: [
                  {
                    slug: "openai/gpt-telemetry-test",
                    permaslug: "openai/gpt-telemetry-test-2026-10-02",
                    endpoint: { variant: "standard" },
                  },
                ],
              },
            }),
            { headers: { "content-type": "application/json" } },
          ),
        )
      }
      if (request.url.includes("/api/frontend/v1/stats/effective-pricing")) {
        return HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({
              data: {
                providerSummaries: [
                  {
                    endpointId: "endpoint-fast",
                    providerName: "Fast Provider",
                    providerSlug: "fast",
                    cacheHitRate: 0.1234,
                  },
                ],
              },
            }),
            { headers: { "content-type": "application/json" } },
          ),
        )
      }
      if (request.url.includes("/api/frontend/v1/stats/throughput-comparison")) {
        return HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({
              data: [{ x: "2020-01-01T00:00:00.000Z", y: { "endpoint-fast::standard": 123.456 } }],
            }),
            { headers: { "content-type": "application/json" } },
          ),
        )
      }
      const body = {
        data: {
          endpoints: [
            {
              provider_name: "Fast Provider",
              tag: "fast/provider",
              pricing: {
                prompt: "0.000001",
                completion: "0.000002",
                input_cache_read: "0.0000005",
              },
              uptime_last_30m: "99.9",
              throughput_last_30m: { p50: "123.4" },
              context_length: "131072",
              supports_implicit_caching: true,
            },
          ],
        },
      }
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
        }),
      )
    }),
  ),
)

const ownershipLayer = HttpRouter.serve(
  HttpApiBuilder.layer(OpenRouterReferenceApi).pipe(
    Layer.provide(openRouterReferenceHandlers),
    Layer.provide(authorizationLayer),
    Layer.provide(fakeHttp),
    Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode", publicUrl: "" })),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layerTest), Layer.provideMerge(NodeServices.layer))

const it = testEffect(ownershipLayer)

describe("OpenRouter reference HTTP ownership", () => {
  it.live("serves and caches endpoint topology without a workspace Instance", () =>
    Effect.gen(function* () {
      yield* Ref.set(upstreamCalls, 0)
      yield* Ref.set(upstreamUrls, [])

      // Deliberately omit directory/workspace headers and query parameters.
      // This test layer does not provide InstanceStore, workspace routing, or
      // InstanceContext at all, so success proves the Tier-0 ownership boundary.
      const path = `${OpenRouterReferencePaths.endpoints}?model=openai%2Fgpt-4.1`
      const first = yield* request(path)
      expect(first.status).toBe(200)
      expect(yield* first.json).toEqual([
        {
          providerName: "Fast Provider",
          tag: "fast/provider",
          provider: "fast",
          pricing: { prompt: 1, completion: 2, cacheRead: 0.5 },
          uptime: 99.9,
          contextLength: 131072,
          supportsImplicitCaching: true,
          throughputP50: 123.4,
        },
      ])

      const second = yield* request(path)
      expect(second.status).toBe(200)
      expect(yield* second.json).toEqual([
        {
          providerName: "Fast Provider",
          tag: "fast/provider",
          provider: "fast",
          pricing: { prompt: 1, completion: 2, cacheRead: 0.5 },
          uptime: 99.9,
          contextLength: 131072,
          supportsImplicitCaching: true,
          throughputP50: 123.4,
        },
      ])

      expect(yield* Ref.get(upstreamCalls)).toBe(1)
      expect(yield* Ref.get(upstreamUrls)).toEqual([
        "https://openrouter.ai/api/v1/models/openai/gpt-4.1/endpoints",
      ])
    }),
  )

  it.live("single-flights concurrent requests for the same model", () =>
    Effect.gen(function* () {
      yield* Ref.set(upstreamCalls, 0)
      yield* Ref.set(upstreamActive, 0)
      yield* Ref.set(upstreamPeak, 0)

      const path = `${OpenRouterReferencePaths.endpoints}?model=test%2Fsingleflight`
      const responses = yield* Effect.all([request(path), request(path)], { concurrency: "unbounded" })

      expect(responses.map((response) => response.status)).toEqual([200, 200])
      expect(yield* Ref.get(upstreamCalls)).toBe(1)
      expect(yield* Ref.get(upstreamPeak)).toBe(1)
    }),
  )

  it.live("caps aggregate OpenRouter upstream pressure across distinct models", () =>
    Effect.gen(function* () {
      yield* Ref.set(upstreamCalls, 0)
      yield* Ref.set(upstreamActive, 0)
      yield* Ref.set(upstreamPeak, 0)

      const responses = yield* Effect.all(
        Array.from({ length: 9 }, (_, index) =>
          request(`${OpenRouterReferencePaths.endpoints}?model=test%2Fconcurrency-${index}`),
        ),
        { concurrency: "unbounded" },
      )

      expect(responses.every((response) => response.status === 200)).toBe(true)
      expect(yield* Ref.get(upstreamCalls)).toBe(9)
      expect(yield* Ref.get(upstreamPeak)).toBe(4)
    }),
  )

  it.live("caches removed persisted models as an authoritative empty endpoint set", () =>
    Effect.gen(function* () {
      yield* Ref.set(upstreamCalls, 0)
      yield* Ref.set(upstreamActive, 0)
      yield* Ref.set(upstreamPeak, 0)

      const path = `${OpenRouterReferencePaths.endpoints}?model=test%2Fmissing-model`
      const first = yield* request(path)
      const second = yield* request(path)

      expect(first.status).toBe(200)
      expect(yield* first.json).toEqual([])
      expect(second.status).toBe(200)
      expect(yield* second.json).toEqual([])
      expect(yield* Ref.get(upstreamCalls)).toBe(1)
    }),
  )

  it.live("serves telemetry without an Instance and single-flights/cache-coalesces the three-call upstream sequence", () =>
    Effect.gen(function* () {
      yield* Ref.set(upstreamCalls, 0)
      yield* Ref.set(upstreamUrls, [])
      yield* Ref.set(upstreamActive, 0)
      yield* Ref.set(upstreamPeak, 0)

      const path =
        `${OpenRouterReferencePaths.telemetry}?model=openai%2Fgpt-telemetry-test&timeRange=1w`
      const concurrent = yield* Effect.all([request(path), request(path)], { concurrency: "unbounded" })
      for (const response of concurrent) {
        expect(response.status).toBe(200)
        expect(yield* response.json).toEqual([
          {
            endpointId: "endpoint-fast",
            providerName: "Fast Provider",
            providerSlug: "fast",
            cacheHitPercent: 12.34,
            throughputTps: 123.46,
          },
        ])
      }

      const cached = yield* request(path)
      expect(cached.status).toBe(200)
      expect(yield* cached.json).toEqual([
        {
          endpointId: "endpoint-fast",
          providerName: "Fast Provider",
          providerSlug: "fast",
          cacheHitPercent: 12.34,
          throughputTps: 123.46,
        },
      ])

      expect(yield* Ref.get(upstreamCalls)).toBe(3)
      expect((yield* Ref.get(upstreamUrls)).filter((url) => url.includes("/api/frontend/v1/"))).toHaveLength(3)
    }),
  )
})
