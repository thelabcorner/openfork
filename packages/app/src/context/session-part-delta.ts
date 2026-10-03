/** Apply one delta at its producer-authored UTF-16 code-unit offset. */
export function applyPartDelta(
  current: string | undefined,
  delta: string,
  offset?: number,
): { readonly value: string; readonly applied: boolean } {
  const base = current ?? ""
  if (offset === undefined) return { value: base + delta, applied: true }
  if (!Number.isSafeInteger(offset) || offset < 0 || base.length < offset) return { value: base, applied: false }

  const overlap = Math.min(base.length - offset, delta.length)
  if (base.slice(offset, offset + overlap) !== delta.slice(0, overlap)) return { value: base, applied: false }
  return { value: base + delta.slice(overlap), applied: true }
}
