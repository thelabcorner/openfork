export * as OxpAttributionStatusPolicy from "./status-policy"

const RESPONSE_EXPECTED = new Set([
  "success",
  "committed",
  "failed",
  "conflict",
  "denied",
  "cancelled_before_commit",
  "cancelled_after_commit",
])

const NO_RESPONSE = new Set(["interrupted", "running"])

/**
 * Historical rows may predate a status-policy revision. Never turn an unknown
 * terminal status into invented response mass merely because a broad donor
 * population exists.
 */
export function responseExpectation(status: string): boolean | undefined {
  if (RESPONSE_EXPECTED.has(status)) return true
  if (NO_RESPONSE.has(status)) return false
  return undefined
}