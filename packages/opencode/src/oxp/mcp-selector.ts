/**
 * Pure selector resolution for a fresh external-MCP snapshot. No cross-request
 * cache: server inventory and per-root authorization can change at any time.
 *
 * Canonical server/tool identities win over bare names, while ambiguous bare
 * names expose at most eight canonical repair choices.
 */
export function canonicalToolID(tool: { readonly server: string; readonly name: string }) {
  return `${encodeURIComponent(tool.server)}/${encodeURIComponent(tool.name)}`
}

export type Selection<T> =
  | { readonly kind: "found"; readonly tool: T }
  | { readonly kind: "ambiguous"; readonly candidates: readonly string[] }
  | { readonly kind: "missing" }

export function selectMcpTool<T extends { readonly server: string; readonly name: string }>(
  tools: readonly T[],
  selector: string,
): Selection<T> {
  let canonical: T | undefined
  let canonicalCount = 0
  let bare: T | undefined
  let bareCount = 0
  const candidates: string[] = []
  // Decode the canonical selector at most once. Encoding every candidate
  // costs O(N * URI-encoding), whereas comparing exact server/name strings
  // costs O(N). Re-encode this one selector to reject noncanonical spellings:
  // "%2f" is not the same canonical ID as "%2F".
  const slash = selector.indexOf("/")
  let canonicalServer: string | undefined
  let canonicalName: string | undefined
  if (slash >= 0) {
    try {
      const server = decodeURIComponent(selector.slice(0, slash))
      const name = decodeURIComponent(selector.slice(slash + 1))
      if (canonicalToolID({ server, name }) === selector) {
        canonicalServer = server
        canonicalName = name
      }
    } catch {
      // Invalid percent-encoding can still be a literal bare MCP tool name.
    }
  }
  for (const tool of tools) {
    if (canonicalServer !== undefined && tool.server === canonicalServer && tool.name === canonicalName) {
      canonical = tool
      canonicalCount++
    }
    if (tool.name !== selector) continue
    bare = tool
    bareCount++
    if (candidates.length < 8) candidates.push(canonicalToolID(tool))
  }
  if (canonicalCount === 1) return { kind: "found", tool: canonical! }
  if (bareCount === 1) return { kind: "found", tool: bare! }
  if (bareCount > 1) return { kind: "ambiguous", candidates }
  return { kind: "missing" }
}