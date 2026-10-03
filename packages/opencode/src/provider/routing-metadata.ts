export const ROUTED_ACCOUNT_HEADER = "x-openfork-routed-account-id"

export function withRoutedAccount(response: Response, accountID: string | undefined) {
  if (!accountID) return response

  // Constructed/Bun responses have mutable headers, so preserve the exact
  // response object and body stream whenever possible. Fetch responses may use
  // an immutable header guard; rebuild only in that case, before the body has
  // been consumed.
  try {
    response.headers.set(ROUTED_ACCOUNT_HEADER, accountID)
    return response
  } catch {
    const headers = new Headers(response.headers)
    headers.set(ROUTED_ACCOUNT_HEADER, accountID)
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }
}

export function resolveRoutedAccount(observed: Iterable<string>, fallback?: string) {
  const unique = new Set(observed)
  if (unique.size === 0) return fallback
  if (unique.size !== 1) return undefined
  return unique.values().next().value
}

export function routedAccountFromResponse(response: unknown) {
  if (!response || typeof response !== "object") return undefined
  const headers = (response as { headers?: unknown }).headers
  if (!headers) return undefined

  if (headers instanceof Headers) {
    const value = headers.get(ROUTED_ACCOUNT_HEADER)
    return value && value.length > 0 ? value : undefined
  }

  if (typeof headers !== "object") return undefined
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() !== ROUTED_ACCOUNT_HEADER) continue
    return typeof value === "string" && value.length > 0 ? value : undefined
  }
  return undefined
}


export type RoutedAccountExpectation = {
  readonly routeKind: "public" | "account"
  readonly accountID?: string
}

export type RoutedAccountMismatch =
  | {
      readonly kind: "public-observed-account"
      readonly observedAccountIDs: readonly string[]
    }
  | {
      readonly kind: "account-observed-different"
      readonly expectedAccountID: string | undefined
      readonly observedAccountIDs: readonly string[]
    }

/**
 * Validate provider-observed routing metadata against already-committed route
 * authority. This is diagnostics only: callers must never use the result to
 * replace or reselect the committed route.
 *
 * Missing response metadata is intentionally not a mismatch. Providers are not
 * required to echo routing identity, and its absence cannot erase authority.
 */
export function routedAccountMismatch(
  observed: Iterable<string>,
  expected: RoutedAccountExpectation,
): RoutedAccountMismatch | undefined {
  const observedAccountIDs = [...new Set(observed)].sort()
  if (observedAccountIDs.length === 0) return undefined

  if (expected.routeKind === "public") {
    return {
      kind: "public-observed-account",
      observedAccountIDs,
    }
  }

  if (
    expected.accountID !== undefined &&
    observedAccountIDs.length === 1 &&
    observedAccountIDs[0] === expected.accountID
  ) {
    return undefined
  }

  return {
    kind: "account-observed-different",
    expectedAccountID: expected.accountID,
    observedAccountIDs,
  }
}
