import { describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { ROUTED_ACCOUNT_HEADER } from "@/provider/routing-metadata"
import {
  ZenGoPlugin,
  ZenPlugin,
  discoverZenSystemOneModel,
  resetZenPoolForTest,
  setTestZenFetch,
  setTestZenVaultCredentials,
  ZEN_PUBLIC_API_KEY,
  resolveZenRequest,
  zenGoProviderFetch,
  zenLimitSnapshot,
  zenProviderFetch,
} from "@/plugin/zen"

function configure(keys: string[]) {
  resetZenPoolForTest()
  setTestZenVaultCredentials(undefined)
  const names = ["OPENCODE_API_KEY", "OPENCODE_API_KEY_2", "OPENCODE_API_KEY_3"]
  const original = names.map((name) => process.env[name])
  for (const [index, name] of names.entries()) {
    const value = keys[index]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  setTestZenVaultCredentials([])
  return () => {
    for (const [index, name] of names.entries()) {
      const value = original[index]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    setTestZenFetch(undefined)
    setTestZenVaultCredentials(undefined)
    resetZenPoolForTest()
  }
}

function baseCatalog() {
  const model = {
    id: "grok-code",
    providerID: "opencode",
    name: "Grok Code",
    api: { id: "grok-code", url: "https://opencode.ai/zen/v1", npm: "@ai-sdk/openai-compatible" },
    status: "active",
    headers: {},
    options: {},
    limit: { context: 256_000, output: 32_000 },
  }
  return { models: { "grok-code": model } } as any
}

async function modelsHook() {
  const hooks = await ZenPlugin({ serverUrl: new URL("http://127.0.0.1:1") } as PluginInput)
  return hooks.provider!.models!
}

describe("zen provider account roster", () => {
  test("publishes the same stable ids and human labels for both opencode and opencode-go", async () => {
    resetZenPoolForTest()
    setTestZenVaultCredentials([
      { apiKey: "roster-secret-a", label: "key1", isDefault: false },
      { apiKey: "roster-secret-b", label: "Migrated Key", isDefault: true },
    ])
    try {
      const input = { serverUrl: new URL("http://127.0.0.1:1") } as PluginInput
      const zen = await ZenPlugin(input)
      const go = await ZenGoPlugin(input)
      const zenAccounts = await zen.provider!.accounts!({})
      const goAccounts = await go.provider!.accounts!({})

      expect(zenAccounts).toHaveLength(2)
      expect(goAccounts).toEqual(zenAccounts)
      expect(zenAccounts.map((account) => account.label)).toEqual(["key1", "Migrated Key"])
      expect(zenAccounts.every((account) => /^zen-/.test(account.id))).toBe(true)
      expect(new Set(zenAccounts.map((account) => account.id)).size).toBe(2)
      expect(JSON.stringify(zenAccounts)).not.toContain("roster-secret")
    } finally {
      setTestZenVaultCredentials(undefined)
      resetZenPoolForTest()
    }
  })
})

describe("zen models hook", () => {
  test("empty pool leaves the catalog unchanged", async () => {
    const dispose = configure([])
    try {
      const models = await modelsHook()
      const catalog = baseCatalog()
      const result = await models(catalog, {})
      expect(result).toBe(catalog.models)
    } finally {
      dispose()
    }
  })

  test("each key emits one variant per base model with label names and qualified api ids", async () => {
    const dispose = configure(["selector-key-a", "selector-key-b"])
    try {
      const models = await modelsHook()
      const result = await models(baseCatalog(), {})
      const ids = Object.keys(result).sort()
      expect(ids.length).toBe(3)
      expect(ids.filter((id) => id === "grok-code").length).toBe(1)
      const variants = ids.filter((id) => id.startsWith("grok-code@zen-"))
      expect(variants.length).toBe(2)
      for (const id of variants) {
        const model = result[id]!
        expect(model.api.id).toBe(id)
        expect(model.id).toBe(id)
        expect(model.name.startsWith("Grok Code (key-")).toBe(true)
        expect(id).not.toContain("selector-key")
      }
    } finally {
      dispose()
    }
  })

  test("already-qualified catalog models are never re-qualified", async () => {
    const dispose = configure(["key-a"])
    try {
      const models = await modelsHook()
      const catalog = baseCatalog()
      catalog.models = {
        "grok-code": catalog.models["grok-code"],
        "grok-code@zen-already": { ...catalog.models["grok-code"], id: "grok-code@zen-already" },
      }
      const result = await models(catalog, {})
      // The pre-qualified model is kept as-is; the bare one gains exactly one
      // new per-account variant — never a double-qualified `@zen-…@zen-…` id.
      const ids = Object.keys(result)
      expect(ids.filter((id) => id.includes("@")).length).toBe(2)
      expect(ids.some((id) => id.includes("@zen-already@zen-"))).toBe(false)
    } finally {
      dispose()
    }
  })

  test("ZenGoPlugin emits the same per-account variants for opencode-go", async () => {
    const dispose = configure(["go-key-a", "go-key-b"])
    try {
      const hooks = await ZenGoPlugin({ serverUrl: new URL("http://127.0.0.1:1") } as PluginInput)
      expect(hooks.provider!.id).toBe("opencode-go")
      const result = await hooks.provider!.models!(baseCatalog(), {})
      expect(Object.keys(result).filter((id) => id.startsWith("grok-code@zen-")).length).toBe(2)
    } finally {
      dispose()
    }
  })

  test("ZenGoPlugin preserves a System One primitive on per-account variants", async () => {
    const dispose = configure(["go-system-one-key"])
    try {
      const hooks = await ZenGoPlugin({ serverUrl: new URL("http://127.0.0.1:1") } as PluginInput)
      const catalog = baseCatalog()
      catalog.models = {
        "jev-1.13": {
          ...catalog.models["grok-code"],
          id: "jev-1.13",
          name: "Jev 1.13",
          primitive: "system-one",
          api: {
            ...catalog.models["grok-code"].api,
            id: "jev-1.13",
            url: "https://opencode.ai/zen/go/v1",
          },
        },
      }

      const result = await hooks.provider!.models!(catalog, {})
      const variant = Object.values(result).find((model) => model.id.startsWith("jev-1.13@zen-"))
      expect(variant?.primitive).toBe("system-one")
      expect(variant?.api.id).toMatch(/^jev-1\.13@zen-/)
    } finally {
      dispose()
    }
  })
})

describe("zen System One compatibility discovery", () => {
  test("only synthesizes the exact free Jev model and preserves account-qualified ids", async () => {
    const dispose = configure([])
    try {
      let calls = 0
      setTestZenFetch(async (input, init) => {
        calls++
        expect(String(input)).toBe("https://opencode.ai/zen/v1/models")
        expect(init?.signal).toBeDefined()
        expect(init?.signal?.aborted).toBe(false)
        return new Response(
          JSON.stringify({
            object: "list",
            data: [
              { id: "jev-1.13", object: "model", owned_by: "opencode" },
              { id: "jev-1.13-free", object: "model", owned_by: "opencode" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      })

      expect(await discoverZenSystemOneModel("jev-1.13-free")).toEqual({
        id: "jev-1.13-free",
        name: "Jev 1.13 Free",
        baseURL: "https://opencode.ai/zen/v1",
        cost: { input: 0, output: 0 },
      })
      expect(await discoverZenSystemOneModel("jev-1.13-free@zen-test-account")).toEqual({
        id: "jev-1.13-free@zen-test-account",
        name: "Jev 1.13 Free",
        baseURL: "https://opencode.ai/zen/v1",
        cost: { input: 0, output: 0 },
      })
      expect(await discoverZenSystemOneModel("jev-1.13")).toBeUndefined()
      expect(await discoverZenSystemOneModel("jev-1.13-freeish")).toBeUndefined()
      expect(calls).toBe(1)
    } finally {
      dispose()
    }
  })

  test("fails closed when Zen model discovery is unavailable", async () => {
    const dispose = configure([])
    try {
      setTestZenFetch(async () => new Response("unavailable", { status: 503 }))
      expect(await discoverZenSystemOneModel("jev-1.13-free")).toBeUndefined()
    } finally {
      dispose()
    }
  })
})

describe("zen provider fetch wrapper", () => {
  const calls: Array<{ url: RequestInfo | URL; init?: RequestInit }> = []

  function stubFetch(responses: Response[]) {
    calls.length = 0
    let index = 0
    setTestZenFetch(async (url, init) => {
      calls.push({ url, init })
      return responses[Math.min(index++, responses.length - 1)]!
    })
  }

  function lastCall() {
    const last = calls.at(-1)!
    const headers = new Headers(last.init?.headers)
    const body = typeof last.init?.body === "string" ? JSON.parse(last.init.body) : undefined
    return { headers, body }
  }

  function runFetch(model: string, authorization?: string) {
    const headers = new Headers({ "x-opencode-session": "session-selector" })
    if (authorization) headers.set("authorization", `Bearer ${authorization}`)
    return zenProviderFetch("https://opencode.ai/zen/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
    })
  }

  function runGoFetch(model: string, authorization?: string) {
    const headers = new Headers({ "x-opencode-session": "session-selector" })
    if (authorization) headers.set("authorization", `Bearer ${authorization}`)
    return zenGoProviderFetch("https://opencode.ai/zen/go/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
    })
  }

  test("qualified id routes to that account and de-qualifies the wire model", async () => {
    const dispose = configure(["wrap-key-a", "wrap-key-b"])
    try {
      stubFetch([new Response(JSON.stringify({ choices: [] }), { status: 200 })])
      const snapshot = zenLimitSnapshot()
      const target = snapshot[1]!.accountId
      const response = await runFetch(`model-x@${target}`)
      expect(lastCall().body.model).toBe("model-x")
      expect(lastCall().headers.get("Authorization")).toBe("Bearer wrap-key-b")
      expect(response.headers.get(ROUTED_ACCOUNT_HEADER)).toBe(target)
    } finally {
      dispose()
    }
  })

  test("explicit account selection overrides an existing provider bearer", async () => {
    const dispose = configure(["explicit-key-a", "explicit-key-b"])
    try {
      stubFetch([new Response(JSON.stringify({ choices: [] }), { status: 200 })])
      const target = zenLimitSnapshot()[1]!.accountId
      await runFetch(`model-explicit@${target}`, "direct-provider-key")
      expect(lastCall().body.model).toBe("model-explicit")
      expect(lastCall().headers.get("Authorization")).toBe("Bearer explicit-key-b")
    } finally {
      dispose()
    }
  })

  test("bare Go model preserves the provider-selected bearer ahead of the pool default", async () => {
    const dispose = configure(["pool-default-key"])
    try {
      stubFetch([new Response(JSON.stringify({ choices: [] }), { status: 200 })])
      await runGoFetch("model-direct", "direct-go-key")
      expect(lastCall().headers.get("Authorization")).toBe("Bearer direct-go-key")
    } finally {
      dispose()
    }
  })

  test("bare Zen model ignores stale provider auth when the unified pool has a default", async () => {
    const dispose = configure(["pool-default-key"])
    try {
      stubFetch([new Response(JSON.stringify({ choices: [] }), { status: 200 })])
      await runFetch("model-stale", "stale-legacy-auth-key")
      expect(lastCall().headers.get("Authorization")).toBe("Bearer pool-default-key")
    } finally {
      dispose()
    }
  })

  test("public bootstrap sentinel yields to the real pool default", async () => {
    const dispose = configure(["pool-default-key"])
    try {
      stubFetch([new Response(JSON.stringify({ choices: [] }), { status: 200 })])
      await runFetch("model-public", ZEN_PUBLIC_API_KEY)
      expect(lastCall().headers.get("Authorization")).toBe("Bearer pool-default-key")
    } finally {
      dispose()
    }
  })

  test("removed explicit account fails closed instead of silently using another key", async () => {
    const dispose = configure(["available-key"])
    try {
      stubFetch([new Response(JSON.stringify({ choices: [] }), { status: 200 })])
      await expect(runFetch("model-missing@zen-deadbeef", "direct-go-key")).rejects.toThrow(
        "Selected OpenCode account zen-deadbeef is no longer available",
      )
      expect(calls).toHaveLength(0)
    } finally {
      dispose()
    }
  })

  test("the same session's next request uses the resolved key, with no session-pin side effect", async () => {
    const dispose = configure(["pin-key-a", "pin-key-b"])
    try {
      stubFetch([new Response(JSON.stringify({ choices: [] }), { status: 200 })])
      const target = zenLimitSnapshot()[1]!.accountId
      await runFetch(`model-y@${target}`)
      expect(lastCall().headers.get("Authorization")).toBe("Bearer pin-key-b")
      // Bare models resolve the default account each time (no affinity).
      await runFetch("model-y")
      expect(lastCall().headers.get("Authorization")).toBe("Bearer pin-key-a")
    } finally {
      dispose()
    }
  })

  test("a non-ok response is observed into the routed key's pool state", async () => {
    const dispose = configure(["observe-key-a"])
    try {
      stubFetch([
        new Response(JSON.stringify({ error: { message: "FreeUsageLimitError" } }), {
          status: 429,
          headers: { "retry-after": "120" },
        }),
      ])
      const account = zenLimitSnapshot()
      const target = account[0]!.accountId
      await runFetch(`model-z@${target}`)
      const after = zenLimitSnapshot()
      expect(after.find((row) => row.accountId === target)!.state).toBe("COOLING_DOWN")
      expect(after.find((row) => row.accountId === target)!.resetAt).not.toBeNull()
    } finally {
      dispose()
    }
  })
})

describe("zen routing authority", () => {
  test("resolves explicit and default accounts without exposing account suffixes upstream", async () => {
    const dispose = configure(["route-key-a", "route-key-b"])
    try {
      const snapshot = zenLimitSnapshot()
      const explicit = await resolveZenRequest(`jev-1.13-free@${snapshot[1]!.accountId}`)
      expect(explicit.modelID).toBe("jev-1.13-free")
      expect(explicit.accountID).toBe(snapshot[1]!.accountId)
      expect(explicit.apiKey).toBe("route-key-b")

      const fallback = await resolveZenRequest("jev-1.13-free")
      expect(fallback.modelID).toBe("jev-1.13-free")
      expect(fallback.accountID).toBe(snapshot[0]!.accountId)
      expect(fallback.apiKey).toBe("route-key-a")

      const zenPreferred = await resolveZenRequest("jev-1.13-free", "provider-specific-key", "opencode")
      expect(zenPreferred.modelID).toBe("jev-1.13-free")
      expect(zenPreferred.apiKey).toBe("route-key-a")
      expect(zenPreferred.accountID).toBe(snapshot[0]!.accountId)

      const goPreferred = await resolveZenRequest("jev-1.13-free", "provider-specific-key", "opencode-go")
      expect(goPreferred.modelID).toBe("jev-1.13-free")
      expect(goPreferred.apiKey).toBe("provider-specific-key")
      expect(goPreferred.accountID).toBeUndefined()

      const publicSentinel = await resolveZenRequest("jev-1.13-free", ZEN_PUBLIC_API_KEY)
      expect(publicSentinel.modelID).toBe("jev-1.13-free")
      expect(publicSentinel.accountID).toBe(snapshot[0]!.accountId)
      expect(publicSentinel.apiKey).toBe("route-key-a")
    } finally {
      dispose()
    }
  })

  test("preserves the public bootstrap sentinel when there is no real account", async () => {
    const dispose = configure([])
    try {
      const route = await resolveZenRequest("jev-1.13-free", ZEN_PUBLIC_API_KEY)
      expect(route.modelID).toBe("jev-1.13-free")
      expect(route.accountID).toBeUndefined()
      expect(route.apiKey).toBe(ZEN_PUBLIC_API_KEY)
    } finally {
      dispose()
    }
  })

  test("preserves direct Zen provider auth as an empty-pool compatibility fallback", async () => {
    const dispose = configure([])
    try {
      const route = await resolveZenRequest("jev-1.13-free", "legacy-direct-key", "opencode")
      expect(route.modelID).toBe("jev-1.13-free")
      expect(route.accountID).toBeUndefined()
      expect(route.apiKey).toBe("legacy-direct-key")
    } finally {
      dispose()
    }
  })

  test("a pool-owned legacy bearer yields to the current pool default", async () => {
    const dispose = configure([])
    try {
      setTestZenVaultCredentials([
        { apiKey: "legacy-migrated-key", label: "Migrated key", isDefault: false },
        { apiKey: "active-pool-key", label: "key3", isDefault: true },
      ])

      const route = await resolveZenRequest("jev-1.13-free", "legacy-migrated-key")
      const active = zenLimitSnapshot().find((row) => row.isDefault)
      expect(active).toBeDefined()
      expect(route.modelID).toBe("jev-1.13-free")
      expect(route.accountID).toBe(active!.accountId)
      expect(route.apiKey).toBe("active-pool-key")
    } finally {
      dispose()
    }
  })
})
