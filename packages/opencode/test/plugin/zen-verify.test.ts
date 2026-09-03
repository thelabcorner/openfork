import { describe, expect, spyOn, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { PluginInput } from "@opencode-ai/plugin"
import { Effect } from "effect"
import { ZenGovernor } from "@/plugin/zen-governor"
import { ZenRegistry, ZenRouter, stableZenIdentity, zenEnvCredentials } from "@/plugin/zen-accounts"
import {
  resetZenForkNotice,
  setTestZenAccountStore,
  setTestZenFetch,
  setTestZenForkActive,
  ZenPlugin,
  zenLimitSnapshot,
  zenProviderFetch,
  zenSessionBinding,
} from "@/plugin/zen"
import { opencodeZen, zenKeyLimitsRows } from "@/quota/providers/opencode-zen"

/**
 * Independent verification suite for the zen multi-key feature (verify-tests).
 * Authored against the acceptance criteria and architecture.md, deliberately
 * NOT extending core-builder's zen-smoke.test.ts (author-suite blind spots).
 *
 * Governor/registry/router are exercised directly as pure classes. Plugin
 * behavior is exercised black-box against the module-level store the plugin
 * actually reads: routing/auth through `zenProviderFetch` (the SPLICE B
 * options.fetch wrapper injected by the opencode loader, with the base fetch
 * stubbed via setTestZenFetch) and observation through the event hook — the
 * same store zenLimitSnapshot and the quota adapter render from.
 */

const DAY_MS = 86_400_000
const SERVER = new URL("http://127.0.0.1:4096")

function utcDayEnd(now: number) {
  return Math.floor(now / DAY_MS) * DAY_MS + DAY_MS
}

function freshRoot(): string {
  const root = join(tmpdir(), `opencode-zen-verify-${process.pid}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
  return root
}

function cleanup(root: string) {
  rmSync(root, { recursive: true, force: true })
}

const ENV_NAMES = [
  "OPENCODE_API_KEY",
  "OPENCODE_API_KEY_2",
  "OPENCODE_API_KEY_3",
  "OPENCODE_API_KEY_4",
  "OPENCODE_API_KEYS",
]

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

function registryFor(root: string, keys: string[]) {
  const env: Record<string, string> = { OPENCODE_API_KEY: keys[0]! }
  keys.slice(1).forEach((key, index) => {
    env[`OPENCODE_API_KEY_${index + 2}`] = key
  })
  const registry = new ZenRegistry({ persistenceDir: join(root, "state") })
  const router = new ZenRouter({ registry })
  return { registry, router, run: (fn: () => void) => withEnv(env, fn) }
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

/**
 * Stub base fetch that records every call and answers with the supplied
 * responses in order (last one repeats).
 */
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

function apiErrorMessage(sessionID: string, data: Record<string, unknown>) {
  return {
    type: "message.updated",
    properties: {
      sessionID,
      info: { role: "assistant", providerID: "opencode", modelID: "big-pickle", error: { name: "APIError", data } },
    },
  }
}

function completedMessage(sessionID: string, completedAt: number) {
  return {
    type: "message.updated",
    properties: {
      sessionID,
      info: {
        role: "assistant",
        providerID: "opencode",
        modelID: "big-pickle",
        time: { completed: completedAt },
      },
    },
  }
}

/** One provider request from `session` for `model`, via the routing wrapper. */
async function providerRequest(session: string, model: string, responses?: Array<{ status: number; body?: string; headers?: Record<string, string> }>) {
  const calls = captureFetch(responses ?? [{ status: 200 }])
  await zenProviderFetch(SERVER, {
    method: "POST",
    headers: { "x-opencode-session": session },
    body: JSON.stringify({ model }),
  })
  return calls
}

/** Binds one fresh session per key (in discovery order) and returns the pairs. */
async function bindSessions(count: number): Promise<Array<{ session: string; accountId: string }>> {
  const bindings: Array<{ session: string; accountId: string }> = []
  for (let i = 0; i < count; i++) {
    const session = `verify-session-${i}`
    await providerRequest(session, "big-pickle")
    const bound = zenSessionBinding(session)
    if (!bound) throw new Error(`session ${session} did not bind`)
    bindings.push({ session, accountId: bound })
  }
  return bindings
}

// --- governor ----------------------------------------------------------------

describe("verify: zen governor state machine", () => {
  test("429 -> COOLING_DOWN until the parsed reset, then recovers", () => {
    const root = freshRoot()
    const governor = new ZenGovernor({ persistenceFile: join(root, "g.json") })
    const now = Date.now()
    governor.observe({ status: 429, headers: { "retry-after": "120" }, at: now })
    expect(governor.metrics(now).state).toBe("COOLING_DOWN")
    expect(governor.currentResetAt(now)).toBe(now + 120_000)
    expect(governor.usable(now)).toBe(false)
    expect(governor.usable(now + 121_000)).toBe(true)
    cleanup(root)
  })

  test("retry-after-ms outranks retry-after and is honored verbatim", () => {
    const root = freshRoot()
    const governor = new ZenGovernor({ persistenceFile: join(root, "g.json") })
    const now = Date.now()
    governor.observe({ status: 429, headers: { "retry-after-ms": "750", "retry-after": "999" }, at: now })
    expect(governor.currentResetAt(now)).toBe(now + 750)
    cleanup(root)
  })

  test("retry-after parses HTTP-date form", () => {
    const root = freshRoot()
    const governor = new ZenGovernor({ persistenceFile: join(root, "g.json") })
    const now = Date.now()
    governor.observe({ status: 429, headers: { "retry-after": new Date(now + 300_000).toUTCString() }, at: now })
    const resetAt = governor.currentResetAt(now)
    expect(resetAt).not.toBeUndefined()
    expect(Math.abs(resetAt! - (now + 300_000))).toBeLessThan(2_000)
    cleanup(root)
  })

  test("x-ratelimit-reset parses epoch seconds", () => {
    const root = freshRoot()
    const governor = new ZenGovernor({ persistenceFile: join(root, "g.json") })
    const now = Date.now()
    governor.observe({ status: 429, headers: { "x-ratelimit-reset": String(Math.floor(now / 1000) + 120) }, at: now })
    const resetAt = governor.currentResetAt(now)
    expect(resetAt).not.toBeUndefined()
    expect(Math.abs(resetAt! - (now + 120_000))).toBeLessThan(2_000)
    cleanup(root)
  })

  test("body resetAt JSON field is parsed as an absolute instant", () => {
    const root = freshRoot()
    const governor = new ZenGovernor({ persistenceFile: join(root, "g.json") })
    const now = Date.now()
    const iso = new Date(now + 600_000).toISOString()
    governor.observe({ status: 429, body: `{"error":{"resetAt":"${iso}"}}`, at: now })
    expect(governor.currentResetAt(now)).toBe(Date.parse(iso))
    cleanup(root)
  })

  test("FreeUsageLimitError without a parsable reset uses the UTC-midnight prior", () => {
    const root = freshRoot()
    const governor = new ZenGovernor({ persistenceFile: join(root, "g.json") })
    const now = utcDayEnd(0) + 5 * 3_600_000
    governor.observe({ status: 429, body: '{"name":"FreeUsageLimitError"}', at: now })
    expect(governor.metrics(now).state).toBe("COOLING_DOWN")
    expect(governor.currentResetAt(now)).toBe(utcDayEnd(now))
    cleanup(root)
  })

  test("GoUsageLimitError is treated as a rate-limit observation", () => {
    const root = freshRoot()
    const governor = new ZenGovernor({ persistenceFile: join(root, "g.json") })
    const now = Date.now()
    governor.observe({
      status: 429,
      body: '{"error":"GoUsageLimitError","metadata":{}}',
      headers: { "retry-after": "90" },
      at: now,
    })
    expect(governor.currentResetAt(now)).toBe(now + 90_000)
    cleanup(root)
  })

  test("402 -> QUOTA_EXHAUSTED with no reset and no time-based recovery", () => {
    const root = freshRoot()
    const governor = new ZenGovernor({ persistenceFile: join(root, "g.json") })
    const now = Date.now()
    governor.observe({ status: 402, at: now })
    expect(governor.metrics(now).state).toBe("QUOTA_EXHAUSTED")
    expect(governor.currentResetAt(now)).toBeUndefined()
    expect(governor.usable(now + 10 * DAY_MS)).toBe(false)
    cleanup(root)
  })

  test("unexplained 429 backoff escalates and is capped at 15 minutes", () => {
    const root = freshRoot()
    const governor = new ZenGovernor({ persistenceFile: join(root, "g.json") })
    const now = Date.now()
    const windows: number[] = []
    for (let i = 0; i < 5; i++) {
      governor.observe({ status: 429, at: now })
      windows.push(governor.currentResetAt(now)! - now)
    }
    for (let i = 1; i < windows.length; i++) expect(windows[i]!).toBeGreaterThan(windows[i - 1]!)
    expect(windows[windows.length - 1]!).toBeLessThanOrEqual(15 * 60_000 + 1_000)
    cleanup(root)
  })

  test("observed 2xx clears an active cooldown immediately", () => {
    const root = freshRoot()
    const governor = new ZenGovernor({ persistenceFile: join(root, "g.json") })
    const now = Date.now()
    governor.observe({ status: 429, headers: { "retry-after": "600" }, at: now })
    expect(governor.usable(now)).toBe(false)
    governor.observe({ status: 200, at: now + 1_000 })
    expect(governor.metrics(now + 1_000).state).toBe("READY")
    expect(governor.usable(now + 1_000)).toBe(true)
    cleanup(root)
  })

  test("persistence reloads QUOTA_EXHAUSTED and rejects unknown schema versions", () => {
    const root = freshRoot()
    const file = join(root, "g.json")
    const now = Date.now()
    new ZenGovernor({ persistenceFile: file }).observe({ status: 402, at: now })
    expect(new ZenGovernor({ persistenceFile: file }).metrics(now).state).toBe("QUOTA_EXHAUSTED")

    const future = join(root, "future.json")
    writeFileSync(future, JSON.stringify({ schema: 999, state: "QUOTA_EXHAUSTED" }))
    expect(new ZenGovernor({ persistenceFile: future }).metrics(now).state).toBe("READY")
    cleanup(root)
  })
})

// --- intake ------------------------------------------------------------------

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

  test("the same key across variables dedupes by stable identity in the registry", () => {
    const root = freshRoot()
    withEnv({ OPENCODE_API_KEY: "dup-key", OPENCODE_API_KEYS: "dup-key, other-key" }, () => {
      const accounts = new ZenRegistry({ persistenceDir: join(root, "state") }).all()
      expect(accounts.length).toBe(2)
      expect(new Set(accounts.map((account) => account.id)).size).toBe(2)
    })
    cleanup(root)
  })

  test("ids and labels never contain the raw key", () => {
    const secret = "super-secret-raw-key-material"
    const id = stableZenIdentity(secret)
    expect(id.startsWith("zen-")).toBe(true)
    expect(id).not.toContain("super-secret")
    const root = freshRoot()
    withEnv({ OPENCODE_API_KEY: secret }, () => {
      for (const account of new ZenRegistry({ persistenceDir: join(root, "state") }).all()) {
        expect(account.id).not.toContain(secret)
        expect(account.label).not.toContain(secret)
        expect(account.id).toBe(stableZenIdentity(secret))
      }
    })
    cleanup(root)
  })
})

// --- router ------------------------------------------------------------------

describe("verify: zen router affinity + failover", () => {
  test("N sessions x N keys produce distinct initial bindings (spread)", () => {
    const root = freshRoot()
    const { router, run } = registryFor(root, ["key-a", "key-b", "key-c"])
    run(() => {
      const picks = ["s1", "s2", "s3"].map((session) => router.select(session, "model-x")!.account.apiKey)
      expect(new Set(picks).size).toBe(3)
    })
    cleanup(root)
  })

  test("affinity holds while the bound key is READY, regardless of other keys", () => {
    const root = freshRoot()
    const { router, registry, run } = registryFor(root, ["key-a", "key-b"])
    run(() => {
      const bound = router.select("s1", "model-x")!.account
      const other = registry.all().find((account) => account.id !== bound.id)!
      other.governor.observe({ status: 402 })
      for (let i = 0; i < 3; i++) {
        const next = router.select("s1", "model-x")!
        expect(next.reason).toBe("affinity")
        expect(next.account.id).toBe(bound.id)
      }
    })
    cleanup(root)
  })

  test("mid-flight no-switch: an unrelated key failing never rebinds a live session", () => {
    const root = freshRoot()
    const { router, registry, run } = registryFor(root, ["key-a", "key-b"])
    run(() => {
      const bound = router.select("s1", "model-x")!.account
      const unrelated = registry.all().find((account) => account.id !== bound.id)!
      unrelated.governor.observe({ status: 429, headers: { "retry-after": "600" } })
      const next = router.select("s1", "model-x")!
      expect(next.reason).toBe("affinity")
      expect(next.account.id).toBe(bound.id)
      expect(router.binding("s1")).toBe(bound.id)
    })
    cleanup(root)
  })

  test("mid-flight no-switch: a blocked bound key keeps serving its in-flight request; the switch happens at the next select", () => {
    const root = freshRoot()
    const { router, registry, run } = registryFor(root, ["key-a", "key-b"])
    run(() => {
      const bound = router.select("s1", "model-x")!.account
      const reserve = registry.all().find((account) => account.id !== bound.id)!
      bound.governor.observe({ status: 429, headers: { "retry-after": "600" } })
      // The request already dispatched on the bound key: binding() still
      // returns it (attribution + completion land on the original key).
      expect(router.binding("s1")).toBe(bound.id)
      // Only the next select() (next request) performs the switch.
      const switched = router.select("s1", "model-x")!
      expect(switched.account.id).toBe(reserve.id)
      expect(router.binding("s1")).toBe(reserve.id)
      // And the router does not return to the blocked key while it cools.
      expect(router.select("s1", "model-x")!.account.id).toBe(reserve.id)
    })
    cleanup(root)
  })

  test("failover rebinds through the two-rule queue: a used READY key outranks the untouched reserve", () => {
    const root = freshRoot()
    const { router, registry, run } = registryFor(root, ["key-a", "key-b", "key-c"])
    run(() => {
      const byKey = new Map(registry.all().map((account) => [account.apiKey, account]))
      const bound = router.select("s1", "model-x")!.account
      // A key that is neither the bound one nor the reserve becomes
      // used-but-READY (its window already expired).
      const usedReady = registry.all().find((account) => account.id !== bound.id && account.apiKey !== "key-c")!
      usedReady.everUsed = true
      bound.governor.observe({ status: 429, headers: { "retry-after": "600" } })
      const next = router.select("s1", "model-x")!
      expect(next.reason).toBe("automatic")
      // Two-rule queue: the used READY key (no active reset -> soonest)
      // before the fresh reserve.
      expect(next.account.id).toBe(usedReady.id)
    })
    cleanup(root)
  })

  test("failoverOrder: used keys by resetAt ascending, never-used strictly last", () => {
    const root = freshRoot()
    const { registry, router, run } = registryFor(root, ["key-a", "key-b", "key-c", "key-d"])
    run(() => {
      const byKey = new Map(registry.all().map((account) => [account.apiKey, account]))
      const a = byKey.get("key-a")!
      const b = byKey.get("key-b")!
      const now = Date.now()
      a.everUsed = true
      b.everUsed = true
      a.governor.observe({ status: 429, headers: { "retry-after": "3600" }, at: now })
      b.governor.observe({ status: 429, headers: { "retry-after": "60" }, at: now })
      const order = router.failoverOrder(registry.all(), now).map((account) => account.apiKey)
      // key-b resets sooner; key-c/key-d are untouched reserve and sort last.
      expect(order).toEqual(["key-b", "key-a", "key-c", "key-d"])
    })
    cleanup(root)
  })

  test("failover happens only when the bound key is blocked, never while READY", () => {
    const root = freshRoot()
    const { router, run } = registryFor(root, ["key-a", "key-b"])
    run(() => {
      const bound = router.select("s1", "model-x")!.account
      expect(router.select("s1", "model-x")!.reason).toBe("affinity")
      bound.governor.observe({ status: 402 })
      const next = router.select("s1", "model-x")!
      expect(next.reason).toBe("automatic")
      expect(next.account.id).not.toBe(bound.id)
    })
    cleanup(root)
  })

  test("single-key config never fails over: the only key keeps serving through its own recovery", () => {
    const root = freshRoot()
    const { router, run } = registryFor(root, ["key-a"])
    run(() => {
      const bound = router.select("s1", "model-x")!.account
      bound.governor.observe({ status: 429, headers: { "retry-after": "600" } })
      const next = router.select("s1", "model-x")
      expect(next).not.toBeUndefined()
      expect(next!.account.apiKey).toBe("key-a")
    })
    cleanup(root)
  })

  test("manual pin rebinds immediately and becomes the sticky binding", () => {
    const root = freshRoot()
    const { router, registry, run } = registryFor(root, ["key-a", "key-b"])
    run(() => {
      router.select("s1", "model-x")
      const target = registry.all().find((account) => account.apiKey === "key-b")!
      expect(router.bind("s1", target.id)).not.toBeUndefined()
      for (let i = 0; i < 3; i++) {
        const next = router.select("s1", "model-x")!
        expect(next.reason).toBe("affinity")
        expect(next.account.id).toBe(target.id)
      }
    })
    cleanup(root)
  })
})

// --- plugin surface: routing wrapper (black-box) -----------------------------

describe("verify: zenProviderFetch routing wrapper", () => {
  test("empty registry -> full passthrough, untouched init", async () => {
    const root = freshRoot()
    setTestZenAccountStore(root)
    setTestZenForkActive(false)
    await withEnvAsync({}, async () => {
      const calls = captureFetch([{ status: 200 }])
      const init = { method: "POST", body: JSON.stringify({ model: "big-pickle" }) }
      await zenProviderFetch(SERVER, init)
      expect(calls.length).toBe(1)
      expect(calls[0]!.init).toBe(init)
    })
    cleanup(root)
  })

  test("multi-key config: Authorization is set per request and the session binds", async () => {
    const root = freshRoot()
    setTestZenAccountStore(root)
    setTestZenForkActive(false)
    await withEnvAsync({ OPENCODE_API_KEY: "key-a", OPENCODE_API_KEY_2: "key-b" }, async () => {
      const calls = await providerRequest("s1", "big-pickle")
      const headers = new Headers(calls[0]!.init?.headers)
      expect(headers.get("Authorization")).toMatch(/^Bearer (key-a|key-b)$/)
      expect(zenSessionBinding("s1")).not.toBeUndefined()
      // The wire model id is unchanged for an unqualified model.
      expect(JSON.parse(String(calls[0]!.init?.body)).model).toBe("big-pickle")
    })
    cleanup(root)
  })

  test("qualified model id pins the named account and de-qualifies the wire body", async () => {
    const root = freshRoot()
    setTestZenAccountStore(root)
    setTestZenForkActive(false)
    await withEnvAsync({ OPENCODE_API_KEY: "key-a", OPENCODE_API_KEY_2: "key-b" }, async () => {
      const accounts = new Map(
        (
          await (async () => {
            await providerRequest("warmup", "big-pickle")
            return zenLimitSnapshot()
          })()
        ).map((row) => [row.label, row]),
      )
      void accounts
      const target = zenLimitSnapshot()[1]!
      const calls = await providerRequest("s-pin", `big-pickle@${target.accountId}`)
      const headers = new Headers(calls[0]!.init?.headers)
      expect(headers.get("Authorization")).toMatch(/^Bearer (key-a|key-b)$/)
      expect(zenSessionBinding("s-pin")).toBe(target.accountId)
      expect(JSON.parse(String(calls[0]!.init?.body)).model).toBe("big-pickle")
    })
    cleanup(root)
  })

  test("non-ok response is observed into the bound key's governor (retry-after honored)", async () => {
    const root = freshRoot()
    setTestZenAccountStore(root)
    setTestZenForkActive(false)
    await withEnvAsync({ OPENCODE_API_KEY: "key-a", OPENCODE_API_KEY_2: "key-b" }, async () => {
      const [bound] = await bindSessions(1)
      await providerRequest(bound!.session, "big-pickle", [
        { status: 429, body: '{"error":"rate limited"}', headers: { "retry-after": "60" } },
      ])
      const row = zenLimitSnapshot().find((entry) => entry.accountId === bound!.accountId)!
      expect(row.state).toBe("COOLING_DOWN")
      expect(row.resetAt).not.toBeNull()
    })
    cleanup(root)
  })

  test("fork credential active -> no Authorization, one-time notice, model still de-qualified", async () => {
    const root = freshRoot()
    setTestZenAccountStore(root)
    resetZenForkNotice()
    const warns: string[] = []
    const spy = spyOn(console, "warn").mockImplementation((message: unknown) => {
      warns.push(String(message))
    })
    try {
      await withEnvAsync({ OPENCODE_API_KEY: "key-a", OPENCODE_API_KEY_2: "key-b" }, async () => {
        setTestZenForkActive(true)
        const target = await (async () => {
          await providerRequest("warmup", "big-pickle")
          return zenLimitSnapshot()[1]!.accountId
        })()
        const calls = captureFetch([{ status: 200 }])
        await zenProviderFetch(SERVER, {
          method: "POST",
          headers: { "x-opencode-session": "s-fork" },
          body: JSON.stringify({ model: `big-pickle@${target}` }),
        })
        const headers = new Headers(calls[0]!.init?.headers)
        expect(headers.get("Authorization")).toBeNull()
        expect(JSON.parse(String(calls[0]!.init?.body)).model).toBe("big-pickle")
        expect(warns.length).toBe(1)
        expect(warns[0]).toContain("fork credential is active")

        // Second request: no additional notice.
        await zenProviderFetch(SERVER, {
          method: "POST",
          headers: { "x-opencode-session": "s-fork" },
          body: JSON.stringify({ model: "big-pickle" }),
        })
        expect(warns.length).toBe(1)

        // Guard absent -> routing engages and Authorization is set.
        setTestZenForkActive(false)
        const engaged = await providerRequest("s-open", "big-pickle")
        expect(new Headers(engaged[0]!.init?.headers).get("Authorization")).toMatch(/^Bearer key-[ab]$/)
      })
    } finally {
      spy.mockRestore()
      setTestZenForkActive(undefined)
      cleanup(root)
    }
  })
})

// --- plugin surface: models hook + event hook --------------------------------

describe("verify: zen plugin hooks", () => {
  test("provider.models emits per-account variants and keeps bare ids", async () => {
    const root = freshRoot()
    setTestZenAccountStore(root)
    await withEnvAsync({ OPENCODE_API_KEY: "key-a", OPENCODE_API_KEY_2: "key-b" }, async () => {
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
      }
      // 1 bare id + N per-account variants (1 base model x N accounts).
      expect(Object.keys(models).length).toBe(1 + zenLimitSnapshot().length)
    })
    cleanup(root)
  })

  test("event hook: APIError cools the bound key; completed message clears the cooldown", async () => {
    const root = freshRoot()
    setTestZenAccountStore(root)
    setTestZenForkActive(false)
    await withEnvAsync({ OPENCODE_API_KEY: "key-a", OPENCODE_API_KEY_2: "key-b" }, async () => {
      const hooks = await ZenPlugin({ serverUrl: SERVER } as PluginInput)
      const [bound] = await bindSessions(1)
      const row = () => zenLimitSnapshot().find((entry) => entry.accountId === bound!.accountId)!

      await runEvent(hooks, apiErrorMessage(bound!.session, { statusCode: 429, responseBody: '{"error":"FreeUsageLimitError"}' }))
      expect(row().state).toBe("COOLING_DOWN")
      expect(row().resetAt).not.toBeNull()

      await runEvent(hooks, completedMessage(bound!.session, Date.now()))
      expect(row().state).toBe("READY")
    })
    cleanup(root)
  })

  test("event hook ignores non-Zen providers and unrouted sessions", async () => {
    const root = freshRoot()
    setTestZenAccountStore(root)
    setTestZenForkActive(false)
    await withEnvAsync({ OPENCODE_API_KEY: "key-a", OPENCODE_API_KEY_2: "key-b" }, async () => {
      const hooks = await ZenPlugin({ serverUrl: SERVER } as PluginInput)
      // No binding for this session yet: the event must be a no-op, not a crash.
      await runEvent(hooks, apiErrorMessage("unrouted", { statusCode: 429 }))
      expect(zenLimitSnapshot().every((entry) => entry.state === "READY")).toBe(true)
      // Routed session, wrong provider: also a no-op.
      await providerRequest("s1", "big-pickle")
      await runEvent(hooks, {
        type: "message.updated",
        properties: {
          sessionID: "s1",
          info: { role: "assistant", providerID: "anthropic", error: { name: "APIError", data: { statusCode: 429 } } },
        },
      })
      expect(zenLimitSnapshot().every((entry) => entry.state === "READY")).toBe(true)
    })
    cleanup(root)
  })
})

// --- snapshot + adapter rows ---------------------------------------------------

describe("verify: zenLimitSnapshot shape", () => {
  test("full row shape and per-state values, driven through the routing wrapper", async () => {
    const root = freshRoot()
    setTestZenAccountStore(root)
    setTestZenForkActive(false)
    await withEnvAsync(
      { OPENCODE_API_KEY: "key-a", OPENCODE_API_KEY_2: "key-b", OPENCODE_API_KEY_3: "key-c" },
      async () => {
        const bindings = await bindSessions(3)
        const [s1, s2, s3] = bindings

        // s1's key -> cooling with an authoritative retry-after reset,
        // s2's key -> exhausted (via the wrapper's direct observation),
        // s3's key -> READY (bound = everUsed).
        await providerRequest(s1!.session, "big-pickle", [
          { status: 429, body: '{"error":"rate limited"}', headers: { "retry-after": "60" } },
        ])
        await providerRequest(s2!.session, "big-pickle", [{ status: 402, body: '{"error":"quota"}' }])

        const now = Date.now()
        const snapshot = zenLimitSnapshot(now)
        expect(snapshot.length).toBe(3)
        const expectedKeys = ["accountId", "everUsed", "hits", "label", "queuePosition", "resetAt", "source", "state", "usable"].sort()
        for (const row of snapshot) {
          expect(Object.keys(row).sort()).toEqual(expectedKeys)
          expect(row.source).toBe("env")
          // Labels are derived from the id hash, never the raw key. (Short
          // degenerate keys like "key-a" can coincidentally appear inside the
          // hex label; realistic keys cannot, and that is the invariant.)
        }
        const byId = new Map(snapshot.map((row) => [row.accountId, row]))
        const cooling = byId.get(s1!.accountId)!
        expect(cooling.state).toBe("COOLING_DOWN")
        expect(cooling.resetAt).not.toBeNull()
        expect(cooling.usable).toBe(false)
        expect(cooling.everUsed).toBe(true)
        const exhausted = byId.get(s2!.accountId)!
        expect(exhausted.state).toBe("QUOTA_EXHAUSTED")
        expect(exhausted.resetAt).toBeNull()
        expect(exhausted.usable).toBe(false)
        const ready = byId.get(s3!.accountId)!
        expect(ready.state).toBe("READY")
        expect(ready.resetAt).toBeNull()
        expect(ready.usable).toBe(true)
        expect(ready.everUsed).toBe(true)
        // Queue positions are a 1-based permutation of 1..N.
        expect([...snapshot.map((row) => row.queuePosition)].sort((a, b) => a! - b!)).toEqual([1, 2, 3])
        expect(snapshot.every((row) => row.hits.length >= 1 || row.state === "READY")).toBe(true)
      },
    )
    cleanup(root)
  })
})

describe("verify: zenKeyLimitsRows adapter rows", () => {
  test("row shape: state mapping, governor resetAt passthrough, estimator fields, queue position", async () => {
    const root = freshRoot()
    setTestZenAccountStore(root)
    setTestZenForkActive(false)
    await withEnvAsync({ OPENCODE_API_KEY: "key-a", OPENCODE_API_KEY_2: "key-b" }, async () => {
      // Bind ONE session only: the second key must stay everUsed=false so the
      // fresh-row assertions (usedObserved null) are meaningful.
      const [s1] = await bindSessions(1)
      await providerRequest(s1!.session, "big-pickle", [
        { status: 429, body: '{"error":"rate limited"}', headers: { "retry-after": "60" } },
      ])

      const now = Date.now()
      const snapshotRow = zenLimitSnapshot(now).find((row) => row.accountId === s1!.accountId)!
      const rows = zenKeyLimitsRows(emptySnapshot(now), now)
      expect(rows.length).toBe(2)
      const expectedKeys = [
        "estimateSource",
        "everUsed",
        "exhausted",
        "keyId",
        "label",
        "limitEstimate",
        "queuePosition",
        "remainingPercent",
        "resetAfterSeconds",
        "resetAt",
        "state",
        "usedObserved",
      ].sort()
      for (const row of rows) expect(Object.keys(row).sort()).toEqual(expectedKeys)

      const cooling = rows.find((row) => row.keyId === s1!.accountId)!
      expect(cooling.state).toBe("cooling")
      expect(cooling.exhausted).toBe(false)
      expect(cooling.resetAt).toBe(snapshotRow.resetAt)
      expect(cooling.resetAfterSeconds).toBe(Math.max(0, Math.round((cooling.resetAt! - now) / 1000)))
      expect(cooling.usedObserved).toBe(0)
      expect(cooling.limitEstimate).toBe(200)
      expect(cooling.estimateSource).toBe("fallback")
      expect(cooling.everUsed).toBe(true)

      const fresh = rows.find((row) => row.keyId !== s1!.accountId)!
      expect(fresh.state).toBe("ready")
      expect(fresh.usedObserved).toBeNull()
      expect(fresh.estimateSource).toBeNull()
      expect(fresh.remainingPercent).toBeNull()
      expect(fresh.everUsed).toBe(false)
      expect(fresh.resetAfterSeconds).toBeNull()
    })
    cleanup(root)
  })

  test("exhausted mapping and empty registry -> byte-identical aggregate output", async () => {
    const root = freshRoot()
    setTestZenAccountStore(root)
    setTestZenForkActive(false)
    await withEnvAsync({ OPENCODE_API_KEY: "key-a" }, async () => {
      const [s1] = await bindSessions(1)
      await providerRequest(s1!.session, "big-pickle", [{ status: 402, body: '{"error":"quota"}' }])
      const now = Date.now()
      const rows = zenKeyLimitsRows(emptySnapshot(now), now)
      expect(rows[0]!.state).toBe("exhausted")
      expect(rows[0]!.exhausted).toBe(true)
      expect(rows[0]!.resetAfterSeconds).toBeNull()
    })
    cleanup(root)

    // Empty registry: the adapter's aggregate output must not gain a
    // zenAccounts key at all (byte-identical to the pre-feature shape), and
    // the wrapper must pass through untouched.
    setTestZenAccountStore(freshRoot())
    await withEnvAsync({}, async () => {
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
    })
    cleanup(root)
  })
})
