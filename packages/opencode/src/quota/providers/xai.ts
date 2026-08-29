import { Effect } from "effect"
import type { Auth } from "@/auth"
import { HttpClient } from "effect/unstable/http"
import { buildResult, toUsageWindow } from "../format"
import type { Adapter } from "../registry"
import type { ProviderResult } from "../schema"
import { authKey } from "./key"
import { createQuotaCache } from "./http"

/**
 * xAI (Grok) billing-cycle quota. Ported from OpenChamber (MIT)
 * providers/xai.js: one POST as gRPC-Web+proto with an empty request body,
 * response parsed by scanning the protobuf wire for the usage-percent
 * fixed32 at field paths [1]/[1,1] and the reset epoch-seconds varint at
 * [1,5,1]. Failures fold into ok=false envelopes; fetch is injectable for
 * fixture tests.
 */

const ALIASES = ["xai"]
const NAME = "xAI"
const USAGE_URL = "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig"

export type XaiFetch = (input: string, init: RequestInit) => Promise<Response>

type WireOutcome =
  | { readonly kind: "ok"; readonly bytes: Uint8Array }
  | { readonly kind: "error"; readonly message: string }

export const xai = (_http: HttpClient.HttpClient, auth: Auth.Interface, fetchImpl: XaiFetch = globalThis.fetch.bind(globalThis)): Adapter => {
  const cache = createQuotaCache<ProviderResult>("xai")

  return {
    id: "xai",
    name: NAME,
    aliases: ALIASES,
    configured: () => Effect.map(authKey(auth, ALIASES), (key) => key !== undefined),
    fetch: (): Effect.Effect<ProviderResult> =>
      Effect.gen(function* () {
        const resolved = yield* authKey(auth, ALIASES)
        const accessToken = resolved?.key
        if (!accessToken) {
          return buildResult({ providerId: "xai", providerName: NAME, ok: false, configured: false, error: "Not configured" })
        }
        const fresh = cache.fresh(accessToken)
        if (fresh) return fresh
        if (cache.isCoolingDown()) {
          const cachedResult = cache.cachedResult()
          if (cachedResult) return cachedResult
          return buildResult({ providerId: "xai", providerName: NAME, ok: false, configured: true, error: "Rate limited — xAI is throttling usage checks" })
        }
        // Never rejects -> the gen's error channel stays `never`.
        const outcome = yield* Effect.promise(() => performFetch(accessToken, fetchImpl))
        if (outcome.kind === "error") {
          const errorResult = buildResult({ providerId: "xai", providerName: NAME, ok: false, configured: true, error: outcome.message })
          if (outcome.message === "Rate limited") {
            cache.coolDown(errorResult, undefined, accessToken)
          }
          return errorResult
        }
        const decoded = decodeXaiGrpcWeb(outcome.bytes)
        if (!decoded || decoded.percent === null) {
          return buildResult({ providerId: "xai", providerName: NAME, ok: false, configured: true, error: "No quota data in response" })
        }
        const result = buildResult({
          providerId: "xai",
          providerName: NAME,
          ok: true,
          configured: true,
          usage: {
            windows: {
              billing_cycle: toUsageWindow({ usedPercent: decoded.percent, resetAt: decoded.resetAt }),
            },
          },
          fetchedAt: Date.now(),
        })
        cache.store(result, accessToken)
        return result
      }),
  }
}

async function performFetch(token: string, fetchImpl: XaiFetch): Promise<WireOutcome> {
  try {
    const response = await fetchImpl(USAGE_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/grpc-web+proto",
        origin: "https://grok.com",
      },
      body: new Uint8Array([0, 0, 0, 0, 0]),
      signal: AbortSignal.timeout(15_000),
    })
    if (response.status === 401 || response.status === 403) {
      return { kind: "error", message: "Session expired — please re-authenticate with xAI" }
    }
    if (response.status === 429) {
      return { kind: "error", message: "Rate limited" }
    }
    if (!response.ok) {
      return { kind: "error", message: `API error: ${response.status}` }
    }
    const buffer = await response.arrayBuffer()
    const bytes = new Uint8Array(buffer)

    // Trailers frame (flag !== 0) carries grpc-status; non-zero is an error.
    const trailerStatus = readTrailerStatus(bytes)
    if (trailerStatus !== null && trailerStatus !== 0) {
      return { kind: "error", message: `gRPC error: ${trailerStatus}` }
    }
    return { kind: "ok", bytes }
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) }
  }
}

// --- wire decoding -----------------------------------------------------------

type DecodedUsage = { percent: number | null; resetAt: number | null }

export function decodeXaiGrpcWeb(bytes: Uint8Array): DecodedUsage | undefined {
  const frames = parseFrames(bytes)
  let percent: number | null = null
  let resetAt: number | null = null
  for (const frame of frames) {
    if (frame.flag !== 0) continue
    const fields = scanProtobuf(frame.payload, 0, "", new Map<string, number[]>())
    percent = firstPercent(fields) ?? percent
    resetAt = firstResetAt(fields) ?? resetAt
  }
  if (percent === null && resetAt === null) return undefined
  return { percent, resetAt }
}

function readTrailerStatus(bytes: Uint8Array): number | null {
  for (const frame of parseFrames(bytes)) {
    if (frame.flag === 0) continue
    const text = new TextDecoder().decode(frame.payload)
    const match = /grpc-status:\s*(\d+)/.exec(text)
    if (match) return Number.parseInt(match[1]!, 10)
  }
  return null
}

type Frame = { flag: number; payload: Uint8Array }

function parseFrames(bytes: Uint8Array): Frame[] {
  const frames: Frame[] = []
  let offset = 0
  while (offset + 5 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 5)
    const flag = view.getUint8(0)
    const length = view.getUint32(1, false)
    offset += 5
    if (offset + length > bytes.length) break
    frames.push({ flag, payload: bytes.subarray(offset, offset + length) })
    offset += length
  }
  return frames
}

const USAGE_PERCENT_PATHS = ["1", "1.1"] as const
const RESET_AT_PATH = "1.5.1"

// Depth-bounded protobuf wire scan keyed by dotted field path; keeps varint
// and fixed32 leaves, recurses only into length-delimited submessages.
function scanProtobuf(bytes: Uint8Array, depth: number, prefix: string, out: Map<string, number[]>): Map<string, number[]> {
  if (depth > 4) return out
  let offset = 0
  while (offset < bytes.length) {
    const key = readVarint(bytes, offset)
    if (!key) break
    offset = key.next
    const fieldNumber = key.value >>> 3
    const wireType = key.value & 0b111
    if (fieldNumber === 0) break
    const path = prefix ? `${prefix}.${fieldNumber}` : `${fieldNumber}`
    if (wireType === 0) {
      const varint = readVarint(bytes, offset)
      if (!varint) break
      offset = varint.next
      pushLeaf(out, path, varint.value)
    } else if (wireType === 1) {
      if (offset + 8 > bytes.length) break
      pushLeaf(out, path, new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true))
      offset += 8
    } else if (wireType === 2) {
      const len = readVarint(bytes, offset)
      if (!len) break
      offset = len.next
      if (offset + len.value > bytes.length) break
      scanProtobuf(bytes.subarray(offset, offset + len.value), depth + 1, path, out)
      offset += len.value
    } else if (wireType === 5) {
      if (offset + 4 > bytes.length) break
      pushLeaf(out, path, new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true))
      offset += 4
    } else {
      break
    }
  }
  return out
}

function pushLeaf(out: Map<string, number[]>, path: string, value: number) {
  const list = out.get(path)
  if (list) list.push(value)
  else out.set(path, [value])
}

function readVarint(bytes: Uint8Array, start: number): { value: number; next: number } | undefined {
  let value = 0
  let shift = 0
  let offset = start
  while (offset < bytes.length) {
    const byte = bytes[offset]!
    value += (byte & 0b0111_1111) * Math.pow(2, shift)
    offset += 1
    if ((byte & 0b1000_0000) === 0) return { value, next: offset }
    shift += 7
    if (shift > 35) return undefined
  }
  return undefined
}

function firstPercent(fields: Map<string, number[]>): number | null {
  for (const path of USAGE_PERCENT_PATHS) {
    const candidates = fields.get(path)
    if (!candidates) continue
    for (const raw of candidates) {
      const asFloat = new Float32Array(new Uint32Array([raw]).buffer)[0]
      if (Number.isFinite(asFloat) && asFloat > 0 && asFloat <= 100) return asFloat
      const scaled = raw / 100
      if (scaled > 0 && scaled <= 100) return scaled
    }
  }
  return null
}

function firstResetAt(fields: Map<string, number[]>): number | null {
  const candidates = fields.get(RESET_AT_PATH)
  if (!candidates) return null
  for (const seconds of candidates) {
    if (seconds > 1_000_000_000) return seconds * 1000
  }
  return null
}
