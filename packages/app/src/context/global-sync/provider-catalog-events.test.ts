import { expect, test } from "bun:test"
import { createProviderCatalogRefresh, providerCatalogQueryMatches, providerCatalogRevision } from "./provider-catalog-events"

test("provider enrichment invalidates only its explicit location and server", () => {
  expect(providerCatalogQueryMatches(["local", "/repo", "providers"], "local", "/repo")).toBe(true)
  expect(providerCatalogQueryMatches(["local", "/other", "providers"], "local", "/repo")).toBe(false)
  expect(providerCatalogQueryMatches(["remote", "/repo", "providers"], "local", "/repo")).toBe(false)
  expect(providerCatalogQueryMatches(["local", null, "providers"], "local", "/repo")).toBe(false)
  expect(providerCatalogQueryMatches(["local", null, "providers"], "local", undefined)).toBe(true)
  expect(providerCatalogQueryMatches(["local", "/repo", "providers"], "local", undefined)).toBe(false)
})

test("provider enrichment rejects malformed location and revisions", () => {
  expect(providerCatalogRevision({ directory: "/repo", revision: 2 })).toEqual({ directory: "/repo", revision: 2 })
  for (const revision of [-1, 0.5, Infinity, "2", Number.MAX_SAFE_INTEGER + 1])
    expect(providerCatalogRevision({ revision })).toBeUndefined()
  expect(providerCatalogRevision({ revision: 1, directory: "" })).toBeUndefined()
})

test("enrichment survives a cold snapshot race and coalesces revisions", async () => {
  const cold = Promise.withResolvers<void>()
  const revisions: number[] = []
  const query = {}
  const refresh = createProviderCatalogRefresh()
  const input = { pending: () => cold.promise, refresh: async (revision: number) => { revisions.push(revision) } }
  const first = refresh(query, 1, input)
  const second = refresh(query, 3, input)
  expect(revisions).toEqual([])
  cold.resolve()
  await Promise.all([first, second])
  expect(revisions).toEqual([3])
  await refresh(query, 2, input)
  expect(revisions).toEqual([3])
})

test("a failed enrichment does not permanently consume its revision", async () => {
  const refresh = createProviderCatalogRefresh()
  const query = {}
  await expect(refresh(query, 1, { pending: () => undefined, refresh: async () => { throw new Error("offline") } })).rejects.toThrow("offline")
  let calls = 0
  await refresh(query, 1, { pending: () => undefined, refresh: async () => { calls++ } })
  expect(calls).toBe(1)
})
