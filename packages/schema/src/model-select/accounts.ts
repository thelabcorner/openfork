import { canonicalModelName, splitModelIDForProvider, type AccountLabels } from "./account-identity"
import { MULTI_ACCOUNT_PROVIDERS, type MultiAccountProviderRegistry } from "./multi-account-providers"

export type AccountModelItem = {
  id: string
  name: string
  provider: { id: string; name: string }
}

export type AccountVariant<T extends AccountModelItem = AccountModelItem> = {
  accountID: string
  item: T
}

export type ModelGroup<T extends AccountModelItem = AccountModelItem> = {
  key: string
  canonical: T
  auto?: T
  variants: AccountVariant<T>[]
  label: string
}

const providerFor = (providerID: string, registry: MultiAccountProviderRegistry) => registry[providerID]
const modelKey = (item: AccountModelItem) => `${item.provider.id}:${item.id}`

/**
 * Collapse account-qualified catalog items into one canonical row per model.
 * The input order is preserved for account variants, which is the enrollment
 * order exposed by the provider catalog.
 */
export function collapseAccountVariants<T extends AccountModelItem>(
  items: readonly T[],
  registry: MultiAccountProviderRegistry = MULTI_ACCOUNT_PROVIDERS,
  labels: AccountLabels = {},
): ModelGroup<T>[] {
  const groups = new Map<string, ModelGroup<T>>()
  for (const item of items) {
    const descriptor = providerFor(item.provider.id, registry)
    const split = descriptor ? splitModelIDForProvider(item.id, item.provider.id) : { baseModelID: item.id }
    const key = `${item.provider.id}:${split.baseModelID}`
    let group = groups.get(key)
    if (!group) {
      group = {
        key,
        canonical: item,
        variants: [],
        label: item.name,
      }
      groups.set(key, group)
    }

    if (!descriptor) continue
    if (!split.accountID) {
      // Prefer the provider's bare/auto item even when it arrives after a
      // qualified item. This keeps the real catalog object as the row source.
      group.auto = item
      group.canonical = item
      group.label = item.name
      continue
    }

    if (!group.variants.some((variant) => variant.accountID === split.accountID)) {
      group.variants.push({ accountID: split.accountID, item })
    }
    if (!group.auto) {
      group.label = canonicalModelName(item, labels)
    }
  }
  return [...groups.values()]
}

export function groupForModelID<T extends AccountModelItem>(
  groups: readonly ModelGroup<T>[],
  providerID: string,
  modelID: string,
  registry: MultiAccountProviderRegistry = MULTI_ACCOUNT_PROVIDERS,
): ModelGroup<T> | undefined {
  const descriptor = providerFor(providerID, registry)
  const split = descriptor ? splitModelIDForProvider(modelID, providerID) : { baseModelID: modelID }
  return groups.find((group) => group.key === `${providerID}:${split.baseModelID}`)
}

/**
 * Expand only groups whose account-specific identity matches the query. A
 * normal model/name match remains canonical, while typing an account label or
 * id intentionally brings the matching account rows back.
 */
export function expandForQuery<T extends AccountModelItem>(groups: readonly ModelGroup<T>[], query: string): T[] {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return groups.map((group) => group.canonical)

  const result: T[] = []
  for (const group of groups) {
    const canonicalMatches = [group.label, group.canonical.name, group.canonical.id].some((value) =>
      value.toLocaleLowerCase().includes(normalized),
    )
    if (canonicalMatches) {
      result.push(group.canonical)
      continue
    }
    for (const variant of group.variants) {
      if (`${variant.accountID} ${variant.item.name} ${variant.item.id}`.toLocaleLowerCase().includes(normalized)) {
        result.push(variant.item)
      }
    }
  }
  return result
}

export function variantForPolicy<T extends AccountModelItem>(
  group: ModelGroup<T>,
  selection: string,
  provider: MultiAccountProviderRegistry = MULTI_ACCOUNT_PROVIDERS,
): T | undefined {
  const descriptor = provider[group.canonical.provider.id]
  if (!descriptor) return undefined
  if (selection === "sticky" || selection === "headroom" || selection === "spread") {
    if (!group.auto) return undefined
    return {
      ...group.auto,
      id: `${group.auto.id}@${descriptor.accountPrefix}auto:${selection}`,
    } as T
  }
  return group.variants.find((variant) => variant.accountID === selection)?.item
}

export function indexModelGroups<T extends AccountModelItem>(groups: readonly ModelGroup<T>[]) {
  const index = new Map<string, ModelGroup<T>>()
  for (const group of groups) {
    index.set(modelKey(group.canonical), group)
    for (const variant of group.variants) index.set(modelKey(variant.item), group)
  }
  return index
}
