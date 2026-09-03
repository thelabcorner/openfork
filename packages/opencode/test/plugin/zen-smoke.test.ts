import { describe, expect, test } from "bun:test"
import { mkdirSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { ZenGovernor } from "@/plugin/zen-governor"
import { ZenRegistry, ZenRouter, stableZenIdentity, zenEnvCredentials } from "@/plugin/zen-accounts"
import {
  ZenPlugin,
  resetZenForkNotice,
  setTestZenAccountStore,
  setTestZenFetch,
  setTestZenForkActive,
  zenLimitSnapshot,
  zenPinSession,
  zenProviderFetch,
} from "@/plugin/zen"

const DAY_MS = 86_400_000

function utcDayEnd(now: number) {
  return Math.floor(now / DAY_MS) * DAY_MS + DAY_MS
}

function freshRoot(): string {
  const root = join(tmpdir(), `opencode-zen-test-${process.pid}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
  return root
}

function cleanup(root: string) {
  rmSync(root, { recursive: true, force: true })
}

function routerWithKeys(keys: string[]) {
  const root = freshRoot()
  const names = ["OPENCODE_API_KEY", "OPENCODE_API_KEY_2", "OPENCODE_API_KEY_3"]
  const original = names.map((name) => process.env[name])
  for (const [index, name] of names.entries()) process.env[name] = keys[index]
  const registry = new ZenRegistry({ persistenceDir: join(root, "state") })
  const router = new ZenRouter({ registry })
  const dispose = () => {
    for (const [index, name] of names.entries()) {
      const value = original[index]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    cleanup(root)
  }
  const ids = keys.map((key) => stableZenIdentity(key))
  const accounts = () => registry.all()
  return { router, ids, accounts, dispose }
}

describe("zen governor", () => {
  test("429 with FreeUsageLimitError cools down until UTC midnight", () => {
    const root = freshRoot()
    const governor = new ZenGovernor({ persistenceFile: join(root, "g.json") })
    const now = utcDayEnd(0) + 3_600_000
    governor.observe({ status: 429, body: '{"error":"FreeUsageLimitError"}', at: now })
    const metrics = governor.metrics(now)
    expect(metrics.state).toBe("COOLING_DOWN")
    expect(metrics.resetAt).toBe(utcDayEnd(now))
    expect(governor.usable(now)).toBe(false)
    expect(governor.usable(utcDayEnd(now))).toBe(true)
    cleanup(root)
  })

  test("402 marks the key QUOTA_EXHAUSTED with no reset window", () => {
    const root = freshRoot()
    const governor = new ZenGovernor({ persistenceFile: join(root, "g.json") })
    const now = Date.now()
    governor.observe({ status: 402, at: now })
    const metrics = governor.metrics(now)
    expect(metrics.state).toBe("QUOTA_EXHAUSTED")
    expect(metrics.resetAt).toBeNull()
    expect(governor.usable(now)).toBe(false)
    expect(governor.usable(now + DAY_MS)).toBe(false)
    cleanup(root)
  })

  test("429 with retry-after header uses the authoritative reset", () => {
    const root = freshRoot()
    const governor = new ZenGovernor({ persistenceFile: join(root, "g.json") })
    const now = Date.now()
    governor.observe({ status: 429, headers: { "retry-after": "120" }, at: now })
    expect(governor.currentResetAt(now)).toBe(now + 120_000)
    cleanup(root)
  })

  test("unexplained 429 cools down with a bounded backoff and recovers", () => {
    const root = freshRoot()
    const governor = new ZenGovernor({ persistenceFile: join(root, "g.json") })
    const now = Date.now()
    governor.observe({ status: 429, at: now })
    const resetAt = governor.currentResetAt(now)!
    expect(resetAt).toBeGreaterThan(now)
    expect(resetAt - now).toBeLessThanOrEqual(15 * 60_000 + 2_000)
    expect(governor.usable(resetAt + 1)).toBe(true)
    cleanup(root)
  })

  test("exhausted state survives a restart from persistence", () => {
    const root = freshRoot()
    const file = join(root, "g.json")
    const now = Date.now()
    new ZenGovernor({ persistenceFile: file }).observe({ status: 402, at: now })
    const reloaded = new ZenGovernor({ persistenceFile: file })
    expect(reloaded.metrics(now).state).toBe("QUOTA_EXHAUSTED")
    cleanup(root)
  })
})

describe("zen env intake", () => {
  test("reads single, comma list, and numbered vars", () => {
    const credentials = zenEnvCredentials({
      OPENCODE_API_KEY: " key-a ",
      OPENCODE_API_KEYS: '"key-b", key-c',
      OPENCODE_API_KEY_2: "key-d",
      OPENCODE_API_KEY_11: "key-e",
    })
    expect(credentials.map((credential) => credential.apiKey)).toEqual(["key-a", "key-b", "key-c", "key-d"])
  })

  test("identity is a stable hash, never the raw key", () => {
    const id = stableZenIdentity("secret-key")
    expect(id.startsWith("zen-")).toBe(true)
    expect(id).not.toContain("secret-key")
    expect(id).toBe(stableZenIdentity("secret-key"))
    expect(id).not.toBe(stableZenIdentity("other-key"))
  })
})

describe("zen router", () => {
  test("new sessions spread across reserve keys; affinity then holds every request on the bound key", () => {
    const handle = routerWithKeys(["key-a", "key-b"])
    try {
      const first = handle.router.select("session-1", "model-x")!
      expect(first.reason).toBe("automatic")
      expect(first.account.everUsed).toBe(true)
      const second = handle.router.select("session-2", "model-x")!
      expect(second.account.apiKey).not.toBe(first.account.apiKey)
      for (let i = 0; i < 5; i++) {
        const next = handle.router.select("session-1", "model-x")
        expect(next?.account.apiKey).toBe(first.account.apiKey)
        expect(next?.reason).toBe("affinity")
      }
    } finally {
      handle.dispose()
    }
  })

  test("failover happens only when the bound key is blocked, and never returns to it while blocked", () => {
    const handle = routerWithKeys(["key-a", "key-b"])
    try {
      const now = Date.now()
      const bound = handle.router.select("session-1", "model-x")!
      expect(handle.router.select("session-1", "model-x")?.reason).toBe("affinity")
      bound.account.governor.observe({ status: 429, headers: { "retry-after": "600" }, at: now })
      const failedOver = handle.router.select("session-1", "model-x")!
      expect(failedOver.reason).toBe("automatic")
      expect(failedOver.account.apiKey).not.toBe(bound.account.apiKey)
    } finally {
      handle.dispose()
    }
  })

  test("failover queue fronts the soonest-resetting used key and holds never-used keys last", () => {
    const handle = routerWithKeys(["key-a", "key-b", "key-c"])
    try {
      const now = Date.now()
      const [a, b, c] = handle.ids
      const byId = new Map(handle.accounts().map((account) => [account.id, account]))
      const accountA = byId.get(a!)!
      const accountB = byId.get(b!)!
      const accountC = byId.get(c!)!
      accountA.everUsed = true
      accountB.everUsed = true
      accountA.governor.observe({ status: 429, headers: { "retry-after": "60" }, at: now })
      accountB.governor.observe({ status: 429, headers: { "retry-after": "3600" }, at: now })
      expect(handle.router.failoverOrder([accountA, accountB, accountC], now).map((x) => x.id)).toEqual([a, b, c])
      // A's window expires, B is still cooling, C remains reserve: the used key
      // still outranks the untouched reserve key in the failover queue.
      expect(
        handle.router.failoverOrder([accountA, accountB, accountC], now + 61_000).map((x) => x.id),
      ).toEqual([a, b, c])
    } finally {
      handle.dispose()
    }
  })

  test("reserve keys enter service for new bindings and the least-bad fallback covers total exhaustion", () => {
    const handle = routerWithKeys(["key-a", "key-b"])
    try {
      const now = Date.now()
      const [a, b] = handle.ids
      const byId = new Map(handle.accounts().map((account) => [account.id, account]))
      const accountA = byId.get(a!)!
      accountA.everUsed = true
      accountA.governor.observe({ status: 429, headers: { "retry-after": "600" }, at: now })
      const reserve = handle.router.select("session-1", "model-x")!
      expect(reserve.account.id).toBe(b)
      expect(reserve.account.everUsed).toBe(true)
      reserve.account.governor.observe({ status: 402, at: now })
      const leastBad = handle.router.select("session-2", "model-x")!
      expect(leastBad.reason).toBe("automatic")
    } finally {
      handle.dispose()
    }
  })

  test("manual pin becomes the new sticky binding", () => {
    const handle = routerWithKeys(["key-a", "key-b"])
    try {
      const [b] = handle.ids.slice(1)
      const pinned = handle.router.select("session-1", "model-x", b!)!
      expect(pinned.reason).toBe("explicit")
      expect(pinned.account.id).toBe(b)
      const again = handle.router.select("session-1", "model-x")!
      expect(again.reason).toBe("affinity")
      expect(again.account.id).toBe(b)
    } finally {
      handle.dispose()
    }
  })
})

describe("zen fork guard", () => {
  const calls: Array<{ url: RequestInfo | URL; init?: RequestInit }> = []

  function okResponse() {
    return new Response(JSON.stringify({ choices: [] }), { status: 200 })
  }

  function baseFetchStub() {
    calls.length = 0
    setTestZenFetch(async (url, init) => {
      calls.push({ url, init })
      return okResponse()
    })
  }

  function lastCall() {
    const last = calls.at(-1)
    const headers = new Headers(last?.init?.headers)
    const body = typeof last?.init?.body === "string" ? JSON.parse(last.init.body) : undefined
    return { headers, body }
  }

  async function runFetch(model: string, session = "session-guard") {
    return zenProviderFetch("https://opencode.ai/zen/v1/chat/completions", {
      method: "POST",
      headers: new Headers({ "x-opencode-session": session }),
      body: JSON.stringify({ model, messages: [] }),
    })
  }

  test("an active fork credential suppresses Authorization but still de-qualifies the model", async () => {
    const root = freshRoot()
    setTestZenAccountStore(root)
    resetZenForkNotice()
    baseFetchStub()
    const original = process.env.OPENCODE_API_KEY
    process.env.OPENCODE_API_KEY = "fork-guard-key"
    setTestZenForkActive(true)
    try {
      expect(zenLimitSnapshot().length).toBe(1)
      await runFetch("model-x@zen-auto:sticky")
      expect(lastCall().headers.get("Authorization")).toBeNull()
      expect(lastCall().body.model).toBe("model-x")
    } finally {
      if (original === undefined) delete process.env.OPENCODE_API_KEY
      else process.env.OPENCODE_API_KEY = original
      setTestZenForkActive(undefined)
      setTestZenFetch(undefined)
      cleanup(root)
    }
  })

  test("without a fork credential the wrapper routes and authorizes with the bound key", async () => {
    const root = freshRoot()
    setTestZenAccountStore(root)
    resetZenForkNotice()
    baseFetchStub()
    const original = process.env.OPENCODE_API_KEY
    process.env.OPENCODE_API_KEY = "override-key"
    setTestZenForkActive(false)
    try {
      await runFetch("model-x")
      expect(lastCall().headers.get("Authorization")).toBe("Bearer override-key")
      expect(lastCall().body.model).toBe("model-x")
    } finally {
      if (original === undefined) delete process.env.OPENCODE_API_KEY
      else process.env.OPENCODE_API_KEY = original
      setTestZenForkActive(undefined)
      setTestZenFetch(undefined)
      cleanup(root)
    }
  })

  test("with no configured keys the wrapper is a transparent passthrough", async () => {
    const root = freshRoot()
    setTestZenAccountStore(root)
    resetZenForkNotice()
    baseFetchStub()
    const original = process.env.OPENCODE_API_KEY
    delete process.env.OPENCODE_API_KEY
    setTestZenForkActive(false)
    try {
      await runFetch("model-x", "session-empty")
      expect(lastCall().headers.get("Authorization")).toBeNull()
      expect(lastCall().body.model).toBe("model-x")
    } finally {
      if (original === undefined) delete process.env.OPENCODE_API_KEY
      else process.env.OPENCODE_API_KEY = original
      setTestZenForkActive(undefined)
      setTestZenFetch(undefined)
      cleanup(root)
    }
  })
})

describe("zen plugin surface", () => {
  test("snapshot exposes per-key state, resetAt, and queue position; pin sticks", () => {
    const root = freshRoot()
    setTestZenAccountStore(root)
    const originalKey = process.env.OPENCODE_API_KEY
    const originalKey2 = process.env.OPENCODE_API_KEY_2
    process.env.OPENCODE_API_KEY = "snap-key"
    process.env.OPENCODE_API_KEY_2 = "snap-key-2"
    try {
      const snapshot = zenLimitSnapshot()
      expect(snapshot.length).toBe(2)
      for (const entry of snapshot) {
        expect(entry.accountId.startsWith("zen-")).toBe(true)
        expect(entry.label).not.toContain("snap-key")
        expect(entry.queuePosition).toBeGreaterThan(0)
      }
      const target = snapshot[1]!
      expect(zenPinSession("session-snap", target.accountId)).toBe(true)
      const after = zenLimitSnapshot()
      expect(after.find((entry) => entry.accountId === target.accountId)?.everUsed).toBe(true)
    } finally {
      if (originalKey === undefined) delete process.env.OPENCODE_API_KEY
      else process.env.OPENCODE_API_KEY = originalKey
      if (originalKey2 === undefined) delete process.env.OPENCODE_API_KEY_2
      else process.env.OPENCODE_API_KEY_2 = originalKey2
      cleanup(root)
    }
  })
})
