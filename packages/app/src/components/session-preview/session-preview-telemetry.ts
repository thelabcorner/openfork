/** A virtualizer frequently replaces measurement objects without changing
 * the session IDs being displayed. Only changes to the actual set of preview
 * identities should trigger the producer's batched telemetry.ensure call.
 */
export function previewTelemetryIDs(
  rows: readonly { item?: { row: { row: { id: string } } } }[],
  currentSessionID?: string,
): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const entry of rows) {
    const id = entry.item?.row.row.id
    if (!id || seen.has(id)) continue
    seen.add(id)
    result.push(id)
  }
  if (currentSessionID && !seen.has(currentSessionID)) result.push(currentSessionID)
  return result
}

/** Readable semantic equality for reactive memo suppression. */
export function samePreviewTelemetryIDs(a: readonly string[], b: readonly string[]) {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}