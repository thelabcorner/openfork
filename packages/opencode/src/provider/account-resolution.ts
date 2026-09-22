export type ProviderAccountIdentity = {
  readonly id: string
  readonly label: string
  readonly aliases?: readonly string[]
}

export type AccountResolution =
  | { readonly kind: "resolved"; readonly accountID: string; readonly matchedBy: "id" | "label" | "alias" }
  | { readonly kind: "not-found"; readonly candidates: readonly ProviderAccountIdentity[] }
  | { readonly kind: "ambiguous"; readonly matches: readonly ProviderAccountIdentity[] }

function normalize(value: string) {
  return value.trim().normalize("NFKC").toLowerCase()
}

/**
 * Resolve a user-facing provider-account selector to its stable routing id.
 *
 * Stable ids are authoritative and matched byte-for-byte. Human labels and
 * explicit aliases are convenience selectors only: they are Unicode-normalized,
 * case-insensitive, and must identify exactly one account. There is deliberately
 * no fuzzy/prefix matching because choosing a "close" credential is worse than
 * failing closed.
 */
export function resolveProviderAccountSelector(
  selector: string,
  accounts: readonly ProviderAccountIdentity[],
): AccountResolution {
  const token = selector.trim()
  const direct = accounts.find((account) => account.id === token)
  if (direct) return { kind: "resolved", accountID: direct.id, matchedBy: "id" }

  const normalized = normalize(token)
  const labelMatches = accounts.filter((account) => normalize(account.label) === normalized)
  if (labelMatches.length === 1) {
    return { kind: "resolved", accountID: labelMatches[0]!.id, matchedBy: "label" }
  }
  if (labelMatches.length > 1) return { kind: "ambiguous", matches: labelMatches }

  const aliasMatches = accounts.filter((account) =>
    account.aliases?.some((alias) => normalize(alias) === normalized),
  )
  if (aliasMatches.length === 1) {
    return { kind: "resolved", accountID: aliasMatches[0]!.id, matchedBy: "alias" }
  }
  if (aliasMatches.length > 1) return { kind: "ambiguous", matches: aliasMatches }

  return { kind: "not-found", candidates: accounts }
}

export * as ProviderAccountResolution from "./account-resolution"
