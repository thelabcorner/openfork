import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { buildUpstreamBody, classify, toClientError } from "@/plugin/workbuddy"
import {
  isAccountForbidden,
  isBalanceExhausted,
  parseErrorCode,
  parseErrorMessage,
  WORKBUDDY_REQUEST_ILLEGAL_CODE,
} from "@/plugin/workbuddy-model-entitlement"
import { WorkBuddyEntitlementGovernor, type RefreshResult } from "@/plugin/workbuddy-governor"
import {
  AccountRegistry,
  AccountVault,
  AccountRouter,
  type AccountRegistry as AccountRegistryType,
  type WorkBuddyAccount,
} from "@/plugin/workbuddy-accounts"
import type { EntitlementState } from "@/plugin/workbuddy-governor"

const ILLEGAL_DIRECT = JSON.stringify({ code: 11140, msg: "request illegal" })
const ILLEGAL_WRAPPED = JSON.stringify({
  code: -32603,
  message: "Internal error",
  data: {
    details: "403 request illegal (1eb3131717b94a5c8f6531cfd3cf0088/99f93csc6-761f-4aa3-9858-357732e1a657)",
    statusCode: 403,
    code: 11140,
    category: "internal",
  },
})

describe("WorkBuddy 11140 error semantics", () => {
  test("parseErrorCode prefers the innermost Tencent code over a wrapper", () => {
    expect(parseErrorCode(ILLEGAL_DIRECT)).toBe(11140)
    // A first-match regex would return the JSON-RPC wrapper (-32603).
    expect(parseErrorCode(ILLEGAL_WRAPPED)).toBe(11140)
    expect(parseErrorCode(JSON.stringify({ code: 6004, msg: "frequency" }))).toBe(6004)
    expect(parseErrorCode(JSON.stringify({ error_code: 80006, msg: "suspended" }))).toBe(80006)
    expect(parseErrorCode("not json at all")).toBeUndefined()
  })

  test("parseErrorMessage prefers the inner Tencent message", () => {
    expect(parseErrorMessage(ILLEGAL_DIRECT, "fallback")).toBe("request illegal")
    expect(parseErrorMessage(ILLEGAL_WRAPPED, "fallback")).toContain("request illegal")
    expect(parseErrorMessage("", "fallback")).toBe("fallback")
    // Tencent's localized display message wins over the raw code text.
    expect(
      parseErrorMessage(
        JSON.stringify({
          code: 11140,
          msg: "request illegal",
          displayMsg: { en: "The content did not pass the safety review. Please adjust and retry." },
        }),
        "fallback",
      ),
    ).toBe("The content did not pass the safety review. Please adjust and retry.")
  })

  test("isAccountForbidden detects every 11140 envelope", () => {
    expect(isAccountForbidden(ILLEGAL_DIRECT)).toBe(true)
    expect(isAccountForbidden(ILLEGAL_WRAPPED)).toBe(true)
    expect(isAccountForbidden(JSON.stringify({ code: 11142, msg: "forbidden" }))).toBe(true)
    expect(isAccountForbidden(JSON.stringify({ code: 6004, msg: "frequency" }))).toBe(false)
    expect(isAccountForbidden(JSON.stringify({ code: 11155, msg: "thinking mode" }))).toBe(false)
    expect(isAccountForbidden("plain 500")).toBe(false)
  })

  test("classify carries a numeric Tencent code", () => {
    const failure = classify(403, ILLEGAL_DIRECT)
    expect(failure.code).toBe(WORKBUDDY_REQUEST_ILLEGAL_CODE)
    expect(failure.message).toBe("request illegal")
  })

  test("11140 maps to 403 account_forbidden with actionable guidance", () => {
    for (const raw of [ILLEGAL_DIRECT, ILLEGAL_WRAPPED]) {
      const mapped = toClientError(classify(403, raw), {
        accountLabel: "southsidehype111",
        accountId: "wb-southsidehype111-1234",
        model: "deepseek-v4.1-flash",
      })
      expect(mapped.status).toBe(403)
      expect(mapped.body.error.type).toBe("account_forbidden")
      expect(mapped.body.error.message).toContain("restricted")
      expect(mapped.body.error.message).toContain("southsidehype111")
      expect(mapped.body.error.message).toContain("deepseek-v4.1-flash")
      expect(mapped.body.error.message).toContain("re-authenticating does not clear it")
      expect(mapped.body.error.message).not.toContain("invalid_request")
    }
  })

  test("true 401 names the account and tells the user the vault is stale", () => {
    const mapped = toClientError(classify(401, JSON.stringify({ code: 10001, msg: "token expired" })), {
      accountLabel: "a@example.com",
      accountId: "wb-a-0001",
      model: "hy4-preview",
      refreshAttempted: true,
    })
    expect(mapped.status).toBe(401)
    expect(mapped.body.error.type).toBe("authentication_error")
    expect(mapped.body.error.message).toContain("a@example.com")
    expect(mapped.body.error.message).toContain("refresh was attempted")
    expect(mapped.body.error.message).toContain("vault token")
  })

  test("402 still maps to quota", () => {
    const mapped = toClientError(classify(402, JSON.stringify({ code: 0, msg: "insufficient credit" })), {
      accountLabel: "a@example.com",
    })
    expect(mapped.status).toBe(402)
    expect(mapped.body.error.type).toBe("quota_exceeded")
  })

  test("balance exhaustion (14018) maps to quota even inside an HTTP 429 envelope", () => {
    const raw = JSON.stringify({
      error: {
        data: {
          code: 14018,
          msg: "Credits exhausted. Please visit the link below to purchase add-on packs and get more credits",
        },
      },
    })
    expect(isBalanceExhausted(raw)).toBe(true)
    expect(isBalanceExhausted(JSON.stringify({ code: 6004, msg: "frequency" }))).toBe(false)
    const mapped = toClientError(classify(429, raw), { accountLabel: "a@example.com" })
    expect(mapped.status).toBe(402)
    expect(mapped.body.error.type).toBe("quota_exceeded")
  })
})

describe("WorkBuddy upstream body (field allowlist)", () => {
  test("forwards only proven fields and never leaks routing hints", () => {
    const body = buildUpstreamBody(
      {
        model: "hy4-preview",
        temperature: 0.7,
        max_tokens: 100,
        reasoning_effort: "high",
        response_format: { type: "json_object" },
        user: "someone",
        context_window_tokens: 262144,
        contextWindowTokens: 262144,
      },
      [{ role: "system", content: "hi" }],
      "hy4-preview",
    )
    expect(body.model).toBe("hy4-preview")
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
    expect(body.temperature).toBe(0.7)
    expect(body.max_tokens).toBe(100)
    // Negative invariants: these fields are not part of the proven wire shape.
    for (const illegal of [
      "reasoning_effort",
      "response_format",
      "user",
      "context_window_tokens",
      "contextWindowTokens",
    ]) {
      expect(illegal in body).toBe(false)
    }
  })

  test("context alias selection stays client-side", () => {
    const body = buildUpstreamBody({ model: "hy4-preview#ctx-262144" }, [], "hy4-preview")
    expect(body.model).toBe("hy4-preview")
    expect("context_window_tokens" in body).toBe(false)
  })
})

describe("WorkBuddy governor auth learning", () => {
  function isolatedFile(): string {
    const dir = mkdtempSync(join(tmpdir(), "wb-gov-"))
    return join(dir, "entitlement.json")
  }

  async function runOnce(
    governor: WorkBuddyEntitlementGovernor,
    status: number,
    raw: string,
    opts?: { refresh?: () => Promise<RefreshResult>; onRefresh?: () => void },
  ) {
    let refreshCalls = 0
    const res = await governor.runGeneration({
      priority: 2,
      genKey: `gen-${Math.random().toString(36).slice(2)}`,
      model: "hy4-preview",
      session: "ses-test",
      isExpired: () => false,
      refresh: async () => {
        refreshCalls++
        opts?.onRefresh?.()
        // Default mirrors a dead credential: the refresh endpoint answers
        // 401/403. Transient-failure semantics are covered by the reauth suite.
        return opts?.refresh ? opts.refresh() : { ok: false, rejected: true }
      },
      transport: async () => new Response(raw, { status, headers: { "Content-Type": "application/json" } }),
      enrollmentEpoch: "epoch-test",
    })
    // Drain the terminal body so the lease releases before assertions.
    await res.res.text().catch(() => "")
    res.lease.release()
    return { res, refreshCalls }
  }

  test("11140 quarantines the account as forbidden, fails fast, and persists", async () => {
    const file = isolatedFile()
    const governor = new WorkBuddyEntitlementGovernor({ persistenceFile: file, forbiddenCooldownMs: 60_000 })
    const { res, refreshCalls } = await runOnce(governor, 403, ILLEGAL_DIRECT)
    expect(res.committed).toBe(false)
    expect(res.res.status).toBe(403)
    // A refresh cannot clear an account-level restriction (verified live), so
    // the generation must not waste one; it fails fast on attempt 1.
    expect(refreshCalls).toBe(0)
    expect(governor.metrics().attempts).toBe(1)
    expect(governor.metrics().state).toBe("ACCOUNT_FORBIDDEN")
    expect(governor.metrics().forbiddenUntil).toBeGreaterThan(Date.now())
    const reloaded = new WorkBuddyEntitlementGovernor({ persistenceFile: file, forbiddenCooldownMs: 60_000 })
    expect(reloaded.metrics().state).toBe("ACCOUNT_FORBIDDEN")
    // The quarantine rejects new admissions with its own error class.
    await expect(
      governor.runGeneration({
        priority: 2,
        genKey: "gen-after-forbidden",
        model: "hy4-preview",
        session: "ses-test",
        isExpired: () => false,
        refresh: async () => ({ ok: false, rejected: true }),
        transport: async () => new Response("{}", { status: 200 }),
        enrollmentEpoch: "epoch-test",
      }),
    ).rejects.toMatchObject({ kind: "forbidden", status: 403 })
  })

  test("11140 in the wrapped envelope is also quarantined", async () => {
    const governor = new WorkBuddyEntitlementGovernor({ persistenceFile: isolatedFile() })
    await runOnce(governor, 403, ILLEGAL_WRAPPED)
    expect(governor.metrics().state).toBe("ACCOUNT_FORBIDDEN")
  })

  test("an elapsed forbidden window loads as READY and admits again", async () => {
    const file = isolatedFile()
    const governor = new WorkBuddyEntitlementGovernor({ persistenceFile: file, forbiddenCooldownMs: 60_000 })
    await runOnce(governor, 403, ILLEGAL_DIRECT)
    const persisted = JSON.parse(readFileSync(file, "utf8")) as any
    persisted.forbiddenUntil = Date.now() - 1
    writeFileSync(file, JSON.stringify(persisted))
    const reloaded = new WorkBuddyEntitlementGovernor({ persistenceFile: file, forbiddenCooldownMs: 60_000 })
    expect(reloaded.metrics().state).toBe("READY")
    expect(reloaded.isAccountForbidden()).toBe(false)
  })

  test("clearLearnedBlocks clears the forbidden quarantine", async () => {
    const governor = new WorkBuddyEntitlementGovernor({ persistenceFile: isolatedFile(), forbiddenCooldownMs: 60_000 })
    await runOnce(governor, 403, ILLEGAL_DIRECT)
    expect(governor.metrics().state).toBe("ACCOUNT_FORBIDDEN")
    governor.clearLearnedBlocks()
    expect(governor.metrics().state).toBe("READY")
    expect(governor.metrics().forbiddenUntil).toBeNull()
  })

  test("true 401 persists AUTH_INVALID and survives a restart", async () => {
    const file = isolatedFile()
    const governor = new WorkBuddyEntitlementGovernor({ persistenceFile: file })
    await runOnce(governor, 403, JSON.stringify({ code: 10001, msg: "token expired" }))
    expect(governor.metrics().state).toBe("AUTH_INVALID")
    const reloaded = new WorkBuddyEntitlementGovernor({ persistenceFile: file })
    expect(reloaded.metrics().state).toBe("AUTH_INVALID")
  })

  test("429 balance exhaustion quarantines as QUOTA_EXHAUSTED, not transient cooldown", async () => {
    const governor = new WorkBuddyEntitlementGovernor({ persistenceFile: isolatedFile() })
    await runOnce(governor, 429, JSON.stringify({ error: { data: { code: 14018, msg: "Credits exhausted" } } }))
    expect(governor.metrics().state).toBe("QUOTA_EXHAUSTED")
  })

  test("clearAuthInvalid heals a dead-token verdict without lifting a quarantine", async () => {
    const governor = new WorkBuddyEntitlementGovernor({ persistenceFile: isolatedFile() })
    await runOnce(governor, 401, JSON.stringify({ code: 10001, msg: "token expired" }))
    expect(governor.metrics().state).toBe("AUTH_INVALID")
    governor.clearAuthInvalid()
    expect(governor.metrics().state).toBe("READY")
  })

  test("an older in-flight success cannot clear a newer concurrent 11140 quarantine", async () => {
    const governor = new WorkBuddyEntitlementGovernor({
      persistenceFile: isolatedFile(),
      maxConcurrent: 2,
      launchBurst: 2,
      launchPerSec: 1_000,
      forbiddenCooldownMs: 60_000,
    })
    let releaseSuccess!: () => void
    let releaseForbidden!: () => void
    const successGate = new Promise<void>((resolve) => { releaseSuccess = resolve })
    const forbiddenGate = new Promise<void>((resolve) => { releaseForbidden = resolve })

    const success = governor.runGeneration({
      priority: 2,
      genKey: "gen-stale-success",
      model: "hy4-preview",
      session: "ses-success",
      isExpired: () => false,
      refresh: async () => ({ ok: false, rejected: true }),
      transport: async () => {
        await successGate
        return new Response("ok", { status: 200 })
      },
    })
    const forbidden = governor.runGeneration({
      priority: 2,
      genKey: "gen-newer-forbidden",
      model: "hy4-preview",
      session: "ses-forbidden",
      isExpired: () => false,
      refresh: async () => ({ ok: false, rejected: true }),
      transport: async () => {
        await forbiddenGate
        return new Response(ILLEGAL_DIRECT, { status: 403, headers: { "Content-Type": "application/json" } })
      },
    })

    for (let i = 0; i < 20 && governor.metrics().active < 2; i++) await Promise.resolve()
    expect(governor.metrics().active).toBe(2)

    releaseForbidden()
    const forbiddenResult = await forbidden
    expect(forbiddenResult.routeFailure).toBe("forbidden")
    expect(governor.metrics().state).toBe("ACCOUNT_FORBIDDEN")
    forbiddenResult.lease.release()

    releaseSuccess()
    const successResult = await success
    expect(successResult.committed).toBe(true)
    expect(successResult.routeFailure).toBeNull()
    // The success began before the 11140 was learned. It is stale evidence and
    // must not make the newly restricted account routable again.
    expect(governor.metrics().state).toBe("ACCOUNT_FORBIDDEN")
    successResult.lease.release()
  })

  test("an old-credential 401 cannot re-poison an account after authoritative credential replacement", async () => {
    const governor = new WorkBuddyEntitlementGovernor({
      persistenceFile: isolatedFile(),
      maxConcurrent: 1,
      launchBurst: 1,
      launchPerSec: 1_000,
    })
    let releaseOldCredential!: () => void
    const oldCredentialGate = new Promise<void>((resolve) => { releaseOldCredential = resolve })
    let markOldTransportStarted!: () => void
    const oldTransportStarted = new Promise<void>((resolve) => { markOldTransportStarted = resolve })

    const stale = governor.runGeneration({
      priority: 2,
      genKey: "gen-old-credential",
      model: "hy4-preview",
      session: "ses-old-credential",
      isExpired: () => false,
      refresh: async () => ({ ok: false, rejected: true }),
      transport: async () => {
        markOldTransportStarted()
        await oldCredentialGate
        return new Response(JSON.stringify({ code: 10001, msg: "token expired" }), { status: 401 })
      },
    })

    await oldTransportStarted

    // Models a desktop heal/import/re-enrollment that replaces the credential
    // after the old bearer request is definitely already on the wire.
    governor.recordCredentialReplacement()
    releaseOldCredential()

    const result = await stale
    expect(result.res.status).toBe(401)
    expect(result.routeFailure).toBeNull()
    expect(governor.metrics().state).toBe("READY")
    result.lease.release()
  })

  test("a queued generation learns from the replacement credential it actually launches with", async () => {
    const governor = new WorkBuddyEntitlementGovernor({
      persistenceFile: isolatedFile(),
      maxConcurrent: 1,
      launchBurst: 2,
      launchPerSec: 1_000,
      forbiddenCooldownMs: 60_000,
    })
    let releaseBlocker!: () => void
    const blockerGate = new Promise<void>((resolve) => { releaseBlocker = resolve })

    const blocker = governor.runGeneration({
      priority: 2,
      genKey: "gen-credential-replacement-blocker",
      model: "hy4-preview",
      session: "ses-blocker",
      isExpired: () => false,
      refresh: async () => ({ ok: false, rejected: true }),
      transport: async () => {
        await blockerGate
        // Null body makes this generation release its lease immediately on
        // success, allowing the queued generation to acquire the slot.
        return new Response(null, { status: 200 })
      },
    })

    for (let i = 0; i < 20 && governor.metrics().active < 1; i++) await Promise.resolve()
    expect(governor.metrics().active).toBe(1)

    const queued = governor.runGeneration({
      priority: 2,
      genKey: "gen-after-credential-replacement",
      model: "hy4-preview",
      session: "ses-queued",
      isExpired: () => false,
      refresh: async () => ({ ok: false, rejected: true }),
      transport: async () => new Response(ILLEGAL_DIRECT, { status: 403 }),
    })
    for (let i = 0; i < 20 && governor.metrics().queued < 1; i++) await Promise.resolve()
    expect(governor.metrics().queued).toBe(1)

    // Replacement occurs while the second logical generation is queued. Its
    // eventual transport therefore belongs to the NEW credential generation,
    // and a 11140 from that transport is authoritative rather than stale.
    governor.recordCredentialReplacement()
    releaseBlocker()
    await blocker

    const result = await queued
    expect(result.res.status).toBe(403)
    expect(result.routeFailure).toBe("forbidden")
    expect(governor.metrics().state).toBe("ACCOUNT_FORBIDDEN")
    result.lease.release()
  })
})

describe("WorkBuddy bounded multi-account generation routing", () => {
  const MODEL = "deepseek-v4.1-flash"

  function routedAccount(
    id: string,
    options: { models?: string[]; maxConcurrent?: number } = {},
  ): WorkBuddyAccount {
    const dir = mkdtempSync(join(tmpdir(), `wb-route-${id}-`))
    return {
      id,
      uid: id,
      nickname: `${id}@example.com`,
      realm: "www.workbuddy.cn",
      authPath: join(dir, `${id}.json`),
      credential: {
        path: join(dir, `${id}.json`),
        accessToken: `access-${id}`,
        refreshToken: `refresh-${id}`,
        domain: "www.workbuddy.cn",
        uid: id,
        enterpriseId: "",
        expiresAt: 0,
        nickname: `${id}@example.com`,
        enrollmentEpoch: `epoch-${id}`,
      },
      governor: new WorkBuddyEntitlementGovernor({
        persistenceFile: join(dir, "entitlement.json"),
        maxConcurrent: options.maxConcurrent ?? 8,
        launchBurst: 16,
        launchPerSec: 1_000,
        forbiddenCooldownMs: 60_000,
      }),
      ...(options.models
        ? { catalog: { ids: new Set(options.models), updatedAt: Date.now() } }
        : {}),
      mtime: 0,
      source: "vault",
    }
  }

  function routedRegistry(accounts: WorkBuddyAccount[]): AccountRegistryType {
    return {
      all: () => accounts,
      get: (id: string) => accounts.find((account) => account.id === id),
    } as unknown as AccountRegistryType
  }

  function forbiddenResponse(): Response {
    return new Response(ILLEGAL_DIRECT, { status: 403, headers: { "Content-Type": "application/json" } })
  }

  function successResponse(): Response {
    return new Response("ok", { status: 200, headers: { "Content-Type": "text/plain" } })
  }

  async function releaseResponse(result: Awaited<ReturnType<AccountRouter["runGeneration"]>>) {
    if (result.kind !== "response") return
    await result.generation.res.text().catch(() => undefined)
    result.generation.lease.release()
  }

  function route(
    router: AccountRouter,
    requestId: string,
    transport: (account: WorkBuddyAccount) => Promise<Response>,
    options: { session?: string; explicitAccountId?: string; signal?: AbortSignal } = {},
  ) {
    return router.runGeneration({
      priority: 2,
      requestId,
      requestedModel: MODEL,
      session: options.session ?? "ses-route",
      explicitAccountId: options.explicitAccountId,
      signal: options.signal,
      isExpired: () => false,
      refresh: async () => ({ ok: false, rejected: true }),
      transport,
    })
  }

  test("automatic A -> 11140 -> B succeeds, rebinds affinity, and future requests never probe A", async () => {
    const a = routedAccount("wb-a-0001", { models: [MODEL] })
    const b = routedAccount("wb-b-0002", { models: [MODEL] })
    const router = new AccountRouter({ registry: routedRegistry([a, b]) })
    const hits = new Map<string, number>()
    const transport = async (account: WorkBuddyAccount) => {
      hits.set(account.id, (hits.get(account.id) ?? 0) + 1)
      return account.id === a.id ? forbiddenResponse() : successResponse()
    }

    const first = await route(router, "req-1", transport)
    expect(first.kind).toBe("response")
    if (first.kind !== "response") throw new Error("expected routed response")
    expect(first.selection.account.id).toBe(b.id)
    expect(first.attemptedAccountIds).toEqual([a.id, b.id])
    expect(a.governor.metrics().state).toBe("ACCOUNT_FORBIDDEN")
    expect(router.binding("ses-route")).toBe(b.id)
    await releaseResponse(first)

    const second = await route(router, "req-2", transport)
    expect(second.kind).toBe("response")
    if (second.kind !== "response") throw new Error("expected routed response")
    expect(second.selection.account.id).toBe(b.id)
    expect(second.attemptedAccountIds).toEqual([b.id])
    await releaseResponse(second)

    expect(hits.get(a.id)).toBe(1)
    expect(hits.get(b.id)).toBe(2)
  })

  test("two newly forbidden accounts rotate to the third healthy account exactly once each", async () => {
    const a = routedAccount("wb-a-0001", { models: [MODEL] })
    const b = routedAccount("wb-b-0002", { models: [MODEL] })
    const c = routedAccount("wb-c-0003", { models: [MODEL] })
    const router = new AccountRouter({ registry: routedRegistry([a, b, c]) })
    const hits = new Map<string, number>()

    const result = await route(router, "req-three", async (account) => {
      hits.set(account.id, (hits.get(account.id) ?? 0) + 1)
      return account.id === c.id ? successResponse() : forbiddenResponse()
    })

    expect(result.kind).toBe("response")
    if (result.kind !== "response") throw new Error("expected routed response")
    expect(result.selection.account.id).toBe(c.id)
    expect(result.attemptedAccountIds).toEqual([a.id, b.id, c.id])
    expect(new Set(result.attemptedAccountIds).size).toBe(result.attemptedAccountIds.length)
    expect([...hits.values()]).toEqual([1, 1, 1])
    expect(a.governor.metrics().state).toBe("ACCOUNT_FORBIDDEN")
    expect(b.governor.metrics().state).toBe("ACCOUNT_FORBIDDEN")
    expect(router.binding("ses-route")).toBe(c.id)
    await releaseResponse(result)
  })

  test("one logical failover chain performs one registry discovery snapshot", async () => {
    const a = routedAccount("wb-a-0001", { models: [MODEL] })
    const b = routedAccount("wb-b-0002", { models: [MODEL] })
    const c = routedAccount("wb-c-0003", { models: [MODEL] })
    const accounts = [a, b, c]
    let allCalls = 0
    const registry = {
      all: () => {
        allCalls++
        return accounts
      },
      get: (id: string) => accounts.find((account) => account.id === id),
    } as unknown as AccountRegistryType
    const router = new AccountRouter({ registry })

    const result = await route(router, "req-single-discovery", async (account) =>
      account.id === c.id ? successResponse() : forbiddenResponse(),
    )

    expect(result.kind).toBe("response")
    if (result.kind !== "response") throw new Error("expected routed response")
    expect(result.attemptedAccountIds).toEqual([a.id, b.id, c.id])
    expect(allCalls).toBe(1)
    await releaseResponse(result)
  })

  test("all eligible accounts becoming forbidden stops after one attempt per candidate and releases every lease", async () => {
    const accounts = [
      routedAccount("wb-a-0001", { models: [MODEL] }),
      routedAccount("wb-b-0002", { models: [MODEL] }),
      routedAccount("wb-c-0003", { models: [MODEL] }),
    ]
    const router = new AccountRouter({ registry: routedRegistry(accounts) })
    const hits = new Map<string, number>()

    const result = await route(router, "req-all-forbidden", async (account) => {
      hits.set(account.id, (hits.get(account.id) ?? 0) + 1)
      return forbiddenResponse()
    })

    expect(result.kind).toBe("unavailable")
    expect(result.attemptedAccountIds).toEqual(accounts.map((account) => account.id))
    expect(new Set(result.attemptedAccountIds).size).toBe(accounts.length)
    expect([...hits.values()]).toEqual([1, 1, 1])
    expect(router.binding("ses-route")).toBeUndefined()
    for (const account of accounts) {
      expect(account.governor.metrics().state).toBe("ACCOUNT_FORBIDDEN")
      expect(account.governor.metrics().active).toBe(0)
      expect(account.governor.metrics().queued).toBe(0)
    }
  })

  test("explicitly pinned forbidden account fails on that account and never substitutes another account", async () => {
    const a = routedAccount("wb-a-0001", { models: [MODEL] })
    const b = routedAccount("wb-b-0002", { models: [MODEL] })
    const router = new AccountRouter({ registry: routedRegistry([a, b]) })
    const hits = new Map<string, number>()

    const result = await route(
      router,
      "req-explicit",
      async (account) => {
        hits.set(account.id, (hits.get(account.id) ?? 0) + 1)
        return account.id === a.id ? forbiddenResponse() : successResponse()
      },
      { explicitAccountId: a.id },
    )

    expect(result.kind).toBe("response")
    if (result.kind !== "response") throw new Error("expected pinned response")
    expect(result.selection.reason).toBe("explicit")
    expect(result.selection.account.id).toBe(a.id)
    expect(result.generation.res.status).toBe(403)
    expect(result.attemptedAccountIds).toEqual([a.id])
    expect(hits.get(a.id)).toBe(1)
    expect(hits.get(b.id) ?? 0).toBe(0)
    expect(a.governor.metrics().state).toBe("ACCOUNT_FORBIDDEN")
    expect(router.binding("ses-route")).toBe(a.id)
    await releaseResponse(result)
  })

  test("rotation preserves model-specific eligibility and never probes an ineligible account", async () => {
    const a = routedAccount("wb-a-0001", { models: [MODEL] })
    const wrongModel = routedAccount("wb-b-0002", { models: ["hy4-preview"] })
    const c = routedAccount("wb-c-0003", { models: [MODEL] })
    const router = new AccountRouter({ registry: routedRegistry([a, wrongModel, c]) })
    const hits = new Map<string, number>()

    const result = await route(router, "req-model-filter", async (account) => {
      hits.set(account.id, (hits.get(account.id) ?? 0) + 1)
      if (account.id === wrongModel.id) throw new Error("model-ineligible account was probed")
      return account.id === a.id ? forbiddenResponse() : successResponse()
    })

    expect(result.kind).toBe("response")
    if (result.kind !== "response") throw new Error("expected routed response")
    expect(result.attemptedAccountIds).toEqual([a.id, c.id])
    expect(hits.get(wrongModel.id) ?? 0).toBe(0)
    expect(result.selection.account.id).toBe(c.id)
    await releaseResponse(result)
  })

  test("durable quota exhaustion and definitive auth failure rotate, while preserving per-account learning", async () => {
    const cases = [
      {
        name: "quota",
        failure: () => new Response(
          JSON.stringify({ error: { data: { code: 14018, msg: "Credits exhausted" } } }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        ),
        state: "QUOTA_EXHAUSTED" as const,
      },
      {
        name: "auth",
        failure: () => new Response(
          JSON.stringify({ code: 10001, msg: "token expired" }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        ),
        state: "AUTH_INVALID" as const,
      },
    ]

    for (const testCase of cases) {
      const a = routedAccount(`wb-a-${testCase.name}`, { models: [MODEL] })
      const b = routedAccount(`wb-b-${testCase.name}`, { models: [MODEL] })
      const router = new AccountRouter({ registry: routedRegistry([a, b]) })
      let refreshCalls = 0
      const hits = new Map<string, number>()
      const result = await router.runGeneration({
        priority: 2,
        requestId: `req-${testCase.name}`,
        requestedModel: MODEL,
        session: `ses-${testCase.name}`,
        isExpired: () => false,
        refresh: async () => {
          refreshCalls++
          return { ok: false, rejected: true }
        },
        transport: async (account) => {
          hits.set(account.id, (hits.get(account.id) ?? 0) + 1)
          return account.id === a.id ? testCase.failure() : successResponse()
        },
      })

      expect(result.kind).toBe("response")
      if (result.kind !== "response") throw new Error("expected routed response")
      expect(result.selection.account.id).toBe(b.id)
      expect(result.attemptedAccountIds).toEqual([a.id, b.id])
      expect(a.governor.metrics().state).toBe(testCase.state)
      expect(hits.get(a.id)).toBe(1)
      expect(hits.get(b.id)).toBe(1)
      expect(refreshCalls).toBe(testCase.name === "auth" ? 1 : 0)
      await releaseResponse(result)
    }
  })

  test("queued automatic work evacuates a credential immediately after AUTH_INVALID is learned", async () => {
    const a = routedAccount("wb-a-auth-queue", { models: [MODEL], maxConcurrent: 1 })
    const b = routedAccount("wb-b-auth-queue", { models: [MODEL], maxConcurrent: 8 })
    const router = new AccountRouter({ registry: routedRegistry([a, b]) })
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    let aHits = 0
    let bHits = 0

    const runs = Array.from({ length: 3 }, (_, index) => router.runGeneration({
      priority: 2,
      requestId: `auth-queue-${index}`,
      requestedModel: MODEL,
      session: "ses-auth-queue",
      isExpired: () => false,
      refresh: async () => ({ ok: false, rejected: true }),
      transport: async (account) => {
        if (account.id === a.id) {
          aHits++
          await firstGate
          return new Response(JSON.stringify({ code: 10001, msg: "token expired" }), { status: 401 })
        }
        bHits++
        return successResponse()
      },
    }))

    for (let i = 0; i < 20 && a.governor.metrics().queued < 2; i++) await Promise.resolve()
    expect(a.governor.metrics().active).toBe(1)
    expect(a.governor.metrics().queued).toBe(2)
    releaseFirst()

    const results = await Promise.all(runs)
    expect(aHits).toBe(1)
    expect(bHits).toBe(3)
    expect(a.governor.metrics().state).toBe("AUTH_INVALID")
    for (const result of results) {
      expect(result.kind).toBe("response")
      if (result.kind !== "response") throw new Error("expected healthy-account response")
      expect(result.selection.account.id).toBe(b.id)
      expect(result.attemptedAccountIds).toEqual([a.id, b.id])
      await releaseResponse(result)
    }
    expect(a.governor.metrics().active).toBe(0)
    expect(a.governor.metrics().queued).toBe(0)
    expect(b.governor.metrics().active).toBe(0)
  })

  test("request-scoped and transient failures do not trigger account substitution", async () => {
    for (const failure of [
      new Response(JSON.stringify({ code: 11155, msg: "thinking mode validation" }), { status: 400 }),
      new Response("upstream unavailable", { status: 500 }),
    ]) {
      const a = routedAccount(`wb-a-${failure.status}`, { models: [MODEL] })
      const b = routedAccount(`wb-b-${failure.status}`, { models: [MODEL] })
      const router = new AccountRouter({ registry: routedRegistry([a, b]) })
      let bHits = 0
      const result = await route(router, `req-no-rotate-${failure.status}`, async (account) => {
        if (account.id === b.id) {
          bHits++
          return successResponse()
        }
        return failure.clone()
      })
      expect(result.kind).toBe("response")
      if (result.kind !== "response") throw new Error("expected terminal response")
      expect(result.selection.account.id).toBe(a.id)
      expect(result.generation.res.status).toBe(failure.status)
      expect(result.attemptedAccountIds).toEqual([a.id])
      expect(bHits).toBe(0)
      await releaseResponse(result)
    }
  })

  test("pre-existing AUTH_INVALID state cannot turn a request-scoped 4xx into a cross-account retry", async () => {
    const a = routedAccount("wb-a-stale-auth", { models: [MODEL] })
    const b = routedAccount("wb-b-stale-auth", { models: [MODEL] })
    a.governor.markAuthInvalid(401)
    b.governor.markAuthInvalid(401)
    const router = new AccountRouter({ registry: routedRegistry([a, b]) })
    let bHits = 0

    const result = await route(router, "req-stale-state", async (account) => {
      if (account.id === b.id) {
        bHits++
        return successResponse()
      }
      return new Response(JSON.stringify({ code: 11155, msg: "thinking mode validation" }), { status: 400 })
    })

    expect(result.kind).toBe("response")
    if (result.kind !== "response") throw new Error("expected request-scoped response")
    expect(result.selection.account.id).toBe(a.id)
    expect(result.generation.res.status).toBe(400)
    expect(result.generation.routeFailure).toBeNull()
    expect(result.attemptedAccountIds).toEqual([a.id])
    expect(bHits).toBe(0)
    await releaseResponse(result)
  })

  test("cancellation after a learned account failure aborts the logical generation before another account launches", async () => {
    const a = routedAccount("wb-a-0001", { models: [MODEL] })
    const b = routedAccount("wb-b-0002", { models: [MODEL] })
    const router = new AccountRouter({ registry: routedRegistry([a, b]) })
    const cancellation = new AbortController()
    let bHits = 0

    const result = await route(
      router,
      "req-cancel",
      async (account) => {
        if (account.id === b.id) {
          bHits++
          return successResponse()
        }
        cancellation.abort()
        return forbiddenResponse()
      },
      { signal: cancellation.signal },
    )

    expect(result.kind).toBe("admission")
    if (result.kind !== "admission") throw new Error("expected canceled admission")
    expect(result.error.kind).toBe("cancel")
    expect(result.attemptedAccountIds).toEqual([a.id])
    expect(bHits).toBe(0)
    expect(a.governor.metrics().state).toBe("ACCOUNT_FORBIDDEN")
    expect(a.governor.metrics().active).toBe(0)
  })

  test("six concurrent bare DeepSeek workers evacuate a newly forbidden affinity without piling more transports onto it", async () => {
    const a = routedAccount("wb-a-0001", { models: [MODEL], maxConcurrent: 1 })
    const b = routedAccount("wb-b-0002", { models: [MODEL], maxConcurrent: 8 })
    const router = new AccountRouter({ registry: routedRegistry([a, b]) })
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    let aHits = 0
    let bHits = 0

    const transport = async (account: WorkBuddyAccount) => {
      if (account.id === a.id) {
        aHits++
        await firstGate
        return forbiddenResponse()
      }
      bHits++
      return successResponse()
    }

    // A shared bare-model session affinity makes all six workers choose A
    // before the first upstream verdict is known. maxConcurrent=1 forces five
    // of them into A's governor queue, reproducing the race that previously
    // let a learned 11140 continue feeding the restricted account.
    const runs = Array.from({ length: 6 }, (_, index) =>
      route(router, `localmcp-deepseek-${index}`, transport, { session: "ses-live-deepseek" }),
    )
    for (let i = 0; i < 20 && a.governor.metrics().queued < 5; i++) await Promise.resolve()
    expect(a.governor.metrics().active).toBe(1)
    expect(a.governor.metrics().queued).toBe(5)

    releaseFirst()
    const results = await Promise.all(runs)
    expect(aHits).toBe(1)
    expect(bHits).toBe(6)
    expect(a.governor.metrics().state).toBe("ACCOUNT_FORBIDDEN")
    expect(a.governor.metrics().queued).toBe(0)
    expect(a.governor.metrics().active).toBe(0)
    for (const result of results) {
      expect(result.kind).toBe("response")
      if (result.kind !== "response") throw new Error("expected healthy-account response")
      expect(result.selection.account.id).toBe(b.id)
      expect(result.attemptedAccountIds).toEqual([a.id, b.id])
      await releaseResponse(result)
    }
    expect(b.governor.metrics().queued).toBe(0)
    expect(b.governor.metrics().active).toBe(0)
    expect(router.binding("ses-live-deepseek")).toBe(b.id)
  })

  test("six distinct bare DeepSeek worker sessions evacuate queued work after the first 11140 verdict", async () => {
    const a = routedAccount("wb-a-live-0001", { models: [MODEL], maxConcurrent: 1 })
    const b = routedAccount("wb-b-live-0002", { models: [MODEL], maxConcurrent: 1 })
    const router = new AccountRouter({ registry: routedRegistry([a, b]) })
    let releaseA!: () => void
    let releaseB!: () => void
    const gateA = new Promise<void>((resolve) => { releaseA = resolve })
    const gateB = new Promise<void>((resolve) => { releaseB = resolve })
    let aHits = 0
    let bHits = 0

    const transport = async (account: WorkBuddyAccount) => {
      if (account.id === a.id) {
        aHits++
        await gateA
        return forbiddenResponse()
      }
      bHits++
      await gateB
      return successResponse()
    }

    // Distinct sessions model separate localMCP/OpenCode workers using the
    // same bare provider/model. With both governors capped at one active
    // generation, load-aware selection spreads the initial workers across A
    // and B, while later workers queue behind those choices.
    const runs = Array.from({ length: 6 }, (_, index) =>
      route(router, `localmcp-distinct-${index}`, transport, { session: `ses-live-${index}` }).then(async (result) => {
        // Production drains/releases each successful response independently;
        // mirror that lifecycle here so B's maxConcurrent=1 queue can advance
        // while the other logical requests are still resolving.
        await releaseResponse(result)
        return result
      }),
    )
    for (let i = 0; i < 30 && (a.governor.metrics().queued < 1 || b.governor.metrics().queued < 1); i++) {
      await Promise.resolve()
    }
    expect(a.governor.metrics().active).toBe(1)
    expect(b.governor.metrics().active).toBe(1)
    expect(a.governor.metrics().queued).toBeGreaterThan(0)
    expect(b.governor.metrics().queued).toBeGreaterThan(0)

    // Only A's already-active physical request is allowed to reach Tencent.
    // Once its 11140 is learned, every request queued behind A must be rejected
    // locally and reselected onto B instead of launching another A transport.
    releaseA()
    for (let i = 0; i < 30 && a.governor.metrics().state !== "ACCOUNT_FORBIDDEN"; i++) await Promise.resolve()
    expect(a.governor.metrics().state).toBe("ACCOUNT_FORBIDDEN")
    expect(a.governor.metrics().queued).toBe(0)
    expect(aHits).toBe(1)

    releaseB()
    const results = await Promise.all(runs)
    expect(aHits).toBe(1)
    expect(bHits).toBe(6)
    expect(a.governor.metrics().active).toBe(0)
    expect(a.governor.metrics().queued).toBe(0)
    expect(b.governor.metrics().active).toBe(0)
    expect(b.governor.metrics().queued).toBe(0)
    for (const result of results) {
      expect(result.kind).toBe("response")
      if (result.kind !== "response") throw new Error("expected healthy-account response")
      expect(result.selection.account.id).toBe(b.id)
      expect(result.attemptedAccountIds.at(-1)).toBe(b.id)
      expect(new Set(result.attemptedAccountIds).size).toBe(result.attemptedAccountIds.length)
    }
  })
})

describe("WorkBuddy router dead-account handling", () => {
  function fakeAccount(
    id: string,
    nickname: string,
    state: EntitlementState,
  ): WorkBuddyAccount {
    return {
      id,
      uid: id,
      nickname,
      realm: "www.workbuddy.ai",
      authPath: `/tmp/${id}.json`,
      credential: {
        path: `/tmp/${id}.json`,
        accessToken: "access",
        refreshToken: "refresh",
        domain: "www.workbuddy.ai",
        uid: id,
        enterpriseId: "",
        expiresAt: 0,
        nickname,
      },
      governor: {
        metrics: () => ({
          state,
          active: 0,
          queued: 0,
          cooldownUntil: 0,
        }),
        canAdmitModel: () => true,
        hasKnownCredits: () => true,
      } as unknown as WorkBuddyEntitlementGovernor,
      mtime: 0,
      source: "vault",
    }
  }

  function fakeRegistry(accounts: WorkBuddyAccount[]): AccountRegistryType {
    return {
      all: () => accounts,
      get: (id: string) => accounts.find((account) => account.id === id),
    } as unknown as AccountRegistryType
  }

  test("an AUTH_INVALID account is skipped while a healthy one exists", () => {
    const dead = fakeAccount("wb-dead-0001", "dead@example.com", "AUTH_INVALID")
    const live = fakeAccount("wb-live-0002", "live@example.com", "READY")
    const router = new AccountRouter({ registry: fakeRegistry([dead, live]) })
    const selection = router.select("ses_1", "hy4-preview")
    expect(selection?.account.id).toBe("wb-live-0002")
  })

  test("a session pinned to a dead account auto-rotates instead of failing forever", () => {
    const dead = fakeAccount("wb-dead-0001", "dead@example.com", "AUTH_INVALID")
    const live = fakeAccount("wb-live-0002", "live@example.com", "READY")
    const router = new AccountRouter({ registry: fakeRegistry([dead, live]) })
    router.bind("ses_1", dead.id)
    const rotated = router.select("ses_1", "hy4-preview")
    expect(rotated?.account.id).toBe("wb-live-0002")
    expect(rotated?.reason).toBe("automatic")
  })

  test("a lone AUTH_INVALID account is still served (liveness over exclusion)", () => {
    const dead = fakeAccount("wb-dead-0001", "dead@example.com", "AUTH_INVALID")
    const router = new AccountRouter({ registry: fakeRegistry([dead]) })
    // Must not hard-fail with "no eligible account": the refresh-and-retry
    // inside the generation may still heal a transient 401.
    expect(router.select("ses_1", "hy4-preview")?.account.id).toBe("wb-dead-0001")
  })

  test("an ACCOUNT_FORBIDDEN account is skipped while a healthy one exists", () => {
    const restricted = fakeAccount("wb-restricted-0001", "restricted@example.com", "ACCOUNT_FORBIDDEN")
    const live = fakeAccount("wb-live-0002", "live@example.com", "READY")
    const router = new AccountRouter({ registry: fakeRegistry([restricted, live]) })
    expect(router.select("ses_1", "hy4-preview")?.account.id).toBe("wb-live-0002")
  })

  test("a session pinned to a forbidden account auto-rotates", () => {
    const restricted = fakeAccount("wb-restricted-0001", "restricted@example.com", "ACCOUNT_FORBIDDEN")
    const live = fakeAccount("wb-live-0002", "live@example.com", "READY")
    const router = new AccountRouter({ registry: fakeRegistry([restricted, live]) })
    router.bind("ses_1", restricted.id)
    const rotated = router.select("ses_1", "hy4-preview")
    expect(rotated?.account.id).toBe("wb-live-0002")
    expect(rotated?.reason).toBe("automatic")
  })

  test("a lone forbidden account is not selected (admission would 403 anyway)", () => {
    const restricted = fakeAccount("wb-restricted-0001", "restricted@example.com", "ACCOUNT_FORBIDDEN")
    const router = new AccountRouter({ registry: fakeRegistry([restricted]) })
    expect(router.select("ses_1", "hy4-preview")).toBeUndefined()
  })
})

describe("WorkBuddy desktop heal", () => {
  test("explicit desktop import refreshes the existing live vault account object and clears learned auth blocks", () => {
    const root = mkdtempSync(join(tmpdir(), "wb-import-live-"))
    const vaultRoot = join(root, "vault")
    const stateDir = join(root, "state")
    mkdirSync(stateDir, { recursive: true })
    const desktopInfo = join(root, "workbuddy-desktop-ai.info")
    const uid = "import-live-uid-0001"
    const vault = new AccountVault(vaultRoot)
    vault.save({
      path: join(vaultRoot, "seed.json"),
      accessToken: "STALE_VAULT_TOKEN",
      refreshToken: "STALE_REFRESH",
      domain: "www.workbuddy.ai",
      uid,
      enterpriseId: "",
      expiresAt: 0,
      nickname: "import@example.com",
      enrollmentEpoch: "epoch-import",
    })
    writeFileSync(
      desktopInfo,
      JSON.stringify({
        auth: {
          accessToken: "FRESH_DESKTOP_TOKEN",
          refreshToken: "FRESH_REFRESH",
          domain: "www.workbuddy.ai",
          expiresAt: Date.now() + 3_600_000,
        },
        account: { uid, enterpriseId: "", nickname: "import@example.com" },
      }),
    )

    const registry = new AccountRegistry({ authFiles: [desktopInfo], persistenceDir: stateDir, vault })
    const live = registry.all().find((account) => account.uid === uid)!
    live.governor.markAuthInvalid(401)
    expect(live.credential.accessToken).toBe("STALE_VAULT_TOKEN")
    expect(live.governor.metrics().state).toBe("AUTH_INVALID")

    const imported = registry.importCurrentDesktopAccount(desktopInfo)
    expect(imported).toBe(live)
    expect(imported.credential.accessToken).toBe("FRESH_DESKTOP_TOKEN")
    expect(imported.credential.refreshToken).toBe("FRESH_REFRESH")
    expect(imported.governor.metrics().state).toBe("READY")
    expect(vault.list().find((credential) => credential.uid === uid)?.accessToken).toBe("FRESH_DESKTOP_TOKEN")
  })

  test("a fresher desktop token heals the same vault identity only", () => {
    const root = mkdtempSync(join(tmpdir(), "wb-heal-"))
    const vaultRoot = join(root, "vault")
    const stateDir = join(root, "state")
    mkdirSync(stateDir, { recursive: true })
    const desktopInfo = join(root, "workbuddy-desktop-ai.info")

    const vault = new AccountVault(vaultRoot)
    const uid = "heal-uid-0001"
    vault.save({
      path: join(vaultRoot, "seed.json"),
      accessToken: "STALE_VAULT_TOKEN",
      refreshToken: "refresh",
      domain: "www.workbuddy.ai",
      uid,
      enterpriseId: "",
      expiresAt: 0,
      nickname: "heal@example.com",
    })
    writeFileSync(
      desktopInfo,
      JSON.stringify({
        auth: {
          accessToken: "FRESH_DESKTOP_TOKEN",
          refreshToken: "refresh",
          domain: "www.workbuddy.ai",
          expiresAt: 0,
        },
        account: { uid, enterpriseId: "", nickname: "heal@example.com" },
      }),
    )

    const registry = new AccountRegistry({ authFiles: [desktopInfo], persistenceDir: stateDir, vault })
    const account = registry.all().find((a) => a.uid === uid)!
    expect(account.credential.accessToken).toBe("STALE_VAULT_TOKEN")
    expect(registry.tryHealFromDesktop(account)).toBe(true)
    expect(account.credential.accessToken).toBe("FRESH_DESKTOP_TOKEN")
    // A second call is a no-op: tokens already match.
    expect(registry.tryHealFromDesktop(account)).toBe(false)
  })

  test("a different desktop identity never heals", () => {
    const root = mkdtempSync(join(tmpdir(), "wb-noheal-"))
    const vaultRoot = join(root, "vault")
    const stateDir = join(root, "state")
    mkdirSync(stateDir, { recursive: true })
    const desktopInfo = join(root, "workbuddy-desktop-ai.info")

    const vault = new AccountVault(vaultRoot)
    vault.save({
      path: join(vaultRoot, "seed.json"),
      accessToken: "VAULT_TOKEN",
      refreshToken: "refresh",
      domain: "www.workbuddy.ai",
      uid: "vault-uid-1",
      enterpriseId: "",
      expiresAt: 0,
      nickname: "vault@example.com",
    })
    writeFileSync(
      desktopInfo,
      JSON.stringify({
        auth: { accessToken: "OTHER_TOKEN", refreshToken: "r", domain: "www.workbuddy.ai", expiresAt: 0 },
        account: { uid: "other-uid-2", enterpriseId: "", nickname: "other@example.com" },
      }),
    )

    const registry = new AccountRegistry({ authFiles: [desktopInfo], persistenceDir: stateDir, vault })
    // discover() additively imports the new desktop identity alongside the vault one.
    const vaultAccount = registry.all().find((a) => a.uid === "vault-uid-1")!
    expect(registry.tryHealFromDesktop(vaultAccount)).toBe(false)
    expect(vaultAccount.credential.accessToken).toBe("VAULT_TOKEN")
  })
})
