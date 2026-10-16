/**
 * LACE v14.7 read-only AI SDK observation at the post-transform LanguageModelV3
 * boundary. This is a *pre-provider-SDK* semantic witness, NOT HTTP wire bytes,
 * tokenizer equality, cache residency, or a provider's internal cache key.
 *
 * Keep independent from @opencode-ai/llm native-body witnesses: the SDK owns
 * another serialization pass that we cannot claim to observe here.
 */
import { createHash, randomBytes } from "node:crypto"
import { laceObservePolicy } from "./lace-observation-policy"

const SALT = randomBytes(32)
const MAX_BYTES = 1024 * 1024
const MAX_NODES = 16_384
const MAX_DEPTH = 40
const MAX_MESSAGES = 8192
const MAX_RETAINED_MESSAGES = 16_384

export type LaceSDKObservation =
  | {
      readonly status: "observed"
      readonly kind:
        | "first"
        | "identical"
        | "extended"
        | "rewritten"
        | "tools-changed"
        | "options-changed"
        | "domain-changed"
      readonly commonMessages: number
      readonly messageCount: number
    }
  | { readonly status: "invalid-owner" | "unsupported-shape" | "observation-unavailable" }

export interface LaceSDKRequest {
  readonly owner: string
  readonly session: string
  readonly provider: string
  readonly model: string
  readonly route: string
  /** Post-transform prompt passed to the AI SDK provider interface. */
  readonly prompt: unknown
  /** Post-transform V3 provider tool definitions. */
  readonly tools: unknown
  /** Only data fields that can influence provider protocol lowering; not headers. */
  readonly options?: unknown
}

export function laceObserveAIEnabled(sessionID: string, env: Readonly<Record<string, string | undefined>>) {
  if (env.OPENFORK_LACE_OBSERVE_AI_SDK !== "1") return false
  return laceObservePolicy(sessionID, {
    OPENFORK_LACE_OBSERVE_NATIVE: "1",
    OPENFORK_LACE_OBSERVE_EVERY: env.OPENFORK_LACE_OBSERVE_EVERY,
  })
}

function fingerprint(value: unknown): string {
  const h = createHash("sha256").update(SALT)
  const visited = new WeakSet<object>()
  let bytes = 0
  let nodes = 0
  const write = (s: string) => {
    bytes += Buffer.byteLength(s, "utf8")
    if (bytes > MAX_BYTES) throw new RangeError("AI SDK witness budget exceeded")
    h.update(s, "utf8")
  }
  const traverse = (x: unknown, depth: number): void => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new RangeError("AI SDK witness structure bound")
    if (x === null) {
      write("n;")
      return
    }
    switch (typeof x) {
      case "string":
        write("s" + x.length + ":")
        write(x)
        return
      case "number":
        if (!Number.isFinite(x)) throw new TypeError("nonfinite value")
        write("d" + String(x) + ";")
        return
      case "boolean":
        write(x ? "t;" : "f;")
        return
      case "undefined":
        write("u;")
        return
      case "bigint":
      case "symbol":
      case "function":
        throw new TypeError("unsupported provider parameter")
    }
    if (visited.has(x)) throw new TypeError("cyclic provider parameter")
    visited.add(x)
    try {
      if (x instanceof Uint8Array) {
        bytes += x.byteLength
        if (bytes > MAX_BYTES) throw new RangeError("binary witness budget exceeded")
        write("b" + x.byteLength + ":")
        h.update(x)
        return
      }
      if (Array.isArray(x)) {
        write("a" + x.length + ":")
        for (const item of x) traverse(item, depth + 1)
        return
      }
      const proto = Object.getPrototypeOf(x)
      if (proto !== null && proto !== Object.prototype) throw new TypeError("unsupported provider object")
      const record = x as Record<string, unknown>
      const keys = Object.keys(record).sort()
      write("o" + keys.length + ":")
      for (const key of keys) {
        write("k" + key.length + ":")
        write(key)
        traverse(record[key], depth + 1)
      }
    } finally {
      visited.delete(x)
    }
  }
  traverse(value, 0)
  return h.digest("hex")
}

export function createLaceAISdkObserver(capacity = 128) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4096)
    throw new RangeError("invalid observer capacity")
  type Previous = { domain: string; tools: string; options: string; messages: readonly string[] }
  const observed = new Map<string, Previous>()
  let retainedMessages = 0
  function observe(input: LaceSDKRequest): LaceSDKObservation {
    if (!input.owner || !input.session || !input.provider || !input.model || !input.route) {
      return { status: "invalid-owner" }
    }
    if (!Array.isArray(input.prompt) || input.prompt.length > MAX_MESSAGES) {
      return { status: "unsupported-shape" }
    }
    try {
      const key = fingerprint([input.owner, input.session])
      const domain = fingerprint([input.provider, input.model, input.route])
      const tools = fingerprint(input.tools)
      const options = fingerprint(input.options)
      const messages = input.prompt.map((item) => fingerprint(item))
      const previous = observed.get(key)
      let kind: Extract<LaceSDKObservation, { status: "observed" }>["kind"] = "first"
      let commonMessages = 0
      if (previous) {
        const length = Math.min(previous.messages.length, messages.length)
        while (commonMessages < length && previous.messages[commonMessages] === messages[commonMessages]) {
          commonMessages++
        }
        if (previous.domain !== domain) kind = "domain-changed"
        else if (previous.tools !== tools) kind = "tools-changed"
        else if (previous.options !== options) kind = "options-changed"
        else if (commonMessages < length || messages.length < previous.messages.length) kind = "rewritten"
        else if (messages.length > previous.messages.length) kind = "extended"
        else kind = "identical"
      }
      if (previous) {
        retainedMessages -= previous.messages.length
        observed.delete(key)
      }
      observed.set(key, { domain, tools, options, messages })
      retainedMessages += messages.length
      while (observed.size > capacity || retainedMessages > MAX_RETAINED_MESSAGES) {
        const oldest = observed.keys().next().value!
        retainedMessages -= observed.get(oldest)!.messages.length
        observed.delete(oldest)
      }
      return { status: "observed", kind, commonMessages, messageCount: messages.length }
    } catch {
      // Always fail open for observation, never for authorization or provider dispatch.
      return { status: "observation-unavailable" }
    }
  }
  return {
    observe,
    size: () => observed.size,
    retained: () => retainedMessages,
    clear: () => {
      observed.clear()
      retainedMessages = 0
    },
  }
}
