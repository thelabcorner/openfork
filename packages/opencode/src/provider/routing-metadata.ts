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
