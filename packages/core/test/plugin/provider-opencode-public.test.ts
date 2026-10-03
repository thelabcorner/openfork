import { afterEach, describe, expect, test } from "bun:test"
import { isTrustedPublicCost } from "../../src/plugin/provider/opencode"
import {
  currentHostedCatalog,
  decodeHostedModels,
  isHostedPublicModel,
  resetHostedCatalogForTest,
  setHostedCatalogForTest,
} from "../../src/plugin/provider/opencode-hosted"

const zero = {
  input: 0,
  output: 0,
  cache: { read: 0, write: 0 },
}

afterEach(() => resetHostedCatalogForTest())

describe("OpenCode V2 hosted public-model witness", () => {
  test("decodes a bounded hosted model list and rejects malformed payloads", () => {
    expect([...decodeHostedModels({ data: [{ id: "space-bunny-free" }, { id: "big-pickle" }] })]).toEqual([
      "space-bunny-free",
      "big-pickle",
    ])

    for (const bad of [
      null,
      {},
      { data: "nope" },
      { data: [] },
      { data: [{}] },
      { data: [{ id: "" }] },
      { data: [{ id: "has space" }] },
      { data: [{ id: "bad\u0000id" }] },
      { data: Array.from({ length: 2049 }, (_, index) => ({ id: `m-${index}` })) },
    ]) {
      expect(() => decodeHostedModels(bad)).toThrow()
    }
  })

  test("uses only fresh or stale positive witnesses", () => {
    setHostedCatalogForTest(["space-bunny-free"], Date.now())
    expect(isHostedPublicModel({ id: "space-bunny-free", apiID: "space-bunny-free" })).toBe(true)
    expect(isHostedPublicModel({ id: "alias", apiID: "space-bunny-free" })).toBe(true)
    expect(isHostedPublicModel({ id: "missing", apiID: "missing" })).toBe(false)

    setHostedCatalogForTest(["space-bunny-free"], Date.now() - 60 * 60 * 1000)
    expect(currentHostedCatalog().state).toBe("stale")
    expect(isHostedPublicModel({ id: "space-bunny-free", apiID: "space-bunny-free" })).toBe(true)

    setHostedCatalogForTest(["space-bunny-free"], Date.now() - 7 * 60 * 60 * 1000)
    expect(currentHostedCatalog().state).toBe("expired")
    expect(isHostedPublicModel({ id: "space-bunny-free", apiID: "space-bunny-free" })).toBe(false)

    resetHostedCatalogForTest()
    expect(currentHostedCatalog().state).toBe("unavailable")
    expect(isHostedPublicModel({ id: "space-bunny-free", apiID: "space-bunny-free" })).toBe(false)
  })
})

describe("OpenCode V2 anonymous public-cost eligibility", () => {
  test("fails closed when pricing metadata is missing", () => {
    expect(isTrustedPublicCost({ cost: [] } as any)).toBe(false)
  })

  test("rejects output-only and cache billing", () => {
    expect(isTrustedPublicCost({ cost: [{ ...zero, output: 0.01 }] } as any)).toBe(false)
    expect(
      isTrustedPublicCost({
        cost: [{ ...zero, cache: { read: 0.001, write: 0 } }],
      } as any),
    ).toBe(false)
    expect(
      isTrustedPublicCost({
        cost: [{ ...zero, cache: { read: 0, write: 0.001 } }],
      } as any),
    ).toBe(false)
  })

  test("rejects a paid published context tier even when base pricing is free", () => {
    expect(
      isTrustedPublicCost({
        cost: [
          zero,
          {
            ...zero,
            tier: { type: "context", size: 200_000 },
            output: 0.02,
          },
        ],
      } as any),
    ).toBe(false)
  })

  test("accepts explicit all-zero pricing across every published tier", () => {
    expect(
      isTrustedPublicCost({
        cost: [
          zero,
          {
            ...zero,
            tier: { type: "context", size: 200_000 },
          },
        ],
      } as any),
    ).toBe(true)
  })
})
