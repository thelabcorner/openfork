import type { Tool } from "ai"

type ToolMap = Record<string, Tool> | Readonly<Record<string, unknown>>
// Module-private capability marker. Do not use Symbol.for(): this must not be
// forgeable through the global symbol registry by unrelated plugins/runtime code.
const CANONICAL_FIND = Symbol("@opencode/session/llm/canonical-find")

export type HealedToolCall = {
  readonly name: string
  readonly input: unknown
  readonly healed: boolean
  readonly legacyName?: "glob" | "grep"
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function decodeInput(value: unknown): { value: Record<string, unknown>; encoded: boolean } | undefined {
  if (typeof value === "string") {
    try {
      const parsed = record(JSON.parse(value))
      return parsed ? { value: parsed, encoded: true } : undefined
    } catch {
      return undefined
    }
  }
  const parsed = record(value)
  return parsed ? { value: parsed, encoded: false } : undefined
}

function encodeInput(value: Record<string, unknown>, encoded: boolean): unknown {
  return encoded ? JSON.stringify(value) : value
}

function hasTool(tools: ToolMap, name: string) {
  return Object.prototype.hasOwnProperty.call(tools, name)
}

function hasToolCaseInsensitive(tools: ToolMap, name: string) {
  const lower = name.toLowerCase()
  return Object.keys(tools).some((candidate) => candidate.toLowerCase() === lower)
}

function owns(value: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

export function markCanonicalFindToolMap<T extends ToolMap>(tools: T): T {
  Object.defineProperty(tools, CANONICAL_FIND, { value: true, configurable: true })
  return tools
}

export function isCanonicalFindToolMap(tools: ToolMap) {
  return (tools as ToolMap & { [CANONICAL_FIND]?: boolean })[CANONICAL_FIND] === true
}

export function preserveCanonicalFindToolMap<T extends ToolMap>(source: ToolMap, target: T): T {
  if (isCanonicalFindToolMap(source) && hasTool(target, "find")) markCanonicalFindToolMap(target)
  return target
}

/**
 * Compatibility-only tool-call repair. These aliases are deliberately absent
 * from the provider manifest; they exist solely to recover model calls learned
 * against upstream OpenCode's historical glob/grep schemas.
 *
 * Upstream wire shapes:
 *   glob({ pattern, path? })
 *   grep({ pattern, path?, include? })
 *
 * Canonical local shape:
 *   find({ glob: pattern, path? })
 *   find({ grep: pattern, path?, include? })
 */
export function healLegacyFindCall(name: string, input: unknown, tools: ToolMap): HealedToolCall {
  if (!hasTool(tools, "find") || !isCanonicalFindToolMap(tools)) return { name, input, healed: false }

  const lower = name.toLowerCase()
  if (lower !== "glob" && lower !== "grep") return { name, input, healed: false }

  // Never shadow a real registered tool, including arbitrary casing variants.
  if (hasToolCaseInsensitive(tools, lower)) return { name, input, healed: false }

  const decoded = decodeInput(input)
  if (!decoded) return { name, input, healed: false }
  const source = decoded.value
  const allowed = lower === "glob" ? new Set(["pattern", "path"]) : new Set(["pattern", "path", "include"])
  if (Object.keys(source).some((key) => !allowed.has(key))) return { name, input, healed: false }
  if (!owns(source, "pattern") || typeof source.pattern !== "string" || source.pattern.length === 0) {
    return { name, input, healed: false }
  }
  const path = owns(source, "path") ? source.path : undefined
  const include = owns(source, "include") ? source.include : undefined
  if (path !== undefined && typeof path !== "string") return { name, input, healed: false }
  if (lower === "grep" && include !== undefined && typeof include !== "string") {
    return { name, input, healed: false }
  }

  const translated: Record<string, unknown> = {
    [lower]: source.pattern,
    ...(path !== undefined ? { path } : {}),
    ...(lower === "grep" && include !== undefined ? { include } : {}),
  }
  return {
    name: "find",
    input: encodeInput(translated, decoded.encoded),
    healed: true,
    legacyName: lower,
  }
}

export function healLegacyFindToolCall<T extends { readonly name: string; readonly input: unknown }>(
  call: T,
  tools: ToolMap,
): T & HealedToolCall {
  const healed = healLegacyFindCall(call.name, call.input, tools)
  return { ...call, ...healed }
}
