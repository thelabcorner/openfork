import { describe, expect, test } from "bun:test"
import {
  ProviderAccountPolicy,
  type Candidate,
  type CandidateStats,
  type SelectInput,
} from "@opencode-ai/core/provider-account-policy"

const providerID = "opencode"
const affinityDomain = "opencode-hosted"

const candidate = (
  credentialHandle: string,
  overrides: Partial<Candidate> = {},
): Candidate => ({
  providerID,
  accountID: `acct-${credentialHandle}`,
  credentialHandle,
  admissible: true,
  healthRank: 0,
  ...overrides,
})

const stats = (
  activeBindings = 0,
  assignmentCount = 0,
  lastAssignedAt?: number,
): CandidateStats => ({
  activeBindings,
  assignmentCount,
  ...(lastAssignedAt === undefined ? {} : { lastAssignedAt }),
})

const select = (overrides: Partial<SelectInput> = {}) =>
  ProviderAccountPolicy.select({
    providerID,
    affinityDomain,
    mode: "concentrate",
    candidates: [],
    ...overrides,
  })

const selectedHandle = (result: ProviderAccountPolicy.Result) => {
  expect(result.ok).toBe(true)
  if (!result.ok) throw result.error
  return result.selection.selected?.credentialHandle
}

describe("ProviderAccountPolicy concentrate", () => {
  test("preserves donor concentration semantics by preferring an already-used account", () => {
    const unused = candidate("cred-a", { healthRank: 0, usedPercent: 99 })
    const used = candidate("cred-b", { healthRank: 50, usedPercent: 1 })
    const result = select({
      candidates: [unused, used],
      stats: new Map([
        ["cred-a", stats(0, 0)],
        ["cred-b", stats(1, 1)],
      ]),
    })

    expect(selectedHandle(result)).toBe("cred-b")
  })

  test("uses provider-supplied health rank without interpreting entitlement state", () => {
    const result = select({
      candidates: [
        candidate("cred-worse", { healthRank: 9 }),
        candidate("cred-better", { healthRank: 2 }),
      ],
    })

    expect(selectedHandle(result)).toBe("cred-better")
  })

  test("prefers a defined higher utilization after used/health ties", () => {
    const first = select({
      candidates: [
        candidate("cred-undefined"),
        candidate("cred-low", { usedPercent: 20 }),
      ],
    })
    expect(selectedHandle(first)).toBe("cred-low")

    const second = select({
      candidates: [
        candidate("cred-low", { usedPercent: 20 }),
        candidate("cred-high", { usedPercent: 88 }),
      ],
    })
    expect(selectedHandle(second)).toBe("cred-high")

    const clamped = select({
      candidates: [
        candidate("cred-over", { usedPercent: 500 }),
        candidate("cred-normal", { usedPercent: 99 }),
      ],
    })
    expect(selectedHandle(clamped)).toBe("cred-over")
  })

  test("uses assignment count, then reset time, active bindings, and recent assignment as donor tie-breaks", () => {
    const assignments = select({
      candidates: [candidate("cred-a"), candidate("cred-b")],
      stats: new Map([
        ["cred-a", stats(0, 2)],
        ["cred-b", stats(0, 4)],
      ]),
    })
    expect(selectedHandle(assignments)).toBe("cred-b")

    const reset = select({
      candidates: [
        candidate("cred-a", { resetAt: 50 }),
        candidate("cred-b", { resetAt: 100 }),
      ],
      stats: new Map([
        ["cred-a", stats(0, 1)],
        ["cred-b", stats(0, 1)],
      ]),
    })
    expect(selectedHandle(reset)).toBe("cred-a")

    const active = select({
      candidates: [candidate("cred-a"), candidate("cred-b")],
      stats: new Map([
        ["cred-a", stats(5, 1)],
        ["cred-b", stats(2, 1)],
      ]),
    })
    expect(selectedHandle(active)).toBe("cred-a")

    const recent = select({
      candidates: [candidate("cred-a"), candidate("cred-b")],
      stats: new Map([
        ["cred-a", stats(1, 1, 500)],
        ["cred-b", stats(1, 1, 100)],
      ]),
    })
    expect(selectedHandle(recent)).toBe("cred-a")
  })

  test("has a stable lexical final tie-break independent of caller ordering", () => {
    const a = candidate("cred-a")
    const b = candidate("cred-b")
    const forward = select({ candidates: [b, a] })
    const reverse = select({ candidates: [a, b] })

    expect(selectedHandle(forward)).toBe("cred-a")
    expect(selectedHandle(reverse)).toBe("cred-a")
  })
})

describe("ProviderAccountPolicy session-round-robin", () => {
  test("uses stable handle ordering and advances after the durable cursor", () => {
    const result = select({
      mode: "session-round-robin",
      candidates: [candidate("cred-c"), candidate("cred-a"), candidate("cred-b")],
      cursor: { epoch: 7, lastAssignedHandle: "cred-a" },
    })

    expect(selectedHandle(result)).toBe("cred-b")
    if (!result.ok) throw result.error
    expect(result.selection.assignmentEpoch).toBe(8)
    expect(result.selection.nextCursor).toEqual({
      epoch: 8,
      lastAssignedHandle: "cred-b",
    })
  })

  test("wraps around the ring and is independent of input ordering", () => {
    const candidates = [candidate("cred-a"), candidate("cred-b"), candidate("cred-c")]
    const first = select({
      mode: "session-round-robin",
      candidates: [...candidates].reverse(),
      cursor: { epoch: 3, lastAssignedHandle: "cred-c" },
    })
    const second = select({
      mode: "session-round-robin",
      candidates,
      cursor: { epoch: 3, lastAssignedHandle: "cred-c" },
    })

    expect(selectedHandle(first)).toBe("cred-a")
    expect(selectedHandle(second)).toBe("cred-a")
  })

  test("failover advances from and excludes the failed handle even before health catches up", () => {
    const result = select({
      mode: "session-round-robin",
      candidates: [candidate("cred-a"), candidate("cred-b"), candidate("cred-c")],
      cursor: { epoch: 12, lastAssignedHandle: "cred-c" },
      afterCredentialHandle: "cred-a",
      excludedCredentialHandles: new Set(["cred-a"]),
    })

    expect(selectedHandle(result)).toBe("cred-b")
    if (!result.ok) throw result.error
    expect(result.selection.rejected).toContainEqual({
      providerID,
      accountID: "acct-cred-a",
      credentialHandle: "cred-a",
      reason: "excluded",
    })
    expect(result.selection.nextCursor).toEqual({
      epoch: 13,
      lastAssignedHandle: "cred-b",
    })
  })

  test("walks past ineligible and capacity-blocked ring members", () => {
    const result = select({
      mode: "session-round-robin",
      candidates: [
        candidate("cred-a", {
          admissible: false,
          ineligibleReason: "quota-exhausted",
        }),
        candidate("cred-b", { maxSessionBindings: 1 }),
        candidate("cred-c"),
      ],
      stats: new Map([["cred-b", stats(1, 0)]]),
      cursor: { epoch: 4, lastAssignedHandle: "cred-c" },
    })

    expect(selectedHandle(result)).toBe("cred-c")
    if (!result.ok) throw result.error
    expect(result.selection.rejected).toEqual([
      {
        providerID,
        accountID: "acct-cred-a",
        credentialHandle: "cred-a",
        reason: "provider-ineligible",
        ineligibleReason: "quota-exhausted",
      },
      {
        providerID,
        accountID: "acct-cred-b",
        credentialHandle: "cred-b",
        reason: "capacity",
      },
    ])
  })
})

describe("ProviderAccountPolicy eligibility and safety", () => {
  test("preserves provider ineligibility reason rather than collapsing it into auth failure", () => {
    const result = select({
      candidates: [
        candidate("cred-forbidden", {
          admissible: false,
          ineligibleReason: "account-forbidden",
        }),
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw result.error
    expect(result.selection.selected).toBeUndefined()
    expect(result.selection.rejected).toEqual([
      {
        providerID,
        accountID: "acct-cred-forbidden",
        credentialHandle: "cred-forbidden",
        reason: "provider-ineligible",
        ineligibleReason: "account-forbidden",
      },
    ])
  })

  test("filters cross-provider candidates and reports the mismatch without ranking them", () => {
    const foreign = candidate("cred-foreign", {
      providerID: "other-provider",
      accountID: "acct-foreign",
      healthRank: 0,
      usedPercent: 100,
    })
    const local = candidate("cred-local", { healthRank: 100 })
    const result = select({ candidates: [foreign, local] })

    expect(selectedHandle(result)).toBe("cred-local")
    if (!result.ok) throw result.error
    expect(result.selection.rejected).toContainEqual({
      providerID: "other-provider",
      accountID: "acct-foreign",
      credentialHandle: "cred-foreign",
      reason: "provider-mismatch",
    })
  })

  test("enforces max-session capacity from caller-supplied durable counts", () => {
    const full = candidate("cred-full", {
      maxSessionBindings: 2,
      usedPercent: 100,
    })
    const available = candidate("cred-open", { maxSessionBindings: 2 })
    const result = select({
      candidates: [full, available],
      stats: new Map([
        ["cred-full", stats(2, 10)],
        ["cred-open", stats(1, 0)],
      ]),
    })

    expect(selectedHandle(result)).toBe("cred-open")
    if (!result.ok) throw result.error
    expect(result.selection.rejected).toContainEqual({
      providerID,
      accountID: "acct-cred-full",
      credentialHandle: "cred-full",
      reason: "capacity",
    })
  })

  test("returns no assignment transition when nothing is eligible", () => {
    const cursor = { epoch: 9, lastAssignedHandle: "cred-old" } as const
    const result = select({
      candidates: [
        candidate("cred-a", {
          admissible: false,
          ineligibleReason: "disabled",
        }),
      ],
      cursor,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw result.error
    expect(result.selection.selected).toBeUndefined()
    expect(result.selection.assignmentEpoch).toBeUndefined()
    expect(result.selection.nextCursor).toBeUndefined()
    expect(cursor).toEqual({ epoch: 9, lastAssignedHandle: "cred-old" })
  })

  test("proposes exactly one epoch advance and never mutates candidates, stats, cursor, or exclusions", () => {
    const candidates = [candidate("cred-a"), candidate("cred-b")] as const
    const statsMap = new Map([
      ["cred-a", stats(0, 0)],
      ["cred-b", stats(0, 0)],
    ])
    const cursor = { epoch: 21, lastAssignedHandle: "cred-a" } as const
    const excluded = new Set<string>()
    const beforeCandidates = structuredClone(candidates)
    const beforeStats = structuredClone([...statsMap.entries()])

    const result = select({
      mode: "session-round-robin",
      candidates,
      stats: statsMap,
      cursor,
      excludedCredentialHandles: excluded,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw result.error
    expect(result.selection.assignmentEpoch).toBe(22)
    expect(result.selection.nextCursor?.epoch).toBe(22)
    expect(candidates).toEqual(beforeCandidates)
    expect([...statsMap.entries()]).toEqual(beforeStats)
    expect(cursor).toEqual({ epoch: 21, lastAssignedHandle: "cred-a" })
    expect([...excluded]).toEqual([])
  })

  test("projects only safe selected identity even when an untyped caller supplies extra secret fields", () => {
    const unsafe = {
      ...candidate("cred-a"),
      access: "do-not-return-access",
      refresh: "do-not-return-refresh",
      authorization: "Bearer do-not-return",
      email: "private@example.test",
    } as Candidate
    const result = select({ candidates: [unsafe] })

    expect(result.ok).toBe(true)
    if (!result.ok) throw result.error
    expect(result.selection.selected).toEqual({
      providerID,
      accountID: "acct-cred-a",
      credentialHandle: "cred-a",
    })
    const serialized = JSON.stringify(result.selection)
    expect(serialized).not.toContain("do-not-return")
    expect(serialized).not.toContain("private@example.test")
  })

  test("rejects duplicate target-provider credential handles as ambiguous policy input", () => {
    const result = select({
      candidates: [
        candidate("cred-a", { accountID: "acct-a" }),
        candidate("cred-a", { accountID: "acct-b" }),
      ],
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error._tag).toBe("ProviderAccountPolicy.InvalidInput")
    expect(result.error.field).toBe("candidate.credentialHandle")
  })

  test("rejects malformed bounded policy state instead of producing a misleading selection", () => {
    const badHealth = select({
      candidates: [candidate("cred-a", { healthRank: Number.POSITIVE_INFINITY })],
    })
    expect(badHealth.ok).toBe(false)

    const badCursor = select({
      candidates: [candidate("cred-a")],
      cursor: { epoch: Number.MAX_SAFE_INTEGER },
    })
    expect(badCursor.ok).toBe(false)

    const badStats = select({
      candidates: [candidate("cred-a")],
      stats: new Map([["cred-a", stats(-1, 0)]]),
    })
    expect(badStats.ok).toBe(false)
  })
})
