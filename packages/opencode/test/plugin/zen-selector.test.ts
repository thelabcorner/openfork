import { describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import {
  ZenGoPlugin,
  ZenPlugin,
  resetZenPoolForTest,
  setTestZenFetch,
  setTestZenVaultCredentials,
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

  function runFetch(model: string) {
    return zenProviderFetch("https://opencode.ai/zen/v1/chat/completions", {
      method: "POST",
      headers: new Headers({ "x-opencode-session": "session-selector" }),
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
    })
  }

  test("qualified id routes to that account and de-qualifies the wire model", async () => {
    const dispose = configure(["wrap-key-a", "wrap-key-b"])
    try {
      stubFetch([new Response(JSON.stringify({ choices: [] }), { status: 200 })])
      const snapshot = zenLimitSnapshot()
      const target = snapshot[1]!.accountId
      await runFetch(`model-x@${target}`)
      expect(lastCall().body.model).toBe("model-x")
      expect(lastCall().headers.get("Authorization")).toBe("Bearer wrap-key-b")
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
