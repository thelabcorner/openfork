import type { Message, Part } from "@opencode-ai/sdk/v2/client"

export const RAW_MESSAGE_PAGE_SIZE = 200
export const RAW_MESSAGE_SUMMARY_CHARS = 24 * 1024

/**
 * Match trim()+slice() without allocating a potentially multi-megabyte
 * trimmed copy for each mounted message header.
 */
export function boundedMessagePreview(text: string, limit = 24): string | undefined {
  let start = 0
  while (start < text.length && /\s/.test(text[start]!)) start++
  if (start === text.length) return undefined
  let end = text.length
  while (end > start && /\s/.test(text[end - 1]!)) end--
  const length = Math.max(0, limit)
  const preview = text.slice(start, Math.min(end, start + length))
  return end - start > length ? `${preview}…` : preview
}

export function newestRawMessages(messages: readonly Message[], requested = RAW_MESSAGE_PAGE_SIZE) {
  const limit = Math.max(RAW_MESSAGE_PAGE_SIZE, requested)
  return messages.length <= limit ? messages : messages.slice(messages.length - limit)
}

/** Bounded inspection preview; authoritative payload remains in Raw JSON. */
export function boundedPartsText(
  parts: readonly Part[],
  select: (part: Part) => string | undefined,
  limit = RAW_MESSAGE_SUMMARY_CHARS,
) {
  let output = ""
  let truncated = false
  for (const part of parts) {
    const value = select(part)
    if (!value) continue
    let start = 0
    while (start < value.length && /\s/.test(value[start]!)) start++
    let end = value.length
    while (end > start && /\s/.test(value[end - 1]!)) end--
    if (end <= start) continue
    const separator = output ? "\n\n" : ""
    const remaining = limit - output.length - separator.length
    if (remaining <= 0) {
      truncated = true
      break
    }
    const length = end - start
    output += separator + value.slice(start, start + Math.min(length, remaining))
    if (length > remaining) {
      truncated = true
      break
    }
  }
  if (truncated) output += "\n\n…"
  return output || undefined
}
