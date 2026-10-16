import { describe, expect, test } from "bun:test"
import { isRollingQuotaOption, resetOptions, subscriptionKey, withSubscription } from "./telegram-model"

const now = Date.UTC(2026, 9, 10)
const agenda = {
  occurrences: [
    {
      providerId: "opencode-go", providerName: "OpenCode Go", scope: "account" as const,
      accountId: "account-A", accountLabel: "A", resetAt: now + 1000, observedAt: now - 1000,
      windows: [{ key: "weekly", source: "provider" as const }],
    },
    {
      providerId: "opencode-go", providerName: "OpenCode Go", scope: "account" as const,
      accountId: "account-B", accountLabel: "B", resetAt: now + 1000, observedAt: now - 1000,
      windows: [{ key: "weekly", source: "provider" as const }],
    },
  ],
}

describe("Telegram quota selection presentation", () => {
  test("identifies only OpenCode Go 5h as rolling, preserving fixed-window semantics", () => {
    expect(isRollingQuotaOption({ providerId: "opencode-go", windowKey: "5h" })).toBe(true)
    expect(isRollingQuotaOption({ providerId: "opencode-go", windowKey: "week" })).toBe(false)
    expect(isRollingQuotaOption({ providerId: "another-provider", windowKey: "5h" })).toBe(false)
  })

  test("keeps a rolling 5h selection when the moving reset estimate falls outside the fixed-deadline range", () => {
    const rolling = {
      providerId: "opencode-go", providerName: "OpenCode Go",
      scope: "account" as const, accountId: "account-A", accountLabel: "A",
      resetAt: now - 60_000, observedAt: now,
      windows: [
        { key: "5h", source: "provider" as const },
        { key: "week", source: "provider" as const },
      ],
    }
    const options = resetOptions({ occurrences: [rolling] }, [], now)
    expect(options.map((o) => o.windowKey)).toEqual(["5h"])
  })

  test("keeps otherwise identical windows isolated by account", () => {
    const options = resetOptions(agenda, [], now)
    expect(options).toHaveLength(2)
    expect(options[0]!.id).not.toBe(options[1]!.id)
    const selected = withSubscription([], options[0]!, true)
    expect(resetOptions(agenda, selected, now).filter((o) => o.enabled)).toHaveLength(1)
  })

  test("filters unidentifiable account resets and expired/resetless windows", () => {
    const result = resetOptions({ occurrences: [
      { ...agenda.occurrences[0]!, accountId: undefined },
      { ...agenda.occurrences[1]!, resetAt: now - 10 },
    ] }, [], now)
    expect(result).toHaveLength(0)
  })

  test("deduplicates projections and preserves disabled selection", () => {
    const id = subscriptionKey(agenda.occurrences[0]!.windows.map((window) => ({
      providerId: "opencode-go", scope: "account" as const, accountId: "account-A", windowKey: window.key,
    }))[0]!)
    const selected = withSubscription([], { providerId: "opencode-go", scope: "account", accountId: "account-A", windowKey: "weekly" }, false)
    expect(subscriptionKey(selected[0]!)).toBe(id)
    expect(resetOptions({ occurrences: [agenda.occurrences[0]!, agenda.occurrences[0]!] }, selected, now)).toHaveLength(1)
    expect(resetOptions(agenda, selected, now)[0]!.enabled).toBe(false)
  })
})
