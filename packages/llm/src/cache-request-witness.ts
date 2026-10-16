/**
 * LACE v14.7 read-only witness over an ALREADY compiled native provider body.
 *
 * This is NOT the provider's secret cache key, a token-prefix witness, or a
 * guarantee that a transport, SDK, proxy or provider preserves JSON key order.
 * Inputs must originate from LLMClient.prepare, not a hand-built semantic mock.
 * No original prompt content is retained by the witness.
 */
import { createHash, randomBytes } from "node:crypto"

export type WitnessProtocol = "openai-responses" | "openai-chat" | "anthropic-messages"
export type WitnessChange =
  | "first-observation"
  | "cache-domain-changed"
  | "cache-policy-changed"
  | "prefix-rewritten"
  | "prefix-extended"
  | "prefix-identical"
  | "unsupported-shape"

export interface CompiledRequestInput {
  /** All owner dimensions are resolved upstream. Never use this to grant access. */
  readonly owner: string
  readonly session: string
  readonly provider: string
  readonly model: string
  readonly runtime: string
  readonly route: string
  readonly protocol: WitnessProtocol
  /** A schema-validated native body from the protocol prepare step. */
  readonly body: Record<string, unknown>
}

export interface RequestWitness {
  readonly domainDigest: string
  readonly policyDigest: string
  readonly bodyDigest: string
  readonly regions: ReadonlyArray<{ readonly name: string; readonly digest: string; readonly bytes: number }>
}

export interface WitnessObservation {
  readonly kind: WitnessChange
  readonly firstChangedRegion?: string
  readonly retainedRegionCount: number
  readonly previousRegionCount: number
  readonly currentRegionCount: number
  readonly bodyChanged: boolean
  /** Exact native-body JSON equivalence, NOT final HTTP wire equivalence. */
  readonly bodyIdentical: boolean
}

const MAX_NATIVE_BYTES = 32 * 1024 * 1024
const MAX_REGIONS = 8192
const SALT = randomBytes(32)
// A symbol can never collide with user-controlled JSON string content.
const ABSENT = Symbol("lace:absent")

const digest = (text: string) => createHash("sha256").update(SALT).update(text).digest("hex")
const own = (x: Record<string, unknown>, k: string) =>
  Object.hasOwn(x, k) && x[k] !== undefined ? x[k] : ABSENT

function encode(value: unknown): string {
  // Optional native properties can be present as undefined even though JSON
  // transport drops them; encode absence outside JSON to prevent collisions.
  if (value === ABSENT || value === undefined) return "\u0000LACE_ABSENT"
  const json = JSON.stringify(value)
  if (typeof json !== "string") throw new TypeError("native provider body contains non-JSON request data")
  if (Buffer.byteLength(json, "utf8") > MAX_NATIVE_BYTES) throw new RangeError("native body exceeds witness bound")
  return json
}

function regions(input: CompiledRequestInput): RequestWitness["regions"] {
  const body = input.body
  const blocks: Array<[string, unknown]> = []
  switch (input.protocol) {
    case "anthropic-messages":
      // Anthropic's documented provider order: tools, system, messages.
      blocks.push(["tools", own(body, "tools")], ["system", own(body, "system")])
      if (!Array.isArray(body.messages)) throw new TypeError("Anthropic messages are not an array")
      body.messages.forEach((value, index) => blocks.push(["messages[" + index + "]", value]))
      break
    case "openai-responses":
      blocks.push(["tools", own(body, "tools")], ["instructions", own(body, "instructions")])
      if (!Array.isArray(body.input)) throw new TypeError("OpenAI Responses input is not an array")
      body.input.forEach((value, index) => blocks.push(["input[" + index + "]", value]))
      break
    case "openai-chat":
      blocks.push(["tools", own(body, "tools")])
      if (!Array.isArray(body.messages)) throw new TypeError("OpenAI Chat messages are not an array")
      body.messages.forEach((value, index) => blocks.push(["messages[" + index + "]", value]))
      break
  }
  if (blocks.length > MAX_REGIONS) throw new RangeError("native request has too many observable regions")
  return blocks.map(([name, value]) => {
    const encoded = encode(value)
    return { name, digest: digest(encoded), bytes: Buffer.byteLength(encoded, "utf8") }
  })
}

/** Deliberately bounded to one native body; never read raw auth headers. */
export function witnessCompiledRequest(input: CompiledRequestInput): RequestWitness {
  for (const value of [input.owner, input.session, input.provider, input.model, input.runtime, input.route]) {
    if (!value) throw new TypeError("request witness requires complete owner and route identity")
  }
  if (!input.body || Array.isArray(input.body) || typeof input.body !== "object") {
    throw new TypeError("request witness requires a native body object")
  }
  const bodyText = encode(input.body)
  const policy: Record<string, unknown> = {}
  switch (input.protocol) {
    case "openai-responses":
    case "openai-chat":
      policy.prompt_cache_key = own(input.body, "prompt_cache_key")
      // comparison_response_id is an observational diagnostic and must not
      // be classified as a cache-mode/TTL change. Unknown future fields remain
      // classified as policy mutations, not silently discarded.
      if (input.body.prompt_cache_options && typeof input.body.prompt_cache_options === "object" &&
          !Array.isArray(input.body.prompt_cache_options)) {
        const options = { ...input.body.prompt_cache_options as Record<string, unknown> }
        delete options.comparison_response_id
        policy.prompt_cache_options = options
      } else {
        policy.prompt_cache_options = own(input.body, "prompt_cache_options")
      }
      break
    case "anthropic-messages":
      // cache_control annotations live IN the model-visible tool/system/message
      // blocks and are thus included in the ordered region digests.
      break
    default:
      throw new TypeError("unsupported witness protocol")
  }
  return {
    domainDigest: digest(JSON.stringify([input.owner, input.session, input.provider, input.model, input.runtime, input.route, input.protocol])),
    policyDigest: digest(encode(policy)),
    bodyDigest: digest(bodyText),
    regions: regions(input),
  }
}

export function compareRequestWitness(
  previous: RequestWitness | undefined,
  current: RequestWitness,
): WitnessObservation {
  if (!previous) return {
    kind: "first-observation", retainedRegionCount: 0, previousRegionCount: 0,
    currentRegionCount: current.regions.length, bodyChanged: false, bodyIdentical: false,
  }
  const base = {
    previousRegionCount: previous.regions.length,
    currentRegionCount: current.regions.length,
    bodyChanged: previous.bodyDigest !== current.bodyDigest,
    bodyIdentical: previous.bodyDigest === current.bodyDigest,
  }
  if (previous.domainDigest !== current.domainDigest) return {
    ...base, kind: "cache-domain-changed", retainedRegionCount: 0,
  }
  if (previous.policyDigest !== current.policyDigest) return {
    ...base, kind: "cache-policy-changed", retainedRegionCount: 0,
  }
  const common = Math.min(previous.regions.length, current.regions.length)
  for (let i = 0; i < common; i++) {
    const left = previous.regions[i]!
    const right = current.regions[i]!
    if (left.name !== right.name || left.digest !== right.digest || left.bytes !== right.bytes) {
      return { ...base, kind: "prefix-rewritten", firstChangedRegion: right.name, retainedRegionCount: i }
    }
  }
  return {
    ...base,
    kind: previous.regions.length < current.regions.length
      ? "prefix-extended"
      : previous.regions.length > current.regions.length
        ? "prefix-rewritten"
        : "prefix-identical",
    retainedRegionCount: common,
    ...(current.regions.length < previous.regions.length ? { firstChangedRegion: "<history-truncated>" } : {}),
  }
}

/**
 * Bounded observations only: stores hashes and lengths, not prompts.
 * Scope this instance to one trusted process/owner; no global cache authority.
 */
export function createRequestWitnessObserver(maxSessions = 128, maxRetainedRegions = 16_384) {
  if (!Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > 4096) {
    throw new RangeError("invalid witness observer capacity")
  }
  if (!Number.isSafeInteger(maxRetainedRegions) || maxRetainedRegions < 1 || maxRetainedRegions > 65_536) {
    throw new RangeError("invalid witness region budget")
  }
  const entries = new Map<string, RequestWitness>()
  let retainedRegions = 0
  return {
    observe(input: CompiledRequestInput): WitnessObservation {
      const current = witnessCompiledRequest(input)
      const key = digest(JSON.stringify([input.owner, input.session]))
      const previous = entries.get(key)
      const result = compareRequestWitness(previous, current)
      if (previous) retainedRegions -= previous.regions.length
      entries.delete(key)
      entries.set(key, current)
      retainedRegions += current.regions.length
      while (entries.size > maxSessions || retainedRegions > maxRetainedRegions) {
        const oldest = entries.keys().next().value!
        retainedRegions -= entries.get(oldest)!.regions.length
        entries.delete(oldest)
      }
      return result
    },
    size(): number { return entries.size },
    clear(): void { entries.clear(); retainedRegions = 0 },
  }
}

export * as CacheRequestWitness from "./cache-request-witness"
