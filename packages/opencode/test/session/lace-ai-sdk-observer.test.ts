import { describe, expect, test } from "bun:test"
import { createLaceAISdkObserver, laceObserveAIEnabled } from "../../src/session/llm/lace-ai-sdk-observer"
import { wrapLanguageModel } from "ai"

const req = {
  owner: "project-a",
  session: "session-a",
  provider: "openrouter",
  model: "sample",
  route: "ai-sdk",
  tools: [{ name: "read", inputSchema: { type: "object" } }],
  prompt: [{ role: "system", content: [{ type: "text", text: "stable" }] }],
}

describe("LACE post-transform observation", () => {
  test("opt-in cohort", () => {
    expect(laceObserveAIEnabled("s", {})).toBe(false)
    expect(laceObserveAIEnabled("s", { OPENFORK_LACE_OBSERVE_AI_SDK: "1", OPENFORK_LACE_OBSERVE_EVERY: "1" })).toBe(
      true,
    )
  })
  test("classifies append and rewrite", () => {
    const observer = createLaceAISdkObserver()
    expect(observer.observe(req)).toMatchObject({ status: "observed", kind: "first" })
    expect(observer.observe(req)).toMatchObject({ status: "observed", kind: "identical" })
    const appended = { ...req, prompt: [...req.prompt, { role: "user", content: "hello" }] }
    expect(observer.observe(appended)).toMatchObject({ status: "observed", kind: "extended" })
    expect(observer.observe({ ...appended, prompt: [{ role: "user", content: "different" }] })).toMatchObject({
      status: "observed",
      kind: "rewritten",
    })
  })
  test("tool and model changes are separate from prefix mutations", () => {
    const observer = createLaceAISdkObserver()
    observer.observe(req)
    expect(observer.observe({ ...req, tools: [] })).toMatchObject({ status: "observed", kind: "tools-changed" })
    expect(observer.observe({ ...req, model: "different" })).toMatchObject({
      status: "observed",
      kind: "domain-changed",
    })
  })
  test("provider option changes are visible even when prompt and tools are identical", () => {
    const observer = createLaceAISdkObserver()
    observer.observe({ ...req, options: { providerOptions: { cacheMode: "implicit" } } })
    expect(observer.observe({ ...req, options: { providerOptions: { cacheMode: "explicit-only" } } })).toMatchObject({
      status: "observed",
      kind: "options-changed",
    })
  })
  test("account scopes, capacity, and malformed shape", () => {
    const observer = createLaceAISdkObserver(2)
    expect(observer.observe({ ...req, owner: "" }).status).toBe("invalid-owner")
    expect(observer.observe({ ...req, prompt: {} }).status).toBe("unsupported-shape")
    for (const session of ["one", "two", "three"]) observer.observe({ ...req, session })
    expect(observer.size()).toBe(2)
    expect(observer.observe({ ...req, session: "one" })).toMatchObject({ status: "observed", kind: "first" })
    observer.clear()
    expect(observer.size()).toBe(0)
  })
  test("cyclic and oversized input cannot poison the observer", () => {
    const observer = createLaceAISdkObserver()
    const cycle: any = { role: "user" }
    cycle.loop = cycle
    expect(observer.observe({ ...req, prompt: [cycle] }).status).toBe("observation-unavailable")
    expect(observer.observe({ ...req, prompt: [{ content: "x".repeat(1024 * 1024 + 1) }] }).status).toBe(
      "observation-unavailable",
    )
    expect(observer.size()).toBe(0)
    expect(observer.observe(req).status).toBe("observed")
  })
  test("global retained region budget evicts oldest scoped entries", () => {
    const observer = createLaceAISdkObserver(128)
    const prompt = Array.from({ length: 8000 }, (_, i) => ({ role: "user", content: String(i) }))
    for (let i = 0; i < 5; i++) {
      expect(observer.observe({ ...req, session: "many-" + i, prompt }).status).toBe("observed")
      expect(observer.retained()).toBeLessThanOrEqual(16384)
    }
    expect(observer.size()).toBe(2)
    expect(observer.observe({ ...req, session: "many-0", prompt })).toMatchObject({
      status: "observed",
      kind: "first",
    })
    observer.clear()
    expect(observer.retained()).toBe(0)
  })
  test("real AI SDK V3 transform seam observes post-transform input without changing dispatch", async () => {
    const observer = createLaceAISdkObserver()
    let providerCalls = 0
    const seen: unknown[] = []
    const base = {
      specificationVersion: "v3",
      provider: "fixture",
      modelId: "fixture",
      supportedUrls: {},
      doStream: async (params: any) => {
        providerCalls++
        seen.push(params.prompt)
        return {
          stream: new ReadableStream({
            start(c) {
              c.close()
            },
          }),
        }
      },
    }
    const wrapped = wrapLanguageModel({
      model: base as any,
      middleware: [
        {
          specificationVersion: "v3",
          async transformParams({ params }: any) {
            const next = {
              ...params,
              prompt: [...params.prompt, { role: "user", content: [{ type: "text", text: "admitted" }] }],
            }
            expect(observer.observe({ ...req, prompt: next.prompt, tools: next.tools }).status).toBe("observed")
            return next
          },
        },
      ],
    })
    const initial = [{ role: "system", content: [{ type: "text", text: "before" }] }]
    await wrapped.doStream({ prompt: initial } as any)
    expect(providerCalls).toBe(1)
    expect(seen[0]).toEqual([...initial, { role: "user", content: [{ type: "text", text: "admitted" }] }])
    expect(initial).toHaveLength(1)
  })
})
