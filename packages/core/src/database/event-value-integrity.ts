import { createHash } from "node:crypto"
import {
  applyV5Correction,
  decodeV5Correction,
  decodeValueBytesRaw,
  isV5Frame,
  OCDBFrameError,
  parseV5Header,
} from "./json-codec"

const decoder = new TextDecoder()

export type StoredEventValue = {
  readonly valueID: string
  readonly sha256: string
  readonly rawLen: number
  readonly bytes: Uint8Array
}

export type EventValueBaseLoader = (valueID: string) => Uint8Array | undefined

/**
 * Decode one durable event_value representation using the format's ownership
 * contract. v5 values depend on one same-aggregate standalone base; the writer
 * intentionally never emits delta-on-delta chains.
 *
 * The callback keeps this layer storage-agnostic: raw SQLite rebuild/compact
 * paths can resolve a base synchronously without importing the application DB
 * service, while the representation semantics remain defined once.
 */
export function decodeStoredEventValueRaw(bytes: Uint8Array, loadBase: EventValueBaseLoader): Uint8Array {
  if (!isV5Frame(bytes)) return decodeValueBytesRaw(bytes)

  const header = parseV5Header(bytes)
  const base = loadBase(header.baseValueId)
  if (base === undefined) throw new OCDBFrameError(`delta_ref base missing: ${header.baseValueId}`)
  if (isV5Frame(base)) {
    throw new OCDBFrameError(`nested delta_ref base is outside the v5 format contract: ${header.baseValueId}`)
  }
  const baseRaw = decodeValueBytesRaw(base)
  const correction = decodeV5Correction(header.correction, header.codec, header.storedCrc)
  return applyV5Correction(baseRaw, correction, header.totalRawLen)
}

/**
 * Fail-closed integrity verifier shared by file-swap maintenance paths.
 *
 * Verifies the canonical raw length and SHA-256 identity in addition to the
 * frame's CRC and JSON syntax. Returning false rather than throwing lets a
 * caller abort a swap while preserving the original database unchanged.
 */
export function verifyStoredEventValue(row: StoredEventValue, loadBase: EventValueBaseLoader): boolean {
  try {
    const raw = decodeStoredEventValueRaw(row.bytes, loadBase)
    if (raw.byteLength !== row.rawLen) return false
    if (createHash("sha256").update(raw).digest("hex") !== row.sha256) return false
    JSON.parse(decoder.decode(raw))
    return true
  } catch {
    return false
  }
}
