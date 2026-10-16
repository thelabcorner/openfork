/**
 * A streaming presentation scheduler, not a fake per-character typewriter.
 * Limit reparses/layout to a perceptually stable cadence, catch up quickly to
 * provider bursts, and never hold a large backlog hostage to animation.
 */
export const STREAM_RENDER_PACE_MS = 32
export const STREAM_BACKLOG_SKIP = 4096

function breakAfter(code: number) {
  // Fast ASCII boundary test: whitespace or sentence punctuation. Avoid a
  // global RegExp on every candidate in the stream's hottest loop.
  return code === 32 || code === 9 || code === 10 || code === 13 ||
    code === 44 || code === 46 || code === 33 || code === 63 ||
    code === 59 || code === 58 || code === 41 || code === 93
}

/** End offset of the next coherent visible burst (UTF-16 indices). */
export function nextPacedTextEnd(text: string, offset: number) {
  const size = text.length
  if (offset >= size) return size
  const backlog = size - offset
  // Fresh short provider tokens are revealed together on the next tick.
  // Medium bursts are spread across a few frames. Massive responses skip
  // animation so live streaming stays readable and bounded in time/CPU.
  if (backlog <= 12 || backlog > STREAM_BACKLOG_SKIP) return size
  const amount = backlog <= 48 ? 12
    : backlog <= 128 ? 32
    : backlog <= 512 ? 96
    : backlog <= 2048 ? 256
    : 512
  let end = Math.min(size, offset + amount)
  for (let cursor = end; cursor < Math.min(size, end + 8); cursor++) {
    if (breakAfter(text.charCodeAt(cursor))) {
      end = cursor + 1
      break
    }
  }
  // Never publish half a surrogate pair or transiently split a Windows CRLF.
  if (end < size && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff &&
      text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end++
  if (end < size && text.charCodeAt(end - 1) === 13 && text.charCodeAt(end) === 10) end++
  return end
}
