import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ServerScope, ServerScope as ServerScopeValue } from "@/utils/server-scope"
import { clearLimitsCache, loadLimitsCache, saveLimitsCache } from "./limits-persistent-cache"

const waitForWrite = () => new Promise((resolve) => setTimeout(resolve, 550))

describe("limits persistent cache ownership", () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => {
    clearLimitsCache(ServerScope.local)
    clearLimitsCache(ServerScopeValue.fromServerKey("remote-a" as never))
    clearLimitsCache(ServerScopeValue.fromServerKey("remote-b" as never))
  })

  test("keeps different server owners isolated even inside one debounce window", async () => {
    const serverA = ServerScopeValue.fromServerKey("remote-a" as never)
    const serverB = ServerScopeValue.fromServerKey("remote-b" as never)
    saveLimitsCache(serverA, [{ providerId: "a", providerName: "A", configured: true }], [])
    saveLimitsCache(serverB, [{ providerId: "b", providerName: "B", configured: true }], [])
    await waitForWrite()

    expect(loadLimitsCache(serverA)?.providers.map((item) => item.providerId)).toEqual(["a"])
    expect(loadLimitsCache(serverB)?.providers.map((item) => item.providerId)).toEqual(["b"])
  })

  test("preserves the legacy key for the canonical local server only", async () => {
    saveLimitsCache(ServerScope.local, [{ providerId: "local", providerName: "Local", configured: true }], [])
    await waitForWrite()
    expect(loadLimitsCache(ServerScope.local)?.providers[0]?.providerId).toBe("local")
  })
})
