import { describe, it, expect } from "bun:test"
import { accountLabels, AccountRouter, stableAccountIdentity, type WorkBuddyAccount } from "../workbuddy-accounts"
import { WorkBuddyEntitlementGovernor, type EntitlementState } from "../workbuddy-governor"
import type { AccountRegistry } from "../workbuddy-accounts"

function fakeAccount(
  id: string,
  nickname: string,
  opts?: { uid?: string; state?: EntitlementState; load?: number },
): WorkBuddyAccount {
  const state = opts?.state ?? "READY"
  const load = opts?.load ?? 0
  return {
    id,
    uid: opts?.uid ?? id,
    nickname,
    realm: "www.workbuddy.ai",
    authPath: `/tmp/${id}.json`,
    credential: {
      path: `/tmp/${id}.json`,
      accessToken: "access",
      refreshToken: "refresh",
      domain: "www.workbuddy.ai",
      uid: opts?.uid ?? id,
      enterpriseId: "",
      expiresAt: 0,
      nickname,
    },
    governor: {
      metrics: () => ({ state, active: load, queued: 0 }),
    } as unknown as WorkBuddyEntitlementGovernor,
    mtime: 0,
    source: "vault",
  }
}

function fakeRegistry(accounts: WorkBuddyAccount[]): AccountRegistry {
  return {
    all: () => accounts,
    get: (id: string) => accounts.find((account) => account.id === id),
  } as unknown as AccountRegistry
}

const MODEL = "hy4-preview"

describe("AccountRouter.select", () => {
  it("binds the session on the first automatic selection", () => {
    const a = fakeAccount("wb-aaa-0001", "a@example.com")
    const router = new AccountRouter({ registry: fakeRegistry([a]) })
    const selection = router.select("ses_1", MODEL)
    expect(selection?.account.id).toBe("wb-aaa-0001")
    expect(selection?.reason).toBe("automatic")
    expect(router.binding("ses_1")).toBe("wb-aaa-0001")
  })

  it("honours an explicit account selection on an unbound session", () => {
    const a = fakeAccount("wb-aaa-0001", "a@example.com")
    const b = fakeAccount("wb-bbb-0002", "b@example.com")
    const router = new AccountRouter({ registry: fakeRegistry([a, b]) })
    const selection = router.select("ses_1", MODEL, "wb-bbb-0002")
    expect(selection?.account.id).toBe("wb-bbb-0002")
    expect(selection?.reason).toBe("explicit")
  })

  // Regression: affinity used to be checked before the explicit account id, so
  // picking an account-qualified model (`hy4-preview@wb-bbb-0002`) in a session
  // already bound to A silently kept serving A — including A's rate limit.
  it("explicit selection rebinds an already-bound session", () => {
    const a = fakeAccount("wb-aaa-0001", "a@example.com")
    const b = fakeAccount("wb-bbb-0002", "b@example.com")
    const router = new AccountRouter({ registry: fakeRegistry([a, b]) })

    router.bind("ses_1", a.id)
    expect(router.select("ses_1", MODEL)?.account.id).toBe("wb-aaa-0001")

    const switched = router.select("ses_1", MODEL, "wb-bbb-0002")
    expect(switched?.account.id).toBe("wb-bbb-0002")
    expect(switched?.reason).toBe("explicit")
    expect(router.binding("ses_1")).toBe("wb-bbb-0002")
  })

  it("keeps the rebound account for later unqualified requests", () => {
    const a = fakeAccount("wb-aaa-0001", "a@example.com")
    const b = fakeAccount("wb-bbb-0002", "b@example.com")
    const router = new AccountRouter({ registry: fakeRegistry([a, b]) })

    router.bind("ses_1", a.id)
    router.select("ses_1", MODEL, b.id)

    // The plain (non account-qualified) model id must now resolve to B.
    const followUp = router.select("ses_1", MODEL)
    expect(followUp?.account.id).toBe("wb-bbb-0002")
    expect(followUp?.reason).toBe("affinity")
  })

  it("can switch back to the original account", () => {
    const a = fakeAccount("wb-aaa-0001", "a@example.com")
    const b = fakeAccount("wb-bbb-0002", "b@example.com")
    const router = new AccountRouter({ registry: fakeRegistry([a, b]) })

    router.bind("ses_1", a.id)
    router.select("ses_1", MODEL, b.id)
    const back = router.select("ses_1", MODEL, a.id)
    expect(back?.account.id).toBe("wb-aaa-0001")
    expect(router.binding("ses_1")).toBe("wb-aaa-0001")
  })

  it("does not let automatic routing override an existing binding", () => {
    const healthy = fakeAccount("wb-aaa-0001", "a@example.com", { state: "READY" })
    const limited = fakeAccount("wb-zzz-0009", "z@example.com", { state: "WINDOW_LIMITED" })
    const router = new AccountRouter({ registry: fakeRegistry([healthy, limited]) })

    // Automatic selection alone would prefer the healthy account.
    expect(router.select("ses_2", MODEL)?.account.id).toBe("wb-aaa-0001")

    // But a session already pinned to the limited account must not silently
    // drift to another one — that is the account hopping affinity prevents.
    router.bind("ses_1", limited.id)
    const pinned = router.select("ses_1", MODEL)
    expect(pinned?.account.id).toBe("wb-zzz-0009")
    expect(pinned?.reason).toBe("affinity")
  })

  it("lets an explicit selection land on a rate-limited account", () => {
    const ready = fakeAccount("wb-aaa-0001", "a@example.com", { state: "READY" })
    const limited = fakeAccount("wb-zzz-0009", "z@example.com", { state: "WINDOW_LIMITED" })
    const router = new AccountRouter({ registry: fakeRegistry([ready, limited]) })

    router.bind("ses_1", ready.id)
    // The user picked the limited account on purpose; the governor owns the
    // rejection, the router must not silently substitute a different account.
    const selection = router.select("ses_1", MODEL, limited.id)
    expect(selection?.account.id).toBe("wb-zzz-0009")
    expect(selection?.reason).toBe("explicit")
  })

  it("returns undefined for an unknown explicit account id", () => {
    const a = fakeAccount("wb-aaa-0001", "a@example.com")
    const router = new AccountRouter({ registry: fakeRegistry([a]) })
    expect(router.select("ses_1", MODEL, "wb-nope-9999")).toBeUndefined()
    expect(router.binding("ses_1")).toBeUndefined()
  })

  it("keeps bindings independent per session", () => {
    const a = fakeAccount("wb-aaa-0001", "a@example.com")
    const b = fakeAccount("wb-bbb-0002", "b@example.com")
    const router = new AccountRouter({ registry: fakeRegistry([a, b]) })

    router.bind("ses_1", a.id)
    router.bind("ses_2", b.id)
    router.select("ses_1", MODEL, b.id)

    expect(router.binding("ses_1")).toBe("wb-bbb-0002")
    expect(router.binding("ses_2")).toBe("wb-bbb-0002")
  })
})

describe("accountLabels", () => {
  it("prefers the nickname, which is usually the account email", () => {
    const labels = accountLabels([
      fakeAccount("wb-aaa-0001", "thedabcorner@gmail.com"),
      fakeAccount("wb-bbb-0002", "thelabcorner"),
    ])
    expect(labels.get("wb-aaa-0001")).toBe("thedabcorner@gmail.com")
    expect(labels.get("wb-bbb-0002")).toBe("thelabcorner")
  })

  it("falls back to the uid when the nickname is blank", () => {
    const labels = accountLabels([fakeAccount("wb-aaa-0001", "   ", { uid: "uid-1234" })])
    expect(labels.get("wb-aaa-0001")).toBe("uid-1234")
  })

  it("falls back to the account id when nickname and uid are both blank", () => {
    const labels = accountLabels([fakeAccount("wb-aaa-0001", "", { uid: "" })])
    expect(labels.get("wb-aaa-0001")).toBe("wb-aaa-0001")
  })

  it("disambiguates duplicate nicknames with a short id tail", () => {
    const labels = accountLabels([
      fakeAccount("wb-aaa-0001", "same@example.com"),
      fakeAccount("wb-bbb-0002", "same@example.com"),
    ])
    expect(labels.get("wb-aaa-0001")).toBe("same@example.com #0001")
    expect(labels.get("wb-bbb-0002")).toBe("same@example.com #0002")
  })

  it("does not append a tail when nicknames are unique", () => {
    const labels = accountLabels([
      fakeAccount("wb-aaa-0001", "one@example.com"),
      fakeAccount("wb-bbb-0002", "two@example.com"),
    ])
    expect(labels.get("wb-aaa-0001")).toBe("one@example.com")
    expect(labels.get("wb-bbb-0002")).toBe("two@example.com")
  })
})

describe("stableAccountIdentity", () => {
  it("is stable across nickname edits", () => {
    const base = {
      path: "/tmp/workbuddy-desktop-ai.info",
      accessToken: "a",
      refreshToken: "r",
      domain: "www.workbuddy.ai",
      uid: "215789ee-59bf-4d13-a45b",
      enterpriseId: "",
      expiresAt: 0,
      nickname: "old@example.com",
    }
    const renamed = { ...base, nickname: "new@example.com" }
    expect(stableAccountIdentity(renamed)).toBe(stableAccountIdentity(base))
  })
})
