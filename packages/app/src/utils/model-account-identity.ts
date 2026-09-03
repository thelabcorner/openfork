import {
  baseModelID,
  isAccountQualified,
  joinAccountModelID,
  splitAccountModelID,
  type AccountModelParts,
} from "@opencode-ai/schema/model-account-identity"
import { MULTI_ACCOUNT_PROVIDERS, type MultiAccountProvider } from "./multi-account-providers"

export { baseModelID, isAccountQualified, joinAccountModelID, splitAccountModelID }
export type { AccountModelParts }

const providers = Object.values(MULTI_ACCOUNT_PROVIDERS)

export function splitMultiAccountModelID(modelID: string): AccountModelParts {
  return splitAccountModelID(modelID, providers)
}

export function splitModelIDForProvider(modelID: string, providerID: string): AccountModelParts {
  const provider = Object.values(MULTI_ACCOUNT_PROVIDERS).find((candidate) => candidate.id === providerID)
  return provider ? splitAccountModelID(modelID, [provider]) : { baseModelID: modelID }
}

export function accountShortLabel(label: string): string {
  const trimmed = label.trim()
  const at = trimmed.indexOf("@")
  return at > 0 ? trimmed.slice(0, at) : trimmed
}

export type ModelNameLike = { id: string; name: string; providerID?: string; provider?: { id?: string } }
export type AccountLabels = Readonly<Record<string, string>> | Map<string, string>

function labelsFor(labels: AccountLabels): string[] {
  return labels instanceof Map ? [...labels.values()] : Object.values(labels)
}

function labelForAccount(labels: AccountLabels, accountID: string): string | undefined {
  return labels instanceof Map ? labels.get(accountID) : labels[accountID]
}

function removeAccountLabel(name: string, label: string): string {
  const suffix = ` (${label})`
  if (name.endsWith(suffix)) return name.slice(0, -suffix.length)

  // WorkBuddy appends its context display after the account label. Remove the
  // exact known label while preserving the final context suffix.
  const contextSuffix = name.match(/\s+(\([^()]+\))$/)?.[0]
  if (!contextSuffix) return name
  const decorated = `${suffix}${contextSuffix}`
  if (name.endsWith(decorated)) return `${name.slice(0, -decorated.length)}${contextSuffix}`
  return name
}

/**
 * Return the provider/catalog name without the account decoration added by the
 * provider plugin. Only exact known labels are removed; generic parenthesis
 * stripping would erase meaningful context-window names.
 */
export function canonicalModelName(item: ModelNameLike, labels: AccountLabels = {}): string {
  const providerID = item.provider?.id ?? item.providerID
  const descriptor = Object.values(MULTI_ACCOUNT_PROVIDERS).find((candidate) => candidate.id === providerID)
  if (!descriptor) return item.name

  const parts = splitMultiAccountModelID(item.id)
  const values = labelsFor(labels)
  if (parts.accountID) {
    const label = labelForAccount(labels, parts.accountID)
    if (label) return removeAccountLabel(item.name, label)
  }

  for (const label of values.sort((a, b) => b.length - a.length)) {
    const stripped = removeAccountLabel(item.name, label)
    if (stripped !== item.name) return stripped
  }
  return item.name
}

export function providerForModelID(modelID: string): MultiAccountProvider | undefined {
  const parts = splitMultiAccountModelID(modelID)
  if (!parts.accountID) return undefined
  return providers.find((provider) => parts.accountID!.startsWith(provider.accountPrefix))
}
