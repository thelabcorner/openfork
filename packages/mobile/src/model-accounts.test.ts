import { describe, expect, test } from "bun:test"

import { collectAccountLabels, synthesizeAccounts, usageForAccount } from "./model-accounts"
import type { LimitsProviderData } from "./views/LimitsView"

/**
 * The account picker is driven entirely by the quota payload, so these cover
 * the reading of that payload: which accounts are offered, what they are
 * called, and whose headroom is shown next to them.
 */

const provider = (providerId: string, usage: unknown): LimitsProviderData =>
  ({ result: { providerId, providerName: providerId, ok: true, configured: true, usage, fetchedAt: 0 } }) as never

const workbuddy = (accounts: unknown[]) => provider("workbuddy", { workbuddyAccounts: accounts })

describe("collectAccountLabels", () => {
  test("prefers quota's live labels over anything cached in the catalog", () => {
    const labels = collectAccountLabels([
      workbuddy([{ accountId: "wb-1", label: "work@example.com" }]),
      provider("opencode", { zenAccounts: [{ keyId: "zen-9", label: "Personal key" }] }),
    ])
    expect(labels.get("wb-1")).toBe("work@example.com")
    // Zen keys are identified by `keyId`, not `accountId`.
    expect(labels.get("zen-9")).toBe("Personal key")
  })

  test("ignores entries with no usable label", () => {
    expect(collectAccountLabels([workbuddy([{ accountId: "wb-1", label: "" }, { accountId: "wb-2" }])]).size).toBe(0)
  })
})

describe("synthesizeAccounts", () => {
  test("offers accounts the catalog has not enrolled yet", () => {
    // A key added after the provider catalog was cached has no model variant of
    // its own, so without this the picker would show a single Auto row and the
    // new account would be unreachable.
    const roster = synthesizeAccounts("workbuddy", [
      workbuddy([{ accountId: "wb-1", label: "A" }, { accountId: "wb-2", label: "B" }]),
    ])
    expect(roster.map((entry) => entry.accountId)).toEqual(["wb-1", "wb-2"])
  })

  test("reads opencode and opencode-go from the shared Zen key pool", () => {
    const providers = [provider("opencode", { zenAccounts: [{ keyId: "zen-1", label: "Env key" }] })]
    expect(synthesizeAccounts("opencode", providers)).toEqual([{ accountId: "zen-1", label: "Env key" }])
    expect(synthesizeAccounts("opencode-go", providers)).toEqual([{ accountId: "zen-1", label: "Env key" }])
  })

  test("returns nothing for a provider with no account concept", () => {
    expect(synthesizeAccounts("anthropic", [workbuddy([{ accountId: "wb-1", label: "A" }])])).toEqual([])
  })
})

describe("usageForAccount", () => {
  const providers = [
    workbuddy([
      {
        accountId: "wb-1",
        label: "A",
        models: [
          { model: "claude-opus", canonical: "claude-opus", remainingPercent: 4, remainingEstimate: 2, exhausted: true },
          { model: "claude-haiku", canonical: "claude-haiku", remainingPercent: 91, remainingEstimate: 800 },
        ],
      },
    ]),
  ]

  test("reports the headroom of the model being picked, not the account's worst", () => {
    // The account's expensive model is nearly depleted. A cheap model behind it
    // still has plenty, and saying otherwise would steer the user away from a
    // model they can happily run.
    const resolve = usageForAccount("workbuddy", providers, new Map(), "claude-haiku")
    const usage = resolve("wb-1")
    expect(usage?.remainingPercent).toBe(91)
    expect(usage?.estimatedRequests).toBe(800)
    expect(usage?.creditsExhausted).toBe(false)
    expect(usage?.accountWide).toBeUndefined()
  })

  test("still reports the exhausted model as exhausted", () => {
    const usage = usageForAccount("workbuddy", providers, new Map(), "claude-opus")("wb-1")
    expect(usage?.remainingPercent).toBe(4)
    expect(usage?.creditsExhausted).toBe(true)
  })

  test("matches a catalog id against the quota row's shorter name", () => {
    // The picker holds `anthropic/claude-haiku`; quota reports `claude-haiku`.
    const usage = usageForAccount("workbuddy", providers, new Map(), "anthropic/claude-haiku")("wb-1")
    expect(usage?.remainingPercent).toBe(91)
  })

  test("falls back to the whole account and says so when the model has no row", () => {
    const usage = usageForAccount("workbuddy", providers, new Map(), "some-unlisted-model")("wb-1")
    expect(usage?.accountWide).toBe(true)
    // Whole-account view takes the tightest of every model.
    expect(usage?.remainingPercent).toBe(4)
  })

  test("returns nothing for an account the quota payload does not mention", () => {
    expect(usageForAccount("workbuddy", providers, new Map(), "claude-haiku")("wb-missing")).toBeUndefined()
  })

  test("derives Zen key headroom from the observed/estimated counters", () => {
    const zen = [
      provider("opencode", {
        zenAccounts: [
          { keyId: "zen-1", label: "Key", usedObserved: 30, limitEstimate: 100, remainingPercent: 70, exhausted: false },
        ],
      }),
    ]
    const usage = usageForAccount("opencode", zen, new Map())("zen-1")
    expect(usage?.estimatedRequests).toBe(70)
    expect(usage?.remainingPercent).toBe(70)
  })
})
