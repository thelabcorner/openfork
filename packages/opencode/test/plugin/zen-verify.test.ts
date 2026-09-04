import { describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { Effect } from "effect"
import { ZenAccountPool, stableZenIdentity, zenEnvCredentials } from "@/plugin/zen-accounts"
import {
  ZenGoPlugin,
  ZenPlugin,
  resetZenPoolForTest,
  setTestZenFetch,
  setTestZenVaultCredentials,
  zenLimitSnapshot,
  zenProviderFetch,
} from "@/plugin/zen"
import { opencodeZen, zenKeyLimitsRows } from "@/quota/providers/opencode-zen"

/**
 * Independent verification suite for the unified zen multi-key pool
 * (verify-tests). Authored against the architecture decisions, deliberately
 * NOT extending core-builder's zen-smoke.test.ts (author-suite blind spots).
 *
 * The pool (`ZenAccountPool`) is exercised directly as a pure class; plugin
 * behavior is exercised black-box against the module-level pool the plugin
 * actually reads: routing/auth through `zenProviderFetch` (with the base
 * fetch stubbed via setTestZenFetch) and observation through the event hook —
 * the same pool zenLimitSnapshot and the quota adapter render from.
 */

const DAY_MS = 86_400_000
const SERVER = new URL("http://127.0.0.1:4096")

const ENV_NAMES = ["OPENCODE_API_KEY", "OPENCODE_API_KEY_2", "OPENCODE_API_KEY_3", "OPENCODE_API_KEY_4", "OPENCODE_API_KEYS"]

function withEnv(keys: Record<string, string | undefined>, run: () => void) {
  const saved = new Map(ENV_NAMES.map((name) => [name, process.env[name]]))
  try {
    for (const name of ENV_NAMES) delete process.env[name]
    for (const [name, value] of Object.entries(keys)) {
      if (value !== undefined) process.env[name] = value
    }
    run()
  } finally {
    for (const name of ENV_NAMES) {
      const value = saved.get(name)
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

async function withEnvAsync(keys: Record<string, string | undefined>, run: () => Promise<void>) {
  const saved = new Map(ENV_NAMES.map((name) => [name, process.env[name]]))
  try {
    for (const name of ENV_NAMES) delete process.env[name]
    for (const [name, value] of Object.entries(keys)) {
      if (value !== undefined) process.env[name] = value
    }
    await run()
  } finally {
    for (const name of ENV_NAMES) {
      const value = saved.get(name)
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

/**
 * Isolate module state, then configure the pool from env + a vault list.
 * The vault override bypasses the SQLite store; env is applied live.
 */
function configure({ env, vault }: { env: Record<string, string>; vault?: { apiKey: string; label?: string; isDefault?: boolean }[] }) {
  resetZenPoolForTest()
  setTestZenVaultCredentials(undefined)
  const names = Object.keys(env)
  const saved = new Map(names.map((name) => [name, process.env[name]]))
  for (const [name, value] of Object.entries(env)) process.env[name] = value
  setTestZenVaultCredentials(vault ?? [])
  return () => {
    for (const name of names) {
      const value = saved.get(name)
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    setTestZenFetch(undefined)
    setTestZenVaultCredentials(undefined)
    resetZenPoolForTest()
  }
}

function emptySnapshot(now: number) {
  return {
    since: now - DAY_MS,
    until: now,
    currentDayStart: Math.floor(now / DAY_MS) * DAY_MS,
    currentRequests: 0,
    days: [],
    limitHits: [],
  }
}

type CapturedCall = { url: RequestInfo | URL; init: RequestInit | undefined }

/** Stub base fetch that records every call and answers with the supplied responses in order. */
function captureFetch(responses: Array<{ status: number; body?: string; headers?: Record<string, string> }>) {
  const calls: CapturedCall[] = []
  setTestZenFetch(async (url, init) => {
    calls.push({ url, init })
    const next = responses[calls.length - 1] ?? responses[responses.length - 1]!
    return new Response(next.body ?? "{}", { status: next.status, headers: next.headers })
  })
  return calls
}

type ZenHooks = Awaited<ReturnType<typeof ZenPlugin>>

async function runEvent(hooks: ZenHooks, event: unknown) {
  await hooks.event!({ event } as Parameters<NonNullable<ZenHooks["event"]>>[0])
}

function apiErrorMessage(modelID: string, data: Record<string, unknown>) {
  return {
    type: "message.updated",
    properties: {
      sessionID: "verify-session",
      info: { role: "assistant", providerID: "opencode", modelID, error: { name: "APIError", data } },
    },
  }
}

function completedMessage(modelID: string, completedAt: number) {
  return {
    type: "message.updated",
    properties: {
      sessionID: "verify-session",
      info: { role: "assistant", providerID: "opencode", modelID, time: { completed: completedAt } },
    },
  }
}

/** One provider request for `model`, via the routing wrapper. */
async function providerRequest(model: string, responses?: Array<{ status: number; body?: string; headers?: Record<string, string> }>) {
  const calls = captureFetch(responses ?? [{ status: 200 }])
  await zenProviderFetch(SERVER, {
    method: "POST",
    headers: new Headers({ "x-opencode-session": "verify-session" }),
    body: JSON.stringify({ model }),
  })
  return calls
}

// --- pool: intake + defaults -------------------------------------------------

describe("verify: zen env intake", () => {
  test("priority: single, then numbered _2.._10; _11 is ignored", () => {
    const credentials = zenEnvCredentials({
      OPENCODE_API_KEY: "key-1",
      OPENCODE_API_KEY_2: "key-2",
      OPENCODE_API_KEY_10: "key-10",
      OPENCODE_API_KEY_11: "key-11",
    })
    expect(credentials.map((credential) => credential.apiKey)).toEqual(["key-1", "key-2", "key-10"])
  })

  test("comma list entries are trimmed and quote-stripped", () => {
    const credentials = zenEnvCredentials({ OPENCODE_API_KEYS: ' "a" , b ,,' })
    expect(credentials.map((credential) => credential.apiKey)).toEqual(["a", "b"])
  })

  test("ids and labels never contain the raw key", () => {
    const secret = "super-secret-raw-key-material"
    const id = stableZenIdentity(secret)
    expect(id.startsWith("zen-")).toBe(true)
    expect(id).not.toContain("super-secret")
    const pool = new ZenAccountPool()
    pool.sync([{ vaultId: "v1", apiKey: secret, label: "mine", isDefault: true }])
    for (const account of pool.all()) {
      expect(account.id).not.toContain(secret)
      expect(account.label).not.toContain(secret)
      expect(account.id).toBe(stableZenIdentity(secret))
    }
  })
})

describe("verify: zen pool defaults + dedup", () => {
  test("the same key across env and vault dedupes to one account; env default wins", () => {
    const dispose = configure({
      env: { OPENCODE_API_KEY: "dup-key", OPENCODE_API_KEYS: "dup-key, other-key" },
      vault: [{ apiKey: "dup-key", label: "vault copy" }],
    })
    try {
      const snapshot = zenLimitSnapshot()
      expect(snapshot.length).toBe(2)
      expect(new Set(snapshot.map((row) => row.accountId)).size).toBe(2)
      const dupped = snapshot.find((row) => row.accountId === stableZenIdentity("dup-key"))!
      expect(dupped.source).toBe("env")
      expect(dupped.isDefault).toBe(true)
    } finally {
      dispose()
    }
  })

  test("vault-default flag is honored only when no env key exists", () => {
    const dispose = configure({ env: {}, vault: [
      { apiKey: "key-a", label: "lab-a" },
      { apiKey: "key-b", label: "lab-b", isDefault: true },
    ] })
    try {
      expect(zenLimitSnapshot().find((row) => row.isDefault)!.label).toBe("lab-b")
    } finally {
      dispose()
    }

    const dispose2 = configure({ env: { OPENCODE_API_KEY: "env-a" }, vault: [
      { apiKey: "vault-b", label: "lab-b", isDefault: true },
    ] })
    try {
      expect(zenLimitSnapshot().find((row) => row.isDefault)!.accountId).toBe(stableZenIdentity("env-a"))
    } finally {
      dispose2()
    }
  })
})

// --- routing wrapper: black-box ----------------------------------------------

describe("verify: zenProviderFetch routing wrapper", () => {
  test("empty pool -> full passthrough, untouched init", async () => {
    const dispose = configure({ env: {} })
    try {
      const calls = captureFetch([{ status: 200 }])
      const init = { method: "POST", body: JSON.stringify({ model: "big-pickle" }) }
      await zenProviderFetch(SERVER, init)
      expect(calls.length).toBe(1)
      expect(calls[0]!.init).toBe(init)
    } finally {
      dispose()
    }
  })

  test("multi-key env config: Authorization is set per request, wire id preserved for bare models", async () => {
    const dispose = configure({ env: { OPENCODE_API_KEY: "key-a", OPENCODE_API_KEY_2: "key-b" } })
    try {
      const calls = await providerRequest("big-pickle")
      const headers = new Headers(calls[0]!.init?.headers)
      expect(headers.get("Authorization")).toBe("Bearer key-a")
      expect(JSON.parse(String(calls[0]!.init?.body)).model).toBe("big-pickle")
    } finally {
      dispose()
    }
  })

  test("qualified model id routes to the named account and de-qualifies the wire body", async () => {
    const dispose = configure({
      env: { OPENCODE_API_KEY: "key-a" },
      vault: [{ apiKey: "key-b", label: "named" }, { apiKey: "key-c", label: "named-2" }],
    })
    try {
      const target = zenLimitSnapshot().find((row) => row.label === "named")!.accountId
      const calls = await providerRequest(`big-pickle@${target}`)
      const headers = new Headers(calls[0]!.init?.headers)
      expect(headers.get("Authorization")).toBe("Bearer key-b")
      expect(JSON.parse(String(calls[0]!.init?.body)).model).toBe("big-pickle")
    } finally {
      dispose()
    }
  })

  test("an unknown account suffix falls back to the default key (never a 404)", async () => {
    const dispose = configure({ env: { OPENCODE_API_KEY: "key-a", OPENCODE_API_KEY_2: "key-b" } })
    try {
      const calls = await providerRequest("big-pickle@zen-deadbeef")
      expect(new Headers(calls[0]!.init?.headers).get("Authorization")).toBe("Bearer key-a")
      expect(JSON.parse(String(calls[0]!.init?.body)).model).toBe("big-pickle")
    } finally {
      dispose()
    }
  })

  test("non-ok response is observed into the resolved account (retry-after honored)", async () => {
    const dispose = configure({ env: { OPENCODE_API_KEY: "key-a", OPENCODE_API_KEY_2: "key-b" } })
    try {
      const target = zenLimitSnapshot()[1]!.accountId
      const now = Date.now()
      await providerRequest(`big-pickle@${target}`, [
        { status: 429, body: '{"error":"rate limited"}', headers: { "retry-after": "60" } },
      ])
      const row = zenLimitSnapshot(now).find((entry) => entry.accountId === target)!
      expect(row.state).toBe("COOLING_DOWN")
      expect(row.resetAt).not.toBeNull()
      expect(Math.abs(row.resetAt! - (now + 60_000))).toBeLessThan(2_000)
    } finally {
      dispose()
    }
  })

  test("an exhausted account is marked QUOTA_EXHAUSTED with no reset window", async () => {
    const dispose = configure({ env: { OPENCODE_API_KEY: "key-a" } })
    try {
      const target = zenLimitSnapshot()[0]!.accountId
      await providerRequest(`big-pickle@${target}`, [{ status: 402, body: '{"error":"quota"}' }])
      const row = zenLimitSnapshot().find((entry) => entry.accountId === target)!
      expect(row.state).toBe("QUOTA_EXHAUSTED")
      expect(row.resetAt).toBeNull()
    } finally {
      dispose()
    }
  })

  test("cooldown expires after the observed retry-after window", async () => {
    const dispose = configure({ env: { OPENCODE_API_KEY: "key-a" } })
    try {
      const target = zenLimitSnapshot()[0]!.accountId
      const now = Date.now()
      await providerRequest(`big-pickle@${target}`, [{ status: 429, headers: { "retry-after": "60" } }])
      expect(zenLimitSnapshot(now).find((row) => row.accountId === target)!.state).toBe("COOLING_DOWN")
      // The pool clears the cooldown once the observed reset window passes.
      expect(zenLimitSnapshot(now + 61_000).find((row) => row.accountId === target)!.state).toBe("READY")
    } finally {
      dispose()
    }
  })
})

// --- plugin surfaces: models hook + event hook --------------------------------

describe("verify: zen plugin hooks", () => {
  test("provider.models emits per-account variants and keeps bare ids", async () => {
    const dispose = configure({ env: { OPENCODE_API_KEY: "key-a", OPENCODE_API_KEY_2: "key-b" } })
    try {
      const hooks = await ZenPlugin({ serverUrl: SERVER } as PluginInput)
      const models = await hooks.provider!.models!(
        { models: { "big-pickle": { id: "big-pickle", name: "Big Pickle" } } } as never,
        {} as never,
      )
      expect(models["big-pickle"]).toBeDefined()
      for (const row of zenLimitSnapshot()) {
        const variant = models[`big-pickle@${row.accountId}`]
        expect(variant).toBeDefined()
        expect(variant!.name).toBe(`Big Pickle (${row.label})`)
        expect(variant!.api.id).toBe(`big-pickle@${row.accountId}`)
      }
      expect(Object.keys(models).length).toBe(1 + zenLimitSnapshot().length)
    } finally {
      dispose()
    }
  })

  test("ZenGoPlugin exposes the same variants under provider id opencode-go", async () => {
    const dispose = configure({ env: { OPENCODE_API_KEY: "go-key-a" } })
    try {
      const hooks = await ZenGoPlugin({ serverUrl: SERVER } as PluginInput)
      expect(hooks.provider!.id).toBe("opencode-go")
      const models = await hooks.provider!.models!(
        { models: { "big-pickle": { id: "big-pickle", name: "Big Pickle" } } } as never,
        {} as never,
      )
      const row = zenLimitSnapshot()[0]!
      expect(models[`big-pickle@${row.accountId}`]).toBeDefined()
    } finally {
      dispose()
    }
  })

  test("event hook: APIError cools the named account; completed message clears it", async () => {
    const dispose = configure({ env: { OPENCODE_API_KEY: "key-a", OPENCODE_API_KEY_2: "key-b" } })
    try {
      const hooks = await ZenPlugin({ serverUrl: SERVER } as PluginInput)
      const target = zenLimitSnapshot()[1]!.accountId
      const modelID = `big-pickle@${target}`
      const row = () => zenLimitSnapshot().find((entry) => entry.accountId === target)!

      await runEvent(hooks, apiErrorMessage(modelID, { statusCode: 429, responseBody: '{"error":"FreeUsageLimitError"}' }))
      expect(row().state).toBe("COOLING_DOWN")
      expect(row().resetAt).not.toBeNull()

      await runEvent(hooks, completedMessage(modelID, Date.now()))
      expect(row().state).toBe("READY")
      expect(row().resetAt).toBeNull()
    } finally {
      dispose()
    }
  })

  test("event hook ignores non-Zen providers, bare model ids, and unknown accounts", async () => {
    const dispose = configure({ env: { OPENCODE_API_KEY: "key-a" } })
    try {
      const hooks = await ZenPlugin({ serverUrl: SERVER } as PluginInput)
      const before = zenLimitSnapshot().map((entry) => entry.state)

      await runEvent(hooks, {
        type: "message.updated",
        properties: {
          sessionID: "s1",
          info: { role: "assistant", providerID: "anthropic", modelID: "big-pickle@zen-abc", error: { name: "APIError", data: { statusCode: 429 } } },
        },
      })
      // Bare (unqualified) model: nothing to attribute to.
      await runEvent(hooks, apiErrorMessage("big-pickle", { statusCode: 429 }))
      // Unknown account suffix: no pool entry.
      await runEvent(hooks, apiErrorMessage("big-pickle@zen-deadbeef", { statusCode: 429 }))
      // Non-message events are no-ops.
      await runEvent(hooks, { type: "session.updated", properties: {} })

      expect(zenLimitSnapshot().map((entry) => entry.state)).toEqual(before)
    } finally {
      dispose()
    }
  })
})

// --- snapshot + adapter rows ---------------------------------------------------

describe("verify: zenLimitSnapshot shape", () => {
  test("full row shape and per-state values", async () => {
    const dispose = configure({ env: { OPENCODE_API_KEY: "key-a", OPENCODE_API_KEY_2: "key-b", OPENCODE_API_KEY_3: "key-c" } })
    try {
      const [first] = zenLimitSnapshot()
      const now = Date.now()

      await providerRequest(`model-a@${first!.accountId}`, [
        { status: 429, body: '{"error":"rate limited"}', headers: { "retry-after": "60" } },
      ])
      await providerRequest(`model-b@${zenLimitSnapshot()[1]!.accountId}`, [{ status: 402, body: '{"error":"quota"}' }])

      const snapshot = zenLimitSnapshot(now)
      expect(snapshot.length).toBe(3)
      const expectedKeys = ["accountId", "isDefault", "label", "resetAt", "source", "state"].sort()
      for (const row of snapshot) {
        expect(Object.keys(row).sort()).toEqual(expectedKeys)
        expect(row.source).toBe("env")
      }
      const byId = new Map(snapshot.map((row) => [row.accountId, row]))
      const cooling = byId.get(first!.accountId)!
      expect(cooling.state).toBe("COOLING_DOWN")
      expect(cooling.resetAt).not.toBeNull()
      const exhausted = byId.get(zenLimitSnapshot()[1]!.accountId)!
      expect(exhausted.state).toBe("QUOTA_EXHAUSTED")
      expect(exhausted.resetAt).toBeNull()
      const ready = byId.get(zenLimitSnapshot()[2]!.accountId)!
      expect(ready.state).toBe("READY")
      expect(ready.resetAt).toBeNull()
    } finally {
      dispose()
    }
  })

  test("vault-sourced rows report source vault and default flag", async () => {
    const dispose = configure({ env: {}, vault: [{ apiKey: "vault-key", label: "Primary" }] })
    try {
      const snapshot = zenLimitSnapshot()
      expect(snapshot).toHaveLength(1)
      expect(snapshot[0]!.source).toBe("vault")
      expect(snapshot[0]!.label).toBe("Primary")
      expect(snapshot[0]!.isDefault).toBe(true)
    } finally {
      dispose()
    }
  })
})

describe("verify: zenKeyLimitsRows adapter rows", () => {
  test("row shape per unified schema; cooling/exhausted mapping", async () => {
    const dispose = configure({ env: { OPENCODE_API_KEY: "key-a", OPENCODE_API_KEY_2: "key-b" } })
    try {
      const [first] = zenLimitSnapshot()
      await providerRequest(`model-a@${first!.accountId}`, [
        { status: 429, body: '{"error":"rate limited"}', headers: { "retry-after": "60" } },
      ])

      const now = Date.now()
      const rows = zenKeyLimitsRows(emptySnapshot(now), now)
      expect(rows.length).toBe(2)
      const expectedKeys = [
        "estimateSource",
        "exhausted",
        "isDefault",
        "keyId",
        "label",
        "limitEstimate",
        "remainingPercent",
        "resetAfterSeconds",
        "resetAt",
        "state",
        "usedObserved",
      ].sort()
      for (const row of rows) expect(Object.keys(row).sort()).toEqual(expectedKeys)

      const cooling = rows.find((row) => row.keyId === first!.accountId)!
      expect(cooling.state).toBe("cooling")
      expect(cooling.exhausted).toBe(false)
      expect(cooling.isDefault).toBe(true)
      expect(cooling.resetAfterSeconds).toBeGreaterThan(0)
      // The free-tier estimator is pool-wide: every row shares estimate.used.
      expect(cooling.usedObserved).toBe(0)
      expect(cooling.limitEstimate).toBe(200)
      expect(cooling.estimateSource).toBe("fallback")

      await providerRequest(`model-b@${zenLimitSnapshot()[1]!.accountId}`, [{ status: 402, body: '{"error":"quota"}' }])
      const exhausted = zenKeyLimitsRows(emptySnapshot(now), now).find((row) => row.keyId !== first!.accountId)!
      expect(exhausted.state).toBe("exhausted")
      expect(exhausted.exhausted).toBe(true)
      expect(exhausted.resetAfterSeconds).toBeNull()
    } finally {
      dispose()
    }
  })

  test("empty registry -> byte-identical aggregate output", async () => {
    const dispose = configure({ env: {} })
    try {
      const now = Date.now()
      const adapter = opencodeZen({ snapshot: () => Effect.succeed(emptySnapshot(now)) })
      const result = (await Effect.runPromise(adapter.fetch())) as { usage?: Record<string, unknown>; providerId?: string }
      expect(result.usage && "zenAccounts" in result.usage).toBe(false)
      expect(result.providerId).toBe("opencode-zen")

      const calls = captureFetch([{ status: 200 }])
      const init = { method: "POST", body: JSON.stringify({ model: "big-pickle" }) }
      await zenProviderFetch(SERVER, init)
      expect(calls.length).toBe(1)
      expect(calls[0]!.init).toBe(init)
    } finally {
      dispose()
    }
  })
})

// --- env plumbing through the pool --------------------------------------------

describe("verify: environment key plumbing", () => {
  test("pool.sync keeps the first-declared env key default across resyncs", async () => {
    const dispose = configure({ env: {} })
    try {
      await withEnvAsync({ OPENCODE_API_KEY: "first", OPENCODE_API_KEY_2: "second" }, async () => {
        setTestZenVaultCredentials([])
        const snapshot = zenLimitSnapshot()
        expect(snapshot.length).toBe(2)
        expect(snapshot[0]!.isDefault).toBe(true)
        expect(snapshot[0]!.accountId).toBe(stableZenIdentity("first"))
      })
    } finally {
      dispose()
    }
  })
})
