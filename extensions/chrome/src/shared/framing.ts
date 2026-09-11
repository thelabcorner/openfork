// Native messaging stdio framing: 32-bit LE length prefix + UTF-8 JSON.
// Spec: "Each message is serialized using JSON, UTF-8 encoded and is preceded
// with 32-bit message length in native byte order." (developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
// Limits: host->ext 1 MiB, ext->host 64 MiB (enforced at decode time).

import {
  NATIVE_MESSAGE_HEADER_BYTES,
  NATIVE_MESSAGE_MAX_EXT_TO_HOST_BYTES,
  NATIVE_MESSAGE_MAX_HOST_TO_EXT_BYTES,
} from "./protocol.js"

export class FramingError extends Error {
  constructor(
    message: string,
    public readonly code: "too_large" | "truncated" | "invalid_json" | "empty",
  ) {
    super(message)
    this.name = "FramingError"
  }
}

/**
 * Encode a JSON-serializable value into the native-messaging wire format:
 * [4-byte LE length][UTF-8 JSON bytes]
 */
export function encodeNativeMessage(value: unknown, direction: "ext->host" | "host->ext" = "ext->host"): Uint8Array {
  const json = JSON.stringify(value)
  const payload = new TextEncoder().encode(json)
  const limit =
    direction === "host->ext" ? NATIVE_MESSAGE_MAX_HOST_TO_EXT_BYTES : NATIVE_MESSAGE_MAX_EXT_TO_HOST_BYTES
  if (payload.byteLength > limit) {
    throw new FramingError(
      `Native message ${payload.byteLength} bytes exceeds ${direction} limit ${limit}`,
      "too_large",
    )
  }
  const out = new Uint8Array(NATIVE_MESSAGE_HEADER_BYTES + payload.byteLength)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint32(0, payload.byteLength, true) // little-endian
  out.set(payload, NATIVE_MESSAGE_HEADER_BYTES)
  return out
}

/**
 * Decode a single native-messaging frame from a buffer.
 * Returns the parsed JSON value and the total bytes consumed (header+payload).
 * Throws FramingError on truncation / oversize / invalid JSON.
 */
export function decodeNativeMessage(
  buffer: Uint8Array,
  direction: "ext->host" | "host->ext" = "host->ext",
): { value: unknown; consumed: number } {
  if (buffer.byteLength < NATIVE_MESSAGE_HEADER_BYTES) {
    throw new FramingError(
      `Truncated header: need ${NATIVE_MESSAGE_HEADER_BYTES}, got ${buffer.byteLength}`,
      "truncated",
    )
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const length = view.getUint32(0, true)
  const limit =
    direction === "host->ext" ? NATIVE_MESSAGE_MAX_HOST_TO_EXT_BYTES : NATIVE_MESSAGE_MAX_EXT_TO_HOST_BYTES
  if (length > limit) {
    throw new FramingError(`Frame length ${length} exceeds ${direction} limit ${limit}`, "too_large")
  }
  if (buffer.byteLength < NATIVE_MESSAGE_HEADER_BYTES + length) {
    throw new FramingError(
      `Truncated payload: header says ${length}, buffer has ${buffer.byteLength - NATIVE_MESSAGE_HEADER_BYTES}`,
      "truncated",
    )
  }
  const payload = buffer.subarray(NATIVE_MESSAGE_HEADER_BYTES, NATIVE_MESSAGE_HEADER_BYTES + length)
  const json = new TextDecoder().decode(payload)
  if (!json) throw new FramingError("Empty JSON payload", "empty")
  try {
    const value = JSON.parse(json) as unknown
    return { value, consumed: NATIVE_MESSAGE_HEADER_BYTES + length }
  } catch (cause) {
    throw new FramingError(`Invalid JSON: ${(cause as Error).message}`, "invalid_json")
  }
}

/**
 * Incremental decoder for a streaming stdin: feed chunks as they arrive,
 * collect complete messages. Useful for host stdio reader.
 */
export class NativeMessageReader {
  private buffer = new Uint8Array(0)

  constructor(private readonly direction: "ext->host" | "host->ext" = "host->ext") {}

  /**
   * Append bytes and yield any complete messages.
   * Incomplete trailing bytes are retained for the next push.
   */
  push(chunk: Uint8Array): unknown[] {
    const merged = new Uint8Array(this.buffer.byteLength + chunk.byteLength)
    merged.set(this.buffer, 0)
    merged.set(chunk, this.buffer.byteLength)
    this.buffer = merged

    const messages: unknown[] = []
    while (this.buffer.byteLength >= NATIVE_MESSAGE_HEADER_BYTES) {
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength)
      const length = view.getUint32(0, true)
      const limit =
        this.direction === "host->ext" ? NATIVE_MESSAGE_MAX_HOST_TO_EXT_BYTES : NATIVE_MESSAGE_MAX_EXT_TO_HOST_BYTES
      if (length > limit) {
        throw new FramingError(`Stream frame ${length} exceeds ${this.direction} limit ${limit}`, "too_large")
      }
      const needed = NATIVE_MESSAGE_HEADER_BYTES + length
      if (this.buffer.byteLength < needed) break
      const frame = this.buffer.subarray(0, needed)
      const { value } = decodeNativeMessage(frame, this.direction)
      messages.push(value)
      this.buffer = this.buffer.subarray(needed)
    }
    return messages
  }

  get bufferedBytes(): number {
    return this.buffer.byteLength
  }
}
