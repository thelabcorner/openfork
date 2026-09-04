/**
 * The transport identity used by providers which expose one model per account.
 *
 * This module intentionally has no renderer or server dependencies. Both sides
 * of the application use it so account suffix parsing cannot drift.
 */

export type AccountModelProvider = {
  id: string
  accountPrefix: string
  aliasMarkers?: readonly string[]
}

export type AccountModelParts = {
  baseModelID: string
  accountID?: string
}

export const ACCOUNT_MODEL_PROVIDERS: readonly AccountModelProvider[] = [
  { id: "workbuddy", accountPrefix: "wb-", aliasMarkers: ["#ctx-"] },
  { id: "verdent", accountPrefix: "vd-", aliasMarkers: [] },
  { id: "opencode", accountPrefix: "zen-", aliasMarkers: [] },
  { id: "opencode-go", accountPrefix: "zen-", aliasMarkers: [] },
]

/**
 * Split only a known account suffix. Model ids are allowed to contain `@` for
 * unrelated purposes (for example Verdent context aliases), so an arbitrary
 * last-at-sign is not an account boundary.
 */
export function splitAccountModelID(
  modelID: string,
  providers: readonly AccountModelProvider[] = ACCOUNT_MODEL_PROVIDERS,
): AccountModelParts {
  for (const provider of providers) {
    const marker = `@${provider.accountPrefix}`
    const separator = modelID.lastIndexOf(marker)
    if (separator <= 0) continue

    const accountID = modelID.slice(separator + 1)
    // `foo@wb-` is a malformed suffix, not a qualified model id.
    if (accountID.length <= provider.accountPrefix.length || accountID.includes("@")) continue
    return { baseModelID: modelID.slice(0, separator), accountID }
  }
  return { baseModelID: modelID }
}

export function joinAccountModelID(baseModelID: string, accountID?: string): string {
  return accountID ? `${baseModelID}@${accountID}` : baseModelID
}

export function isAccountQualified(
  modelID: string,
  providers: readonly AccountModelProvider[] = ACCOUNT_MODEL_PROVIDERS,
): boolean {
  return splitAccountModelID(modelID, providers).accountID !== undefined
}

export function baseModelID(
  modelID: string,
  providers: readonly AccountModelProvider[] = ACCOUNT_MODEL_PROVIDERS,
): string {
  return splitAccountModelID(modelID, providers).baseModelID
}
