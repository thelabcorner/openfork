import { describe, expect, test, afterEach } from "bun:test"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  buildUpstreamBody,
  classify,
  detectThinkingMode,
  isReasoningModel,
  repairHistoryForThinking,
  setDiscoveryCacheForTest,
  setTestAccountStore,
  setTestBackend,
  toClientError,
  validateAccountAuth,
} from "@/plugin/workbuddy"
import {
  isValidationError,
  parseErrorCode,
  WORKBUDDY_THINKING_ROUNDTRIP_CODE,
} from "@/plugin/workbuddy-model-entitlement"
import { WorkBuddyEntitlementGovernor } from "@/plugin/workbuddy-governor"
import type { WorkBuddyAccount } from "@/plugin/workbuddy-accounts"

const ROUNDTRIP = JSON.stringify({
  code: 11155,
  msg: "the reasoning content from the previous turn must be passed back in thinking mode",
})

afterEach(() => setTestBackend(undefined))

function isolatedFile(): string {
  return join(mkdtempSync(join(tmpdir(), "wb-think-")), "entitlement.json")
}

function fakeAccount(overrides?: Partial<WorkBuddyAccount["credential"]>): WorkBuddyAccount {
  const id = `wb-test-${Math.random().toString(36).slice(2, 8)}`
  return {
    id,
    uid: overrides?.uid ?? id,
    nickname: overrides?.nickname ?? "test@example.com",
    realm: "www.workbuddy.ai",
    authPath: `/tmp/${id}.json`,
    credential: {
      path: `/tmp/${id}.json`,
      accessToken: "ACCESS",
      refreshToken: "REFRESH",
      domain: "www.workbuddy.ai",
      uid: overrides?.uid ?? id,
      enterpriseId: "",
      expiresAt: 0,
      nickname: "test@example.com",
      ...overrides,
    },
    governor: new WorkBuddyEntitlementGovernor({ persistenceFile: isolatedFile() }),
    mtime: 0,
    source: "vault",
  }
}

type FakeUpstream = {
  url: string
  close: () => Promise<void>
  counts: { accounts: number; refresh: number }
  lastAuthHeader: string | undefined
}

function startFakeUpstream(opts: {
  accountsStatus: (authHeader: string | undefined) => number
  refreshStatus?: number
  refreshBody?: unknown
}): Promise<FakeUpstream> {
  const counts = { accounts: 0, refresh: 0 }
  let lastAuthHeader: string | undefined
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const url = new URL(req.url ?? "/", "http://127.0.0.1")
      if (url.pathname === "/v2/plugin/accounts") {
        counts.accounts++
        lastAuthHeader = req.headers.authorization
        const status = opts.accountsStatus(req.headers.authorization)
        res.writeHead(status, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify(
            status === 200 ? { code: 0, data: { accounts: [{ uid: "fake-uid" }] } } : { code: 10001, msg: "token expired" },
          ),
        )
        return
      }
      if (url.pathname === "/v2/plugin/auth/token/refresh") {
        counts.refresh++
        res.writeHead(opts.refreshStatus ?? 500, { "Content-Type": "application/json" })
        res.end(JSON.stringify(opts.refreshBody ?? {}))
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
        close: () => new Promise<void>((done) => server.close(() => done())),
        counts,
        get lastAuthHeader() {
          return lastAuthHeader
        },
      })
    })
  })
}

describe("WorkBuddy 11155 thinking-mode round-trip", () => {
  test("isValidationError covers 11155 only, not forbidden/quota/auth codes", () => {
    expect(parseErrorCode(ROUNDTRIP)).toBe(WORKBUDDY_THINKING_ROUNDTRIP_CODE)
    expect(isValidationError(ROUNDTRIP)).toBe(true)
    // 11140 is auth_forbidden (account-level), handled by isAccountForbidden,
    // never treated as a body-validation error.
    expect(isValidationError(JSON.stringify({ code: 11140, msg: "request illegal" }))).toBe(false)
    expect(isValidationError(JSON.stringify({ code: 6004, msg: "frequency" }))).toBe(false)
    expect(isValidationError(JSON.stringify({ code: 10001, msg: "token expired" }))).toBe(false)
  })

  test("11155 maps to 400 invalid_request, never to authentication_error", () => {
    const mapped = toClientError(classify(400, ROUNDTRIP), {
      accountLabel: "a@example.com",
      accountId: "wb-a-0001",
      model: "hy4-preview",
    })
    expect(mapped.status).toBe(400)
    expect(mapped.body.error.type).toBe("invalid_request_error")
    expect(mapped.body.error.message).toContain("11155")
    expect(mapped.body.error.message).toContain("reasoning")
    expect(mapped.body.error.message).not.toContain("not authorized")
  })

  test("detectThinkingMode fires on echo evidence or a known reasoning model", () => {
    const withEcho = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "checking", reasoning_content: "user wants X" },
    ]
    expect(detectThinkingMode(withEcho, "some-plain-model")).toBe(true)
    const silent = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "done", tool_calls: [{ id: "1", type: "function" }] },
    ]
    // Negative invariant: no evidence, unknown model → no unsolicited fields.
    expect(detectThinkingMode(silent, "some-plain-model-zzz")).toBe(false)
    // Thinker with silent history (fast tool turn) still counts.
    expect(detectThinkingMode(silent, "hy4-preview")).toBe(true)
  })

  test("repairHistoryForThinking preserves, adopts, and defaults without reordering", () => {
    const input = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "checking", reasoning_content: "user wants X" },
      { role: "tool", tool_call_id: "1", content: "{}" },
      { role: "assistant", content: "done", tool_calls: [{ id: "1", type: "function" }] },
      { role: "assistant", content: "alt", reasoning: "legacy key" },
    ]
    const out = repairHistoryForThinking(input)
    expect(out.map((m: any) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant", "assistant"])
    // Existing value preserved byte-identical.
    expect((out[2] as any).reasoning_content).toBe("user wants X")
    // Missing field defaults to "".
    expect((out[4] as any).reasoning_content).toBe("")
    expect((out[4] as any).tool_calls).toHaveLength(1)
    // Non-canonical key adopted.
    expect((out[5] as any).reasoning_content).toBe("legacy key")
    // Non-assistant messages untouched (same reference).
    expect(out[3]).toBe(input[3])
    expect(out[0]).toBe(input[0])
  })

  test("isReasoningModel reads static fallback and live cache", () => {
    expect(isReasoningModel("hy4-preview")).toBe(true)
    expect(isReasoningModel("HY4-Preview")).toBe(true)
    expect(isReasoningModel("bogus-model-zzz")).toBe(false)
    setDiscoveryCacheForTest("acct-live", [
      {
        id: "custom-thinker",
        name: "Custom",
        family: "custom",
        context: 1000,
        output: 100,
        reasoning: true,
        release: "",
        attachment: false,
        credits: 0,
        creditsFree: false,
        creditsLabel: "",
      },
    ])
    expect(isReasoningModel("custom-thinker")).toBe(true)
  })

  test("repaired history survives buildUpstreamBody unchanged in shape", () => {
    const history = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "done", tool_calls: [{ id: "1", type: "function" }] },
    ]
    const repaired = repairHistoryForThinking(history)
    const body = buildUpstreamBody({ model: "hy4-preview" }, repaired, "hy4-preview") as any
    expect(body.messages[2].reasoning_content).toBe("")
    expect(body.messages[0].role).toBe("system")
  })

  test("11155 fails fast in the governor without refresh or AUTH_INVALID", async () => {
    const governor = new WorkBuddyEntitlementGovernor({ persistenceFile: isolatedFile() })
    let refreshCalls = 0
    const res = await governor.runGeneration({
      priority: 2,
      genKey: `gen-${Math.random().toString(36).slice(2)}`,
      model: "hy4-preview",
      session: "ses-test",
      isExpired: () => false,
      refresh: async () => {
        refreshCalls++
        return { ok: false, rejected: true }
      },
      transport: async () => new Response(ROUNDTRIP, { status: 400, headers: { "Content-Type": "application/json" } }),
      enrollmentEpoch: "epoch-test",
    })
    await res.res.text().catch(() => "")
    res.lease.release()
    expect(res.committed).toBe(false)
    expect(refreshCalls).toBe(0)
    expect(governor.metrics().state).toBe("READY")
  })

  test("markAuthInvalid persists and survives a restart", async () => {
    const file = isolatedFile()
    const governor = new WorkBuddyEntitlementGovernor({ persistenceFile: file })
    governor.markAuthInvalid(401, 10001)
    expect(governor.metrics().state).toBe("AUTH_INVALID")
    expect(governor.metrics().lastAuthFailure).toMatchObject({ status: 401, code: 10001 })
    expect(new WorkBuddyEntitlementGovernor({ persistenceFile: file }).metrics().state).toBe("AUTH_INVALID")
  })
})

describe("WorkBuddy proactive auth validation", () => {
  test("invalid: 401 that survives refresh persists AUTH_INVALID", async () => {
    const upstream = await startFakeUpstream({ accountsStatus: () => 401, refreshStatus: 500 })
    try {
      setTestBackend(upstream.url)
      const account = fakeAccount()
      expect(await validateAccountAuth(account)).toBe("invalid")
      expect(account.governor.metrics().state).toBe("AUTH_INVALID")
      expect(upstream.counts.refresh).toBe(1)
      expect(upstream.lastAuthHeader).toBe("Bearer ACCESS")
    } finally {
      await upstream.close()
    }
  })

  test("valid: a 200 clears a learned AUTH_INVALID", async () => {
    const upstream = await startFakeUpstream({ accountsStatus: () => 200 })
    try {
      setTestBackend(upstream.url)
      const account = fakeAccount()
      account.governor.markAuthInvalid(401)
      expect(await validateAccountAuth(account)).toBe("valid")
      expect(account.governor.metrics().state).toBe("READY")
    } finally {
      await upstream.close()
    }
  })

  test("unknown: network errors change nothing", async () => {
    const probe = await startFakeUpstream({ accountsStatus: () => 200 })
    const deadUrl = probe.url
    await probe.close()
    setTestBackend(deadUrl)
    const account = fakeAccount()
    expect(await validateAccountAuth(account)).toBe("unknown")
    expect(account.governor.metrics().state).toBe("READY")
    expect(account.governor.metrics().lastAuthFailure).toBeNull()
  })

  test("expired credential refreshes before judgment and persists the new token", async () => {
    const root = mkdtempSync(join(tmpdir(), "wb-val-"))
    setTestAccountStore(root)
    const upstream = await startFakeUpstream({
      accountsStatus: (auth) => (auth === "Bearer NEW_TOKEN" ? 200 : 401),
      refreshStatus: 200,
      refreshBody: { data: { accessToken: "NEW_TOKEN", refreshToken: "NEW_REFRESH", expiresIn: 3600 } },
    })
    try {
      setTestBackend(upstream.url)
      const account = fakeAccount({
        uid: "val-uid-10",
        accessToken: "OLD_TOKEN",
        refreshToken: "REF",
        expiresAt: Date.now() - 5_000,
      })
      expect(await validateAccountAuth(account)).toBe("valid")
      expect(account.credential.accessToken).toBe("NEW_TOKEN")
      expect(account.governor.metrics().state).toBe("READY")
    } finally {
      await upstream.close()
    }
  })
})
