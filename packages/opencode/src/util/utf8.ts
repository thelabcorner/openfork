/**
 * UTF-8 sizing/truncation for producer-owned byte budgets.
 *
 * String.length counts UTF-16 code units and is therefore not a byte budget.
 * Iterate code points once so truncation never splits a surrogate pair and does
 * not repeatedly encode progressively larger prefixes.
 */
export function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8")
}

export function truncate(value: string, maxBytes: number): {
  readonly text: string
  readonly bytes: number
  readonly truncated: boolean
} {
  if (maxBytes <= 0) return { text: "", bytes: 0, truncated: value.length > 0 }

  const total = byteLength(value)
  if (total <= maxBytes) return { text: value, bytes: total, truncated: false }

  let bytes = 0
  let end = 0
  for (const char of value) {
    const point = char.codePointAt(0)!
    const width = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
    if (bytes + width > maxBytes) break
    bytes += width
    end += char.length
  }
  return { text: value.slice(0, end), bytes, truncated: true }
}

/**
 * Read a byte-addressed UTF-8 window without ever emitting a partial code point.
 *
 * Offsets produced by this function are exact continuation tokens. A caller
 * supplied offset that lands in the middle of a code point advances to the next
 * boundary rather than manufacturing U+FFFD or re-emitting partial data.
 */
export function window(value: string, offsetBytes: number, maxBytes: number): {
  readonly text: string
  readonly offset: number
  readonly nextOffset: number
  readonly totalBytes: number
  readonly truncated: boolean
} {
  const totalBytes = byteLength(value)
  const requested = Math.max(0, Math.min(Math.floor(offsetBytes), totalBytes))
  const budget = Math.max(0, Math.floor(maxBytes))

  let byte = 0
  let startIndex = value.length
  let startByte = totalBytes
  for (let index = 0; index < value.length; ) {
    const point = value.codePointAt(index)!
    const width = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
    if (byte >= requested) {
      startIndex = index
      startByte = byte
      break
    }
    if (byte + width > requested) {
      startIndex = index + (point > 0xffff ? 2 : 1)
      startByte = byte + width
      break
    }
    byte += width
    index += point > 0xffff ? 2 : 1
  }

  const sliced = truncate(value.slice(startIndex), budget)
  return {
    text: sliced.text,
    offset: startByte,
    nextOffset: startByte + sliced.bytes,
    totalBytes,
    truncated: sliced.truncated || startByte + sliced.bytes < totalBytes,
  }
}

