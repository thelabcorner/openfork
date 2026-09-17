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
