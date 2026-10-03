import type { CallToolResult } from "@modelcontextprotocol/server"

export const BOUNDARY_CONTEXT_SCHEMA = "oxp-boundary-primary-text/v1" as const

/**
 * Count Unicode code points without allocating an Array.from/string iterator.
 *
 * The historical calibration uses SQLite length(TEXT), whose unit is Unicode
 * code points rather than JS UTF-16 code units. Keeping the producer in that
 * same unit lets one tokenizer calibration cover both historical and live
 * projections.
 */
export function codePointLength(value: string) {
  let count = value.length
  for (let index = 0; index + 1 < value.length; index += 1) {
    const lead = value.charCodeAt(index)
    if (lead < 0xd800 || lead > 0xdbff) continue
    const trail = value.charCodeAt(index + 1)
    if (trail < 0xdc00 || trail > 0xdfff) continue
    count -= 1
    index += 1
  }
  return count
}

/**
 * Exact primary request mass at the MCP boundary.
 *
 * This is deliberately transient: arguments are serialized only to measure
 * their textual footprint and are never persisted by this module.
 */
export function requestContextChars(args: unknown) {
  try {
    const encoded = JSON.stringify(args)
    return encoded === undefined ? 0 : codePointLength(encoded)
  } catch {
    return undefined
  }
}

/**
 * Exact primary text returned by the MCP boundary after all server-side
 * augmentation (including continuity notices). Binary/image content and
 * structuredContent are not converted into pretend text tokens.
 */
export function resultContextChars(result: CallToolResult) {
  let chars = 0
  for (const item of result.content) {
    if (item.type !== "text" || typeof item.text !== "string") continue
    chars += codePointLength(item.text)
  }
  return chars
}
