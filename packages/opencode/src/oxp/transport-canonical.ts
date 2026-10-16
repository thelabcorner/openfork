/**
 * One canonical JSON projection for schema/fingerprint owners.
 * No executable capability, workspace, or MCP SDK dependencies.
 *
 * Keep existing JSON scalar semantics: omit undefined object fields, sort
 * keys with JS localeCompare, and retain array order. Deliberately not a
 * generic serializer for cyclic or non-JSON runtime values.
 */
export function canonicalTransportJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalTransportJson).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalTransportJson(item)}`).join(",")}}`
}
