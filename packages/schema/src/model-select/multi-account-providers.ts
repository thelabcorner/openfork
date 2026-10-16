import type { AccountModelProvider } from "../model-account-identity"

export type AutoPolicy = "sticky" | "headroom" | "spread"

export type MultiAccountProvider = AccountModelProvider & {
  accountsField: "workbuddyAccounts" | "zenAccounts"
  aliasMarkers: readonly string[]
  policies: readonly AutoPolicy[]
  headroomKind: "credits" | "window"
}

export const MULTI_ACCOUNT_PROVIDERS = {
  workbuddy: {
    id: "workbuddy",
    accountPrefix: "wb-",
    accountsField: "workbuddyAccounts",
    aliasMarkers: ["#ctx-"],
    policies: ["sticky"],
    headroomKind: "credits",
  },
  opencode: {
    id: "opencode",
    accountPrefix: "zen-",
    accountsField: "zenAccounts",
    aliasMarkers: [],
    policies: ["sticky"],
    headroomKind: "window",
  },
  "opencode-go": {
    id: "opencode-go",
    accountPrefix: "zen-",
    accountsField: "zenAccounts",
    aliasMarkers: [],
    policies: ["sticky"],
    headroomKind: "window",
  },
} as const satisfies Record<string, MultiAccountProvider>

export type MultiAccountProviderRegistry = Readonly<Record<string, MultiAccountProvider>>

export function multiAccountProvider(id: string, registry: MultiAccountProviderRegistry = MULTI_ACCOUNT_PROVIDERS) {
  return registry[id]
}

export function isMultiAccountProvider(id: string, registry: MultiAccountProviderRegistry = MULTI_ACCOUNT_PROVIDERS): boolean {
  return multiAccountProvider(id, registry) !== undefined
}
