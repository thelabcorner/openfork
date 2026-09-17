import { describe, expect, test, afterEach } from "bun:test"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  reauthenticateAccount,
  setTestAccountStore,
  setTestBackend,
  validateAccountAuth,
} from "@/plugin/workbuddy"
import { AccountVault, type WorkBuddyAccount } from "@/plugin/workbuddy-accounts"
import { WorkBuddyEntitlementGovernor } from "@/plugin/workbuddy-governor"

afterEach(() => setTestBackend(undefined))

function isolatedDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function fakeAccount(overrides?: Partial<WorkBuddyAccount["credential"]>): WorkBuddyAccount {
  const id = `wb-reauth-${Math.random().toString(36).slice(2, 8)}`
  return {
    id,
    uid: overrides?.uid ?? id,
    nickname: overrides?.nickname ?? "test@example.com",
    realm: "www.workbuddy.ai",
    authPath: `/tmp/${id}.json`,
    credential: {
      path: `/tmp/${id}.json`,
      accessToken: "STALE_ACCESS",
      refreshToken: "REFRESH",
      domain: "www.workbuddy.ai",
      uid: overrides?.uid ?? id,
      enterpriseId: "",
      expiresAt: 0,
      nickname: "test@example.com",
      ...overrides,
    },
    governor: new WorkBuddyEntitlementGovernor({
      persistenceFile: join(isolatedDir("wb-reauth-gov-"), "entitlement.json"),
    }),
    mtime: 0,
    source: "vault",
  }
}

type RefreshHit = {
  authorization: string | undefined
  refreshToken: string | undefined
  refreshSource: string | undefined
  domain: string | undefined
  userAgent: string | undefined
  product: string | undefined
  body: string
}

type FakeBackend = {
  url: string
  hits: RefreshHit[]
  counts: { accounts: number; refresh: number }
  close: () => Promise<void>
}

function startFakeBackend(opts: {
  refreshStatus?: number
  refreshBody?: unknown
  accountsStatus?: (auth: string | undefined) => number
} = {}): Promise<FakeBackend> {
  const hits: RefreshHit[] = []
  const counts = { accounts: 0, refresh: 0 }
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const url = new URL(req.url ?? "/", "http://127.0.0.1")
      if (url.pathname === "/v2/plugin/auth/token/refresh") {
        counts.refresh++
        hits.push({
          authorization: req.headers.authorization,
          refreshToken: req.headers["x-refresh-token"] as string | undefined,
          refreshSource: req.headers["x-auth-refresh-source"] as string | undefined,
          domain: req.headers["x-domain"] as string | undefined,
          userAgent: req.headers["user-agent"] as string | undefined,
          product: req.headers["x-product"] as string | undefined,
          body: Buffer.concat(chunks).toString("utf8"),
        })
        res.writeHead(opts.refreshStatus ?? 200, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify(
            opts.refreshBody ?? { data: { accessToken: "NEW_ACCESS", refreshToken: "NEW_REFRESH", expiresIn: 3600 } },
          ),
        )
        return
      }
      if (url.pathname === "/v2/plugin/accounts") {
        counts.accounts++
        const status = opts.accountsStatus ? opts.accountsStatus(req.headers.authorization) : 200
        res.writeHead(status, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify(
            status === 200 ? { code: 0, data: { accounts: [{ uid: "u1" }] } } : { code: 10001, msg: "token expired" },
          ),
        )
        return
      }
      res.writeHead(404, { "Content-Type": "application/json" })
      res.end("{}")
    })()
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      const port = typeof addr === "object" && addr ? addr.port : 0
      resolve({
        url: `http://127.0.0.1:${port}`,
        hits,
        counts,
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    })
  })
}

describe("WorkBuddy automatic re-auth: request shape", () => {
  test("mirrors the official refresh call and never sends the stale bearer", async () => {
    const root = isolatedDir("wb-reauth-shape-")
    setTestAccountStore(root)
    const backend = await startFakeBackend({})
    try {
      setTestBackend(backend.url)
      const account = fakeAccount({ uid: "uid-shape", domain: "www.workbuddy.ai" })
      expect(await reauthenticateAccount(account)).toBe("refreshed")
      expect(backend.counts.refresh).toBe(1)
      const hit = backend.hits[0]!
      // Negative invariant: the expired Authorization header is what we are
      // replacing; the official client omits it and so must we.
      expect(hit.authorization).toBeUndefined()
      expect(hit.refreshToken).toBe("REFRESH")
      expect(hit.refreshSource).toBe("plugin")
      expect(hit.domain).toBe("www.workbuddy.ai")
      expect(hit.body).toBe("{}")
      // First-party identity parity: no self-branded reverse-proxy UA, and the
      // official X-Product deployment header is present.
      expect(hit.userAgent).not.toContain("codebuddy2openai")
      expect(hit.product).toBe("SaaS")
    } finally {
      await backend.close()
    }
  })

  test("success rotates tokens, computes expiry, and persists to the vault", async () => {
    const root = isolatedDir("wb-reauth-persist-")
    setTestAccountStore(root)
    const backend = await startFakeBackend({})
    try {
      setTestBackend(backend.url)
      const account = fakeAccount({ uid: "uid-persist" })
      expect(await reauthenticateAccount(account)).toBe("refreshed")
      expect(account.credential.accessToken).toBe("NEW_ACCESS")
      expect(account.credential.refreshToken).toBe("NEW_REFRESH")
      expect(account.credential.expiresAt).toBeGreaterThan(Date.now() + 3_000_000)
      const persisted = new AccountVault(root).list().find((cred) => cred.uid === "uid-persist")
      expect(persisted?.accessToken).toBe("NEW_ACCESS")
      expect(persisted?.refreshToken).toBe("NEW_REFRESH")
    } finally {
      await backend.close()
    }
  })

  test("concurrent refreshes collapse to one upstream call", async () => {
    const root = isolatedDir("wb-reauth-singleflight-")
    setTestAccountStore(root)
    const backend = await startFakeBackend({})
    try {
      setTestBackend(backend.url)
      const account = fakeAccount({ uid: "uid-concurrent" })
      const [first, second] = await Promise.all([
        reauthenticateAccount(account),
        reauthenticateAccount(account),
      ])
      expect(first).toBe("refreshed")
      expect(second).toBe("refreshed")
      expect(backend.counts.refresh).toBe(1)
    } finally {
      await backend.close()
    }
  })
})

describe("WorkBuddy automatic re-auth: failure classification", () => {
  test("rejected (backend 401/403), transient (5xx/network), unavailable (no refresh token)", async () => {
    const root = isolatedDir("wb-reauth-class-")
    setTestAccountStore(root)

    const rejected = await startFakeBackend({ refreshStatus: 403 })
    try {
      setTestBackend(rejected.url)
      expect(await reauthenticateAccount(fakeAccount({ uid: "u-rejected" }))).toBe("rejected")
    } finally {
      await rejected.close()
    }

    const transient = await startFakeBackend({ refreshStatus: 500 })
    try {
      setTestBackend(transient.url)
      expect(await reauthenticateAccount(fakeAccount({ uid: "u-transient" }))).toBe("transient")
    } finally {
      await transient.close()
    }

    const network = await startFakeBackend({})
    const deadUrl = network.url
    await network.close()
    setTestBackend(deadUrl)
    expect(await reauthenticateAccount(fakeAccount({ uid: "u-network" }))).toBe("transient")

    setTestBackend(undefined)
    expect(await reauthenticateAccount(fakeAccount({ uid: "u-unavailable", refreshToken: "" }))).toBe("unavailable")
  })

  test("a 200 without a token is transient, never a rejection", async () => {
    const root = isolatedDir("wb-reauth-empty-")
    setTestAccountStore(root)
    const backend = await startFakeBackend({ refreshStatus: 200, refreshBody: { code: 0, data: {} } })
    try {
      setTestBackend(backend.url)
      expect(await reauthenticateAccount(fakeAccount({ uid: "u-empty" }))).toBe("transient")
    } finally {
      await backend.close()
    }
  })
})

describe("WorkBuddy proactive auth validation: account-session endpoint", () => {
  test("a healthy account-session read clears a learned AUTH_INVALID", async () => {
    const root = isolatedDir("wb-reauth-valid-")
    setTestAccountStore(root)
    const backend = await startFakeBackend({})
    try {
      setTestBackend(backend.url)
      const account = fakeAccount({ uid: "u-valid" })
      account.governor.markAuthInvalid(401)
      expect(await validateAccountAuth(account)).toBe("valid")
      expect(backend.counts.accounts).toBe(1)
      expect(backend.counts.refresh).toBe(0)
      expect(account.governor.metrics().state).toBe("READY")
    } finally {
      await backend.close()
    }
  })

  test("a 401 that survives refresh persists AUTH_INVALID", async () => {
    const root = isolatedDir("wb-reauth-invalid-")
    setTestAccountStore(root)
    const backend = await startFakeBackend({ accountsStatus: () => 401, refreshStatus: 403 })
    try {
      setTestBackend(backend.url)
      const account = fakeAccount({ uid: "u-invalid" })
      expect(await validateAccountAuth(account)).toBe("invalid")
      expect(backend.counts.accounts).toBe(2)
      expect(backend.counts.refresh).toBe(1)
      expect(account.governor.metrics().state).toBe("AUTH_INVALID")
    } finally {
      await backend.close()
    }
  })

  test("a malformed 200 payload is unknown, not valid", async () => {
    const root = isolatedDir("wb-reauth-malformed-")
    setTestAccountStore(root)
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ code: 0, data: {} }))
    })
    const backend = await new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address()
        const port = typeof addr === "object" && addr ? addr.port : 0
        resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((done) => server.close(() => done())) })
      })
    })
    try {
      setTestBackend(backend.url)
      const account = fakeAccount({ uid: "u-malformed" })
      expect(await validateAccountAuth(account)).toBe("unknown")
      expect(account.governor.metrics().state).toBe("READY")
      expect(account.governor.metrics().lastAuthFailure).toBeNull()
    } finally {
      await backend.close()
    }
  })

  test("concurrent and repeated validation is singleflighted and throttled", async () => {
    const root = isolatedDir("wb-reauth-throttle-")
    setTestAccountStore(root)
    const backend = await startFakeBackend({ accountsStatus: () => 401, refreshStatus: 403 })
    try {
      setTestBackend(backend.url)
      const account = fakeAccount({ uid: "u-throttle" })
      const [first, second] = await Promise.all([
        validateAccountAuth(account),
        validateAccountAuth(account),
      ])
      expect(first).toBe("invalid")
      expect(second).toBe("invalid")
      // One probe pair + one refresh for both concurrent callers.
      expect(backend.counts.accounts).toBe(2)
      expect(backend.counts.refresh).toBe(1)
      // A sequential repeat inside the cooldown reuses the materialized
      // verdict: a rejected credential must not become a retry loop.
      expect(await validateAccountAuth(account)).toBe("invalid")
      expect(backend.counts.accounts).toBe(2)
      expect(backend.counts.refresh).toBe(1)
    } finally {
      await backend.close()
    }
  })
})

describe("WorkBuddy governor re-auth semantics", () => {
  async function runGeneration(
    governor: WorkBuddyEntitlementGovernor,
    refresh: () => Promise<{ ok: true } | { ok: false; rejected: boolean }>,
  ) {
    const res = await governor.runGeneration({
      priority: 2,
      genKey: `gen-${Math.random().toString(36).slice(2)}`,
      model: "hy4-preview",
      session: "ses-reauth",
      isExpired: () => false,
      refresh,
      transport: async () =>
        new Response(JSON.stringify({ code: 10001, msg: "token expired" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      enrollmentEpoch: "epoch-reauth",
    })
    await res.res.text().catch(() => undefined)
    res.lease.release()
    return res
  }

  test("a rejected refresh persists AUTH_INVALID across restart", async () => {
    const file = join(isolatedDir("wb-reauth-rejected-"), "entitlement.json")
    const governor = new WorkBuddyEntitlementGovernor({ persistenceFile: file })
    const res = await runGeneration(governor, async () => ({ ok: false, rejected: true }))
    expect(res.committed).toBe(false)
    expect(governor.metrics().state).toBe("AUTH_INVALID")
    expect(new WorkBuddyEntitlementGovernor({ persistenceFile: file }).metrics().state).toBe("AUTH_INVALID")
  })

  test("a transient refresh failure never exiles the account", async () => {
    const governor = new WorkBuddyEntitlementGovernor({
      persistenceFile: join(isolatedDir("wb-reauth-transient-"), "entitlement.json"),
    })
    await runGeneration(governor, async () => ({ ok: false, rejected: false }))
    expect(governor.metrics().state).toBe("READY")
    // Negative invariant: no redundant second transport attempt after the
    // refresh failed — one attempt per generation, no retry loop.
    expect(governor.metrics().attempts).toBe(1)
    expect(governor.metrics().failed).toBe(1)
  })

  test("a successful refresh whose retry still 401s is definitive", async () => {
    const governor = new WorkBuddyEntitlementGovernor({
      persistenceFile: join(isolatedDir("wb-reauth-retry-"), "entitlement.json"),
    })
    await runGeneration(governor, async () => ({ ok: true }))
    expect(governor.metrics().attempts).toBe(2)
    // authRecoveries counts only *successful* recoveries; this retry still
    // 401ed, so the amplification is exactly 2 attempts for 1 generation.
    expect(governor.metrics().authRecoveries).toBe(0)
    expect(governor.metrics().amplification).toBe(2)
    expect(governor.metrics().state).toBe("AUTH_INVALID")
  })
})
