const eventSizeCache = new WeakMap<object, number>()

/** UTF-8 length of a string without materializing a Buffer. */
function utf8Length(value: string) {
  let bytes = 0
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 0x80) {
      bytes += 1
      continue
    }
    if (code < 0x800) {
      bytes += 2
      continue
    }
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      // High surrogate: the pair encodes one astral scalar as 4 bytes.
      bytes += 4
      index++
      continue
    }
    bytes += 3
  }
  return bytes
}

/** Cheap bounded estimate used for transport replay and renderer queue budgets. */
export function estimateEventBytes(value: unknown) {
  // Saturate above every current transport budget (8 MiB) so a pathological
  // payload is rejected as oversized rather than being miscounted as a small
  // frame. Traverse nested payloads without a fixed depth cutoff: a deeply
  // nested large string must not be mistaken for a tiny frame. The active set
  // breaks cycles while still counting a shared object again when it appears
  // in two separate branches (the wire representation repeats it too).
  const estimateLimit = 64 * 1024 * 1024
  const maxNodes = 200_000
  const cacheable = value !== null && typeof value === "object" ? value : undefined
  if (cacheable) {
    const cached = eventSizeCache.get(cacheable)
    if (cached !== undefined) return cached
  }
  let total = 32
  let nodes = 0
  const active = new WeakSet<object>()
  const stack: Array<{ value: unknown; exit?: boolean }> = [{ value }]
  while (stack.length > 0 && total < estimateLimit) {
    const frame = stack.pop()!
    const input = frame.value
    if (frame.exit) {
      if (input && typeof input === "object") active.delete(input)
      continue
    }
    if (typeof input === "string") {
      total += utf8Length(input)
      continue
    }
    if (typeof input === "number" || typeof input === "boolean" || typeof input === "bigint") {
      total += 8
      continue
    }
    if (!input || typeof input !== "object") {
      total += 16
      continue
    }
    nodes += 1
    if (nodes > maxNodes) {
      total = estimateLimit
      break
    }
    if (active.has(input)) {
      total += 16
      continue
    }
    active.add(input)
    stack.push({ value: input, exit: true })
    if (Array.isArray(input)) {
      total += 8
      for (let index = input.length - 1; index >= 0; index--) stack.push({ value: input[index] })
      continue
    }
    for (const [key, item] of Object.entries(input)) {
      total += key.length * 3 + 2
      stack.push({ value: item })
    }
  }
  const result = Math.min(total, estimateLimit)
  if (cacheable) eventSizeCache.set(cacheable, result)
  return result
}
