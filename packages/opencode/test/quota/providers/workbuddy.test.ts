import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { Effect } from "effect"
import { AccountVault } from "@/plugin/workbuddy-accounts"
import { setTestAccountStore } from "@/plugin/workbuddy"
import { workbuddy, type WorkBuddyFetch } from "@/quota/providers/workbuddy"
import { createSingleFlight } from "@/quota/registry"

// `workBuddyLimitSnapshot()` (folded into every fetch() result as
// `workbuddyAccounts`) reads the plugin's module-level account registry, not
// the `AccountVault(root)` these tests construct directly — without pointing
// it at the same temp root, these tests would read whatever real WorkBuddy
// accounts happen to be enrolled on the machine running them.
function withVault(run: (root: string) => Promise<void> | void) {
  const root = mkdtempSync(join(tmpdir(), "wb-quota-test-"))
  setTestAccountStore(root)
  return Promise.resolve(run(root)).finally(() => rmSync(root, { recursive: true, force: true }))
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

describe("quota/providers/workbuddy", () => {
  test("not configured when the vault is empty", () =>
    withVault(async (root) => {
      const adapter = workbuddy(async () => jsonResponse({}), root)
      expect(await Effect.runPromise(adapter.configured())).toBe(false)
      const result = await Effect.runPromise(adapter.fetch())
      expect(result.ok).toBe(false)
      expect(result.configured).toBe(false)
    }))

  test("normalizes base/gift/extra packages into per-account windows", () =>
    withVault(async (root) => {
      const vault = new AccountVault(root)
      vault.save({
        path: "",
        accessToken: "token-a",
        refreshToken: "refresh-a",
        domain: "www.workbuddy.ai",
        uid: "uid-a",
        enterpriseId: "ent-a",
        expiresAt: Date.now() + 3_600_000,
        nickname: "Account A",
      })

      const fetchImpl: WorkBuddyFetch = async (url) => {
        if (String(url).includes("get-user-resource")) {
          return jsonResponse({
            code: 0,
            data: {
              Response: {
                ResourcePackageSet: [
                  { PackageCode: "p_free_base", PackageName: "Basic dosage", CapacitySizePrecise: 100, CapacityRemainPrecise: 100, Status: 0 },
                  {
                    PackageCode: "p_gift_activity",
                    PackageName: "Gift Pack",
                    CapacitySizePrecise: 250,
                    CapacityRemainPrecise: 250,
                    Status: 0,
                    ExpiredTime: "2026-09-13 16:36:36",
                  },
                ],
              },
            },
          })
        }
        if (String(url).includes("get-payment-type")) {
          return jsonResponse({ data: { paymentType: "free" } })
        }
        return jsonResponse({})
      }

      const adapter = workbuddy(fetchImpl, root)
      expect(await Effect.runPromise(adapter.configured())).toBe(true)
      const result = await Effect.runPromise(adapter.fetch())
      expect(result.ok).toBe(true)
      expect(result.planLabel).toBe("Free")
      const windows = result.usage?.windows ?? {}
      const base = windows["account:Account A:Basic"]
      expect(base?.usedPercent).toBe(0)
      expect(base?.valueLabel).toBe("0 / 100 pts (top-up value ~$3.00)")
      const gift = windows["account:Account A:Gift"]
      expect(gift?.usedPercent).toBe(0)
      expect(gift?.valueLabel).toBe("0 / 250 pts (top-up value ~$7.50)")
      expect(gift?.resetAt).not.toBeNull()
      const extra = windows["account:Account A:Extra"]
      expect(extra?.valueLabel).toBe("No extra packs available")
      expect(extra?.usedPercent).toBeNull()

      // Aggregate mirrors the single account's totals exactly.
      const aggBase = windows["aggregate:basic"]
      expect(aggBase?.usedPercent).toBe(0)
      expect(aggBase?.valueLabel).toBe("0 / 100 pts (top-up value ~$3.00)")
      const aggGift = windows["aggregate:gift"]
      expect(aggGift?.valueLabel).toBe("0 / 250 pts (top-up value ~$7.50)")
      const aggExtra = windows["aggregate:extra"]
      expect(aggExtra?.valueLabel).toBe("No extra packs available")
    }))

  test("sums a two-account aggregate and never gates on a per-account row", () =>
    withVault(async (root) => {
      const vault = new AccountVault(root)
      vault.save({
        path: "",
        accessToken: "token-full",
        refreshToken: "",
        domain: "www.workbuddy.ai",
        uid: "uid-full",
        enterpriseId: "",
        expiresAt: Date.now() + 3_600_000,
        nickname: "full@example.com",
      })
      vault.save({
        path: "",
        accessToken: "token-empty",
        refreshToken: "",
        domain: "www.workbuddy.ai",
        uid: "uid-empty",
        enterpriseId: "",
        expiresAt: Date.now() + 3_600_000,
        nickname: "empty@example.com",
      })

      const fetchImpl: WorkBuddyFetch = async (url, init) => {
        if (String(url).includes("get-user-resource")) {
          const isFull = String((init?.headers as Record<string, string>)?.["X-User-Id"]) === "uid-full"
          const remaining = isFull ? 100 : 0
          return jsonResponse({
            data: {
              Response: {
                ResourcePackageSet: [
                  { PackageCode: "p_free_base", PackageName: "Basic dosage", CapacitySizePrecise: 100, CapacityRemainPrecise: remaining, Status: 0 },
                ],
              },
            },
          })
        }
        return jsonResponse({})
      }

      const adapter = workbuddy(fetchImpl, root)
      const result = await Effect.runPromise(adapter.fetch())
      expect(result.ok).toBe(true)
      const windows = result.usage?.windows ?? {}
      // 200 total capacity, 100 remaining across both accounts -> 50% used.
      expect(windows["aggregate:basic"]?.usedPercent).toBe(50)
      // The exhausted account's own row is a distinct, non-gating key.
      expect(windows["account:empty@example.com:Basic"]?.usedPercent).toBe(100)
      expect(windows["account:full@example.com:Basic"]?.usedPercent).toBe(0)
    }))

  test("Basic exhausted but Gift full: Combined reflects the additive pool, not just Basic", () =>
    withVault(async (root) => {
      const vault = new AccountVault(root)
      vault.save({
        path: "",
        accessToken: "token-c",
        refreshToken: "",
        domain: "www.workbuddy.ai",
        uid: "uid-c",
        enterpriseId: "",
        expiresAt: Date.now() + 3_600_000,
        nickname: "thedabcorner@gmail.com",
      })

      const fetchImpl: WorkBuddyFetch = async (url) => {
        if (String(url).includes("get-user-resource")) {
          return jsonResponse({
            data: {
              Response: {
                ResourcePackageSet: [
                  // Basic is fully drained...
                  { PackageCode: "p_free_base", PackageName: "Basic dosage", CapacitySizePrecise: 100, CapacityRemainPrecise: 0, Status: 3 },
                  // ...but WorkBuddy credits are additive: Gift still has balance, so the
                  // account is NOT actually out of credits yet.
                  { PackageCode: "p_gift_activity", PackageName: "Gift Pack", CapacitySizePrecise: 300, CapacityRemainPrecise: 195, Status: 0 },
                ],
              },
            },
          })
        }
        return jsonResponse({})
      }

      const adapter = workbuddy(fetchImpl, root)
      const result = await Effect.runPromise(adapter.fetch())
      expect(result.ok).toBe(true)
      const windows = result.usage?.windows ?? {}

      // Basic alone reads as fully exhausted...
      expect(windows["account:thedabcorner@gmail.com:Basic"]?.usedPercent).toBe(100)
      // ...but Combined (205 used / 400 total across Basic+Gift = 51.25% used) shows
      // the account is roughly half spent, not fully exhausted, because it draws
      // from Gift next.
      expect(windows["account:thedabcorner@gmail.com:Combined"]?.usedPercent).toBeCloseTo(51.25)
      expect(windows["account:thedabcorner@gmail.com:Combined"]?.remainingPercent).toBeCloseTo(48.75)
      expect(windows["aggregate:combined"]?.usedPercent).toBeCloseTo(51.25)
    }))

  test("surfaces a re-auth error without throwing on a 401", () =>
    withVault(async (root) => {
      const vault = new AccountVault(root)
      vault.save({
        path: "",
        accessToken: "token-b",
        refreshToken: "",
        domain: "www.workbuddy.ai",
        uid: "uid-b",
        enterpriseId: "ent-b",
        expiresAt: Date.now() + 3_600_000,
        nickname: "Account B",
      })
      const fetchImpl: WorkBuddyFetch = async () => jsonResponse({}, 401)
      const adapter = workbuddy(fetchImpl, root)
      const result = await Effect.runPromise(adapter.fetch())
      expect(result.ok).toBe(false)
      expect(result.configured).toBe(true)
      expect(result.error).toMatch(/re-authenticate/i)
    }))

  test("a transient 5xx surfaces the upstream HTTP error verbatim, not a generic 'Request failed'", () =>
    withVault(async (root) => {
      const vault = new AccountVault(root)
      vault.save({
        path: "",
        accessToken: "token-5xx",
        refreshToken: "",
        domain: "www.workbuddy.ai",
        uid: "uid-5xx",
        enterpriseId: "",
        expiresAt: Date.now() + 3_600_000,
        nickname: "Account 5xx",
      })
      const fetchImpl: WorkBuddyFetch = async () => jsonResponse({ message: "upstream busy" }, 502)
      const adapter = workbuddy(fetchImpl, root)
      const result = await Effect.runPromise(adapter.fetch())
      expect(result.ok).toBe(false)
      expect(result.configured).toBe(true)
      // The end-user must see the real failure reason; "Request failed" is
      // a defect placeholder that hides what's actually wrong.
      expect(result.error).not.toBe("Request failed")
      expect(result.error).toBe("HTTP 502")
    }))
})
