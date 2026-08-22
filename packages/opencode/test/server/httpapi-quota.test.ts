import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Layer } from "effect"
import { Effect } from "effect"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"
import { httpApiLayer, request } from "./httpapi-layer"

const testStateLayer = Layer.effectDiscard(
  Effect.acquireRelease(
    Effect.promise(() => resetDatabase()),
    () => Effect.promise(() => resetDatabase()),
  ),
)

const it = testEffect(Layer.mergeAll(testStateLayer, LayerNode.compile(FSUtil.node), httpApiLayer))

// Quota reads target live provider account endpoints, so these route tests
// only exercise the registry envelope and error mapping; provider payload
// semantics are covered by test/quota/providers.test.ts with fakes.
describe("QuotaHttpApi", () => {
  it.effect("lists registered quota providers", () =>
    Effect.gen(function* () {
      const response = yield* request("/quota/providers")
      expect(response.status).toBe(200)
      const body = yield* response.json as unknown as Effect.Effect<{ providers?: unknown[] }>
      expect(Array.isArray(body.providers)).toBe(true)
      const ids = (body.providers as { providerId: string }[]).map((provider) => provider.providerId)
      expect(ids).toContain("opencode-go")
      expect(ids).toContain("openrouter")
      expect(ids).toContain("kimi-for-coding")
      expect(ids).toContain("deepseek")
      for (const provider of body.providers as { configured: unknown }[]) {
        expect(typeof provider.configured).toBe("boolean")
      }
    }))

  it.effect("returns 404 for an unsupported quota provider", () =>
    Effect.gen(function* () {
      const response = yield* request("/quota/does-not-exist")
      expect(response.status).toBe(404)
    }))
})
