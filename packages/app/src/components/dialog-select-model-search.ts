// model search normalization/matching.
//
// The primitive normalization/matcher implementation lives in schema so the
// PWA model selector runs the exact same logic. The group projection below is
// renderer-specific because desktop account collapsing is also renderer-owned.
import { createModelSearchMatcher, prepareModelSearchFields } from "@opencode-ai/schema/model-select/search"

export * from "@opencode-ai/schema/model-select/search"

type SearchItem = {
  id: string
  name: string
  provider: { name: string }
}

type SearchGroup<T extends SearchItem> = {
  label: string
  canonical: T
  variants: readonly { accountID: string; item: T }[]
}

export type PreparedModelGroupSearchFields<T extends SearchItem> = Map<
  T,
  ReturnType<typeof prepareModelSearchFields>
>

export function prepareModelGroupSearchFields<T extends SearchItem>(
  groups: readonly SearchGroup<T>[],
): PreparedModelGroupSearchFields<T> {
  const fields: PreparedModelGroupSearchFields<T> = new Map()
  for (const group of groups) {
    fields.set(
      group.canonical,
      prepareModelSearchFields([
        group.label,
        group.canonical.name,
        group.canonical.id,
        group.canonical.provider.name,
      ]),
    )
    for (const variant of group.variants) {
      fields.set(variant.item, prepareModelSearchFields([variant.accountID, variant.item.name, variant.item.id]))
    }
  }
  return fields
}

export function filterPreparedModelGroupsForSearch<T extends SearchItem>(
  groups: readonly SearchGroup<T>[],
  query: string,
  fields: PreparedModelGroupSearchFields<T>,
): T[] {
  const trimmed = query.trim()
  if (!trimmed) return groups.map((group) => group.canonical)

  const matches = createModelSearchMatcher(trimmed)
  const result: T[] = []
  for (const group of groups) {
    if (matches(fields.get(group.canonical))) {
      result.push(group.canonical)
      continue
    }
    for (const variant of group.variants) {
      if (matches(fields.get(variant.item))) result.push(variant.item)
    }
  }
  return result
}
