import { describe, expect, test } from "bun:test"
import { mkdirSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  ZenPlugin,
  resetZenForkNotice,
  setTestZenAccountStore,
  setTestZenFetch,
  setTestZenForkActive,
  zenLimitSnapshot,
  zenProviderFetch,
} from "@/plugin/zen"

function freshRoot(): string {
  const root = join(tmpdir(), `opencode-zen-selector-${process.pid}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
  return root
}

function cleanup(root: string) {
  rmSync(root, { recursive: true, force: true })
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
  const hooks = await ZenPlugin({ serverUrl: new URL("http://127.0.0.1:1") } as any)
  return hooks.provider!.models!
}

describe("zen models hook", () => {
  test("empty registry leaves the catalog unchanged", async () => {
    const root = freshRoot()
    setTestZenAccountStore(root)
    const original = process.env.OPENCODE_API_KEY
    delete process.env.OPENCODE_API_KEY
    try {
      const models = await modelsHook()
      const catalog = baseCatalog()
      const result = await models(catalog, {})
      expect(result).toBe(catalog.models)
    } finally {
      if (original === undefined) delete process.env.OPENCODE_API_KEY
      else process.env.OPENCODE_API_KEY = original
      cleanup(root)
    }
  })

  test("each key emits one variant per base model with label names and qualified api ids", async () => {
    const root = freshRoot()
    setTestZenAccountStore(root)
    const original = process.env.OPENCODE_API_KEY
    const original2 = process.env.OPENCODE_API_KEY_2
    process.env.OPENCODE_API_KEY = "selector-key-a"
    process.env.OPENCODE_API_KEY_2 = "selector-key-b"
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
        expect(model.name.startsWith("Grok Code (key-")).toBe(true)
        expect(id).not.toContain("selector-key")
      }
    } finally {
      if (original === undefined) delete process.env.OPENCODE_API_KEY
      else process.env.OPENCODE_API_KEY = original
      if (original2 === undefined) delete process.env.OPENCODE_API_KEY_2
      else process.env.OPENCODE_API_KEY_2 = original2
      cleanup(root)
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

  function runFetch(model: string, session = "session-selector") {
    return zenProviderFetch("https://opencode.ai/zen/v1/chat/completions", {
      method: "POST",
      headers: new Headers({ "x-opencode-session": session }),
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
    })
  }

  function withKeys(keys: string[], run: () => Promise<void>) {
    const root = freshRoot()
    setTestZenAccountStore(root)
    resetZenForkNotice()
    const names = ["OPENCODE_API_KEY", "OPENCODE_API_KEY_2"]
    const original = names.map((name) => process.env[name])
    for (const [index, name] of names.entries()) process.env[name] = keys[index]
    setTestZenForkActive(false)
    return {
      async finally() {
        for (const [index, name] of names.entries()) {
          const value = original[index]
          if (value === undefined) delete process.env[name]
          else process.env[name] = value
        }
        setTestZenForkActive(undefined)
        setTestZenFetch(undefined)
        cleanup(root)
      },
    }
  }

  test("qualified id pins the session and de-qualifies the wire model", async () => {
    const handle = withKeys(["wrap-key-a", "wrap-key-b"], async () => {})
    try {
      stubFetch([new Response(JSON.stringify({ choices: [] }), { status: 200 })])
      const snapshot = zenLimitSnapshot()
      const target = snapshot[1]!.accountId
      await runFetch(`model-x@${target}`)
      expect(lastCall().body.model).toBe("model-x")
      expect(lastCall().headers.get("Authorization")).toBe("Bearer wrap-key-b")
      await runFetch("model-x")
      expect(lastCall().headers.get("Authorization")).toBe("Bearer wrap-key-b")
    } finally {
      handle.finally()
    }
  })

  test("auto:sticky routes through the router and de-qualifies the wire model", async () => {
    const handle = withKeys(["sticky-key-a", "sticky-key-b"], async () => {})
    try {
      stubFetch([new Response(JSON.stringify({ choices: [] }), { status: 200 })])
      await runFetch("model-y@zen-auto:sticky")
      const first = lastCall()
      expect(first.body.model).toBe("model-y")
      expect(first.headers.get("Authorization")?.startsWith("Bearer sticky-key-")).toBe(true)
      await runFetch("model-y")
      expect(lastCall().headers.get("Authorization")).toBe(first.headers.get("Authorization"))
    } finally {
      handle.finally()
    }
  })

  test("a non-ok response is observed into the routed key's governor", async () => {
    const handle = withKeys(["observe-key-a"], async () => {})
    try {
      stubFetch([
        new Response(JSON.stringify({ error: { message: "FreeUsageLimitError" } }), {
          status: 429,
          headers: { "retry-after": "120" },
        }),
      ])
      const account = zenLimitSnapshot()[0]!
      await runFetch(`model-z@${account.accountId}`)
      const after = zenLimitSnapshot()[0]!
      expect(after.state).toBe("COOLING_DOWN")
      expect(after.resetAt).not.toBeNull()
      expect(after.hits.length).toBe(1)
      expect(after.hits[0]!.kind).toBe("rate-limit")
    } finally {
      handle.finally()
    }
  })

  test("ok responses stream through untouched and are not observed as failures", async () => {
    const handle = withKeys(["clean-key-a"], async () => {})
    try {
      const ok = new Response(JSON.stringify({ choices: [] }), { status: 200 })
      stubFetch([ok])
      await runFetch("model-w")
      const account = zenLimitSnapshot()[0]!
      expect(account.state).toBe("READY")
      expect(account.hits.length).toBe(0)
    } finally {
      handle.finally()
    }
  })
})
