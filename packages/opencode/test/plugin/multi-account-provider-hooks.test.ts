import { afterEach, describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { MULTI_ACCOUNT_PROVIDERS } from "@opencode-ai/schema/model-select/multi-account-providers"
import { WorkBuddyPlugin } from "@/plugin/workbuddy"
import { VerdentPlugin } from "@/plugin/verdent"
import { ZenGoPlugin, ZenPlugin, resetZenPoolForTest, setTestZenVaultCredentials } from "@/plugin/zen"

const input = { serverUrl: new URL("http://127.0.0.1:1") } as PluginInput

afterEach(() => {
  setTestZenVaultCredentials(undefined)
  resetZenPoolForTest()
})

describe("multi-account provider hook coverage", () => {
  test("every registered built-in multi-account provider publishes a first-class account roster", async () => {
    setTestZenVaultCredentials([])

    const hooks = await Promise.all([
      WorkBuddyPlugin(input),
      VerdentPlugin(input),
      ZenPlugin(input),
      ZenGoPlugin(input),
    ])
    const providers = Object.fromEntries(
      hooks.map((hook) => [hook.provider!.id, hook.provider!]),
    )

    expect(Object.keys(providers).sort()).toEqual(
      Object.keys(MULTI_ACCOUNT_PROVIDERS).sort(),
    )
    for (const providerID of Object.keys(MULTI_ACCOUNT_PROVIDERS)) {
      expect(typeof providers[providerID]?.accounts).toBe("function")
    }
  })
})
