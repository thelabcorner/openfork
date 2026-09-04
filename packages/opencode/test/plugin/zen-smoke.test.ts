import { describe, expect, test } from "bun:test"
import { ZenAccountPool, stableZenIdentity, zenEnvCredentials } from "@/plugin/zen-accounts"
import { resetZenPoolForTest, setTestZenFetch, setTestZenVaultCredentials, zenLimitSnapshot, zenProviderFetch } from "@/plugin/zen"

const DAY_MS = 86_400_000

type CapturedCall = { url: RequestInfo | URL; init: RequestInit | undefined }

/**
 * Isolate module state and configure the pool from env + a test vault list
 * (the vault override bypasses the SQLite store entirely).
 */
function configureEnv(env: Record<string, string>, vault: { apiKey: string; label?: string; isDefault?: boolean }[] = []) {
  resetZenPoolForTest()
  setTestZenVaultCredentials(undefined)
  const names = Object.keys(env)
  const saved = new Map(names.map((name) => [name, process.env[name]]))
  for (const [name, value] of Object.entries(env)) process.env[name] = value
  setTestZenVaultCredentials(vault)
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

/** Stub the base fetch, recording every call and answering with `responses` in order. */
function captureFetch(responses: Array<{ status: number; body?: string; headers?: Record<string, string> }>) {
  const calls: CapturedCall[] = []
  setTestZenFetch(async (url, init) => {
    calls.push({ url, init })
    const next = responses[Math.min(calls.length - 1, responses.length - 1)]!
    return new Response(next.body ?? "{}", { status: next.status, headers: next.headers })
  })
  return calls
}

function lastCall(calls: CapturedCall[]) {
  const last = calls.at(-1)!
  const headers = new Headers(last.init?.headers)
  const body = typeof last.init?.body === "string" ? JSON.parse(last.init.body) : undefined
  return { headers, body }
}

async function providerRequest(model: string, options: { session?: string; responses?: Array<{ status: number; body?: string; headers?: Record<string, string> }> } = {}) {
  const calls = captureFetch(options.responses ?? [{ status: 200 }])
  await zenProviderFetch("https://opencode.ai/zen/v1/chat/completions", {
    method: "POST",
    headers: new Headers({ "x-opencode-session": options.session ?? "session-smoke" }),
    body: JSON.stringify({ model, messages: [] }),
  })
  return calls
}

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

describe("zen pool", () => {
  test("env keys are defaulted in declaration order, deduped by stable identity", () => {
    const dispose = configureEnv({ OPENCODE_API_KEY: "key-a", OPENCODE_API_KEY_2: "key-b", OPENCODE_API_KEYS: "key-a" })
    try {
      const snapshot = zenLimitSnapshot()
      expect(snapshot.length).toBe(2)
      expect(snapshot[0]!.accountId).toBe(stableZenIdentity("key-a"))
      expect(snapshot[0]!.isDefault).toBe(true)
      expect(snapshot[1]!.isDefault).toBe(false)
    } finally {
      dispose()
    }
  })

  test("vault keys merge alongside env keys; env default wins", () => {
    const dispose = configureEnv(
      { OPENCODE_API_KEY: "key-a" },
      [
        { apiKey: "key-b", label: "vault-b", isDefault: true },
        { apiKey: "key-c", label: "vault-c" },
      ],
    )
    try {
      const snapshot = zenLimitSnapshot()
      expect(snapshot.length).toBe(3)
      // First env key stays the default even though a vault key is flagged.
      expect(snapshot[0]!.isDefault).toBe(true)
      expect(snapshot[0]!.label).not.toContain("key-a")
      expect(snapshot.find((row) => row.label === "vault-b")?.source).toBe("vault")
    } finally {
      dispose()
    }
  })

  test("a vault-only pool honors the flagged default, else falls back to the first", () => {
    const flagged = new ZenAccountPool()
    flagged.sync([
      { vaultId: "v1", apiKey: "key-a", label: "lab-a", isDefault: false },
      { vaultId: "v2", apiKey: "key-b", label: "lab-b", isDefault: true },
    ])
    expect(flagged.snapshot().find((row) => row.isDefault)!.label).toBe("lab-b")

    const unflagged = new ZenAccountPool()
    unflagged.sync([{ vaultId: "v1", apiKey: "key-a", label: "lab-a", isDefault: false }])
    expect(unflagged.defaultAccount()!.apiKey).toBe("key-a")
  })

  test("observe: 429 cools with resetAt, 402 exhausts with no reset, 2xx clears", () => {
    const pool = new ZenAccountPool()
    pool.sync([{ vaultId: "v1", apiKey: "key-a", isDefault: false }])
    const id = pool.defaultAccount()!.id
    const now = Date.now()

    pool.observe(id, 429, now + 60_000)
    expect(pool.state(id, now).state).toBe("COOLING_DOWN")
    expect(pool.state(id, now + 61_000).state).toBe("READY")

    pool.observe(id, 402, undefined)
    expect(pool.state(id, now + 10 * DAY_MS).state).toBe("QUOTA_EXHAUSTED")

    pool.observe(id, 200, undefined)
    expect(pool.state(id, now).state).toBe("READY")
  })
})

describe("zen provider fetch wrapper", () => {
  test("no keys => transparent passthrough, untouched init", async () => {
    const dispose = configureEnv({})
    try {
      const calls = captureFetch([{ status: 200 }])
      const init = { method: "POST", body: JSON.stringify({ model: "model-x" }) }
      await zenProviderFetch("https://opencode.ai/zen/v1/chat/completions", init)
      expect(calls.length).toBe(1)
      expect(calls[0]!.init).toBe(init)
    } finally {
      dispose()
    }
  })

  test("qualified model routes to the named account, de-qualifies the wire body, sets Authorization", async () => {
    const dispose = configureEnv(
      { OPENCODE_API_KEY: "key-a", OPENCODE_API_KEY_2: "key-b" },
      [{ apiKey: "key-c", label: "vault-c" }],
    )
    try {
      const target = zenLimitSnapshot().find((row) => row.label === "vault-c")!
      const calls = await providerRequest(`model-x@${target.accountId}`)
      expect(lastCall(calls).body.model).toBe("model-x")
      expect(lastCall(calls).headers.get("Authorization")).toBe("Bearer key-c")
    } finally {
      dispose()
    }
  })

  test("bare model uses the default account (first env key)", async () => {
    const dispose = configureEnv({ OPENCODE_API_KEY: "key-a", OPENCODE_API_KEY_2: "key-b" })
    try {
      const calls = await providerRequest("model-x")
      expect(lastCall(calls).body.model).toBe("model-x")
      expect(lastCall(calls).headers.get("Authorization")).toBe("Bearer key-a")
    } finally {
      dispose()
    }
  })

  test("an unknown account suffix falls back to the default account and is still de-qualified", async () => {
    const dispose = configureEnv({ OPENCODE_API_KEY: "key-a" })
    try {
      const calls = await providerRequest("model-x@zen-deadbeef")
      expect(lastCall(calls).body.model).toBe("model-x")
      expect(lastCall(calls).headers.get("Authorization")).toBe("Bearer key-a")
    } finally {
      dispose()
    }
  })

  test("a non-ok response is observed (429 retry-after honored, 402 exhausts)", async () => {
    const dispose = configureEnv({ OPENCODE_API_KEY: "key-a", OPENCODE_API_KEY_2: "key-b" })
    try {
      const target = zenLimitSnapshot()[1]!.accountId
      const now = Date.now()
      await providerRequest(`model-a@${target}`, {
        responses: [{ status: 429, headers: { "retry-after": "60" } }],
      })
      let row = zenLimitSnapshot(now).find((entry) => entry.accountId === target)!
      expect(row.state).toBe("COOLING_DOWN")
      expect(row.resetAt).not.toBeNull()
      expect(Math.abs(row.resetAt! - (now + 60_000))).toBeLessThan(2_000)

      await providerRequest(`model-b@${target}`, { responses: [{ status: 402 }] })
      row = zenLimitSnapshot(now).find((entry) => entry.accountId === target)!
      expect(row.state).toBe("QUOTA_EXHAUSTED")
      expect(row.resetAt).toBeNull()
    } finally {
      dispose()
    }
  })

  test("a 200 response does not mark the account failed", async () => {
    const dispose = configureEnv({ OPENCODE_API_KEY: "key-a" })
    try {
      const id = zenLimitSnapshot()[0]!.accountId
      await providerRequest(`model-w@${id}`, { responses: [{ status: 200 }] })
      expect(zenLimitSnapshot()[0]!.state).toBe("READY")
    } finally {
      dispose()
    }
  })
})

describe("zen suffix robustness + sentinel neutralization", () => {
  test("@zen-auto:sticky sentinel never reaches the wire; routes to the default key", async () => {
    const dispose = configureEnv({ OPENCODE_API_KEY: "key-a", OPENCODE_API_KEY_2: "key-b" })
    try {
      const calls = await providerRequest("model-x@zen-auto:sticky")
      expect(lastCall(calls).body.model).toBe("model-x")
      expect(lastCall(calls).headers.get("Authorization")).toBe("Bearer key-a")
      expect(lastCall(calls).body.model).not.toContain("zen-auto")
      expect(lastCall(calls).body.model).not.toContain("sticky")
    } finally {
      dispose()
    }
  })

  test("context-window suffix BEFORE the account is preserved and routes to the account", async () => {
    const dispose = configureEnv({ OPENCODE_API_KEY: "key-a", OPENCODE_API_KEY_2: "key-b" })
    try {
      const target = zenLimitSnapshot()[1]!.accountId
      const calls = await providerRequest(`model-x@300k@${target}`)
      expect(lastCall(calls).body.model).toBe("model-x@300k")
      expect(lastCall(calls).headers.get("Authorization")).toBe("Bearer key-b")
    } finally {
      dispose()
    }
  })

  test("junk after the account (@300k) is stripped; routes to the account", async () => {
    const dispose = configureEnv({ OPENCODE_API_KEY: "key-a", OPENCODE_API_KEY_2: "key-b" })
    try {
      const target = zenLimitSnapshot()[1]!.accountId
      const calls = await providerRequest(`model-x@${target}@300k`)
      expect(lastCall(calls).body.model).toBe("model-x")
      expect(lastCall(calls).headers.get("Authorization")).toBe("Bearer key-b")
    } finally {
      dispose()
    }
  })

  test("double account suffix routes on the LAST account and strips all markers", async () => {
    const dispose = configureEnv({ OPENCODE_API_KEY: "key-a", OPENCODE_API_KEY_2: "key-b" })
    try {
      const first = zenLimitSnapshot()[0]!.accountId
      const second = zenLimitSnapshot()[1]!.accountId
      const calls = await providerRequest(`model-x@${first}@${second}`)
      expect(lastCall(calls).body.model).toBe("model-x")
      expect(lastCall(calls).headers.get("Authorization")).toBe("Bearer key-b")
    } finally {
      dispose()
    }
  })
})
