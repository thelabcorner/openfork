import { describe, expect, test } from "bun:test"
import { decodeXaiGrpcWeb } from "../../src/quota/providers/xai"

/**
 * Wire fixtures for the xAI gRPC-Web decoder, pinned to the contract the
 * adapter scans for: usage-percent fixed32 (IEEE-754 float) at field paths
 * [1] or [1,1], reset epoch-seconds varint at [1,5,1], framed as
 * gRPC-Web [flag:1][length:4be][payload].
 */

function frame(flag: number, payload: Uint8Array): Uint8Array {
  const header = new Uint8Array(5)
  header[0] = flag
  new DataView(header.buffer).setUint32(1, payload.length, false)
  const out = new Uint8Array(5 + payload.length)
  out.set(header, 0)
  out.set(payload, 5)
  return out
}

function fieldFixed32(fieldNumber: number, value: number): Uint8Array {
  const out = new Uint8Array(5)
  out[0] = (fieldNumber << 3) | 5
  new DataView(out.buffer).setFloat32(1, value, true)
  return out
}

function fieldVarint(fieldNumber: number, value: number): Uint8Array {
  return concat(new Uint8Array([(fieldNumber << 3) | 0]), varint(value))
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function varint(value: number): Uint8Array {
  const bytes: number[] = []
  let current = value
  while (current > 0x7f) {
    bytes.push((current & 0x7f) | 0x80)
    current = Math.floor(current / 128)
  }
  bytes.push(current)
  return new Uint8Array(bytes)
}

function lengthDelimited(fieldNumber: number, payload: Uint8Array): Uint8Array {
  return concat(new Uint8Array([(fieldNumber << 3) | 2]), varint(payload.length), payload)
}

describe("xaiGrpcWebDecoder", () => {
  test("reads percent at [1] and resetAt at [1,5,1]", () => {
    const epochSec = 1_800_000_000
    const message = lengthDelimited(1, concat(fieldFixed32(1, 45), lengthDelimited(5, fieldVarint(1, epochSec))))
    const decoded = decodeXaiGrpcWeb(frame(0, message))
    expect(decoded?.percent).toBeCloseTo(45)
    expect(decoded?.resetAt).toBe(epochSec * 1000)
  })

  test("reads nested percent at path [1,1]", () => {
    const outer = lengthDelimited(1, fieldFixed32(1, 87.5))
    const decoded = decodeXaiGrpcWeb(frame(0, outer))
    expect(decoded?.percent).toBeCloseTo(87.5)
  })

  test("ignores trailer frames and returns undefined without a data frame", () => {
    const trailers = frame(0b1000_0000, new TextEncoder().encode("grpc-status: 0\r\n"))
    expect(decodeXaiGrpcWeb(trailers)).toBeUndefined()
    expect(decodeXaiGrpcWeb(new Uint8Array([9, 9, 9]))).toBeUndefined()
  })

  test("truncated frames do not throw", () => {
    const good = frame(0, concat(fieldFixed32(1, 10)))
    const truncated = good.subarray(0, 7)
    expect(() => decodeXaiGrpcWeb(truncated)).not.toThrow()
  })
})
