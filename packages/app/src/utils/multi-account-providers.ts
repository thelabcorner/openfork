import type { AccountModelProvider } from "@opencode-ai/schema/model-account-identity"

export type AutoPolicy = "sticky" | "headroom" | "spread"

export type MultiAccountProvider = AccountModelProvider & {
  accountsField: "workbuddyAccounts" | "verdentAccounts" | "zenAccounts"
  aliasMarkers: readonly string[]
  policies: readonly AutoPolicy[]
  headroomKind: "credits" | "window"
  autoLabelKey: string
}

export const MULTI_ACCOUNT_PROVIDERS = {
  workbuddy: {
    id: "workbuddy",
    accountPrefix: "wb-",
    accountsField: "workbuddyAccounts",
    aliasMarkers: ["#ctx-"],
    policies: ["sticky"],
    headroomKind: "credits",
    autoLabelKey: "dialog.model.account.auto",
  },
  verdent: {
    id: "verdent",
    accountPrefix: "vd-",
    accountsField: "verdentAccounts",
    aliasMarkers: [],
    policies: ["sticky"],
    headroomKind: "window",
    autoLabelKey: "dialog.model.account.auto",
  },
  opencode: {
    id: "opencode",
    accountPrefix: "zen-",
    accountsField: "zenAccounts",
    aliasMarkers: [],
    policies: ["sticky"],
    headroomKind: "window",
    autoLabelKey: "dialog.model.account.auto",
  },
  "opencode-go": {
    id: "opencode-go",
    accountPrefix: "zen-",
    accountsField: "zenAccounts",
    aliasMarkers: [],
    policies: ["sticky"],
    headroomKind: "window",
    autoLabelKey: "dialog.model.account.auto",
  },
} as const satisfies Record<string, MultiAccountProvider>

export type MultiAccountProviderRegistry = Readonly<Record<string, MultiAccountProvider>>

export function multiAccountProvider(id: string, registry: MultiAccountProviderRegistry = MULTI_ACCOUNT_PROVIDERS) {
  return registry[id]
}

export function isMultiAccountProvider(id: string, registry: MultiAccountProviderRegistry = MULTI_ACCOUNT_PROVIDERS): boolean {
  return multiAccountProvider(id, registry) !== undefined
}
