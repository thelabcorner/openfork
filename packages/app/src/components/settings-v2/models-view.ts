import fuzzysort from "fuzzysort"

export type SettingsModelItem = {
  key: string
  id: string
  name: string
  displayName: string
  releaseDate: string
  searchText: string
  provider: { id: string; name: string }
}

export type SettingsModelGroup = {
  category: string
  name: string
  items: SettingsModelItem[]
}

export type SettingsModelRow =
  | {
      kind: "group"
      key: string
      category: string
      name: string
      expanded: boolean
      searching: boolean
    }
  | {
      kind: "model"
      key: string
      item: SettingsModelItem
      first: boolean
      last: boolean
    }

function providerRank(providerID: string, popularProviders: readonly string[]) {
  const index = popularProviders.indexOf(providerID)
  return index < 0 ? Number.MAX_SAFE_INTEGER : index
}

export function groupSettingsModels(items: readonly SettingsModelItem[], popularProviders: readonly string[]) {
  const grouped = new Map<string, SettingsModelGroup>()
  for (const item of items) {
    const current = grouped.get(item.provider.id)
    if (current) {
      current.items.push(item)
      continue
    }
    grouped.set(item.provider.id, {
      category: item.provider.id,
      name: item.provider.name,
      items: [item],
    })
  }

  const result = [...grouped.values()]
  for (const group of result) {
    group.items.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  }
  result.sort((a, b) => {
    const aRank = providerRank(a.category, popularProviders)
    const bRank = providerRank(b.category, popularProviders)
    if (aRank !== bRank) return aRank - bRank
    return a.name.localeCompare(b.name) || a.category.localeCompare(b.category)
  })
  return result
}

export function filterSettingsModelGroups(groups: readonly SettingsModelGroup[], query: string) {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/[\s\-_.]+/)
    .filter(Boolean)
  if (terms.length === 0) return [...groups]

  const result: SettingsModelGroup[] = []
  for (const group of groups) {
    const items = group.items.filter((item) => terms.every((term) => item.searchText.includes(term)))
    if (items.length === 0) continue
    result.push({ ...group, items })
  }
  if (result.length > 0) return result

  // Preserve typo-tolerant discovery from the old generic filtered-list path,
  // but pay fuzzysort's cost only when the fast token path finds nothing.
  const candidates = groups.flatMap((group) => group.items)
  const fuzzyKeys = new Set(
    fuzzysort.go(query, candidates, { key: "searchText" }).map((match) => match.obj.key),
  )
  if (fuzzyKeys.size === 0) return result

  return groups.flatMap((group) => {
    const items = group.items.filter((item) => fuzzyKeys.has(item.key))
    return items.length > 0 ? [{ ...group, items }] : []
  })
}

export function flattenSettingsModelGroups(
  groups: readonly SettingsModelGroup[],
  collapsed: Readonly<Record<string, boolean>>,
  searching: boolean,
) {
  const rows: SettingsModelRow[] = []
  for (const group of groups) {
    const expanded = searching || !collapsed[group.category]
    rows.push({
      kind: "group",
      key: `provider:${group.category}`,
      category: group.category,
      name: group.name,
      expanded,
      searching,
    })
    if (!expanded) continue
    for (let index = 0; index < group.items.length; index++) {
      const item = group.items[index]
      rows.push({
        kind: "model",
        key: `model:${item.key}`,
        item,
        first: index === 0,
        last: index === group.items.length - 1,
      })
    }
  }
  return rows
}