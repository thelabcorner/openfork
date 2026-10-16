import type { JSONSchema7 } from "@ai-sdk/provider"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Effect } from "effect"
import type * as Tool from "./tool"

export type Kind = "native" | "lazy" | "mcp" | "mcp-resource" | "saved"
export type Lifetime = "inline" | "durable"

export interface Identity {
  /**
   * Authoritative unescaped identity. Never reconstruct this from a rendered
   * path, sanitized MCP key, or provider-facing alias.
   */
  readonly segments: readonly string[]
  /**
   * Collision-free internal map key. Opaque outside the capability owner.
   */
  readonly key: string
  /**
   * Canonical paste-ready selector returned by discovery and accepted by Code.
   */
  readonly ref: string
  /**
   * Optional presentation only. Never an authority or lookup identity.
   */
  readonly renderedPath?: string
}

export interface InvocationAuthority {
  readonly ruleset: PermissionV1.Ruleset
  readonly executionID?: string
}

export type Executor = (
  args: unknown,
  ctx: Tool.Context,
) => Effect.Effect<Tool.ExecuteResult, Tool.Failure>

export interface Registration {
  readonly identity: Identity
  readonly kind: Kind
  readonly description: string
  readonly inputSchema: JSONSchema7
  readonly outputSchema?: JSONSchema7
  readonly permissionKey?: string
  readonly delegatesTo?: readonly string[]
  readonly invokeSemantic: Executor
  readonly authorize: (input: {
    readonly authority: InvocationAuthority
    readonly args: unknown
    /** Derived leaf context for authority checks that require root-local state. */
    readonly context?: Tool.Context
  }) => Effect.Effect<void, Tool.Failure>
  readonly authorityBinding: string
  readonly classifyWorkspaceMutation: (args: unknown) => boolean
  readonly codeCallable: boolean
  readonly lifetime: Lifetime
  readonly revision?: string
  readonly diagnostic?: { readonly kind: string; readonly message: string }
}

export interface Inventory {
  readonly generation: string
  /**
   * Content-derived identity of the compact search-visible descriptor set.
   * Production inventories provide this so ranking work can be reused across
   * separately reconstructed snapshots without retaining execution closures.
   */
  readonly searchGeneration?: string
  readonly entries: readonly Registration[]
  /** Precomputed exact-ref index for hot describe/invocation lookup. */
  readonly byRef?: ReadonlyMap<string, Registration>
}

const fallbackIndexes = new WeakMap<Inventory, ReadonlyMap<string, Registration>>()

export function lookup(inventory: Inventory, ref: string): Registration | undefined {
  if (inventory.byRef) return inventory.byRef.get(ref)
  let index = fallbackIndexes.get(inventory)
  if (!index) {
    index = new Map(inventory.entries.map((entry) => [entry.identity.ref, entry] as const))
    fallbackIndexes.set(inventory, index)
  }
  return index.get(ref)
}

const unreserved = (byte: number) =>
  (byte >= 0x41 && byte <= 0x5a) ||
  (byte >= 0x61 && byte <= 0x7a) ||
  (byte >= 0x30 && byte <= 0x39) ||
  byte === 0x2d ||
  byte === 0x2e ||
  byte === 0x5f ||
  byte === 0x7e

const hex = "0123456789ABCDEF"

/**
 * Canonical RFC-3986-unreserved segment encoding.
 *
 * This intentionally does not use MCP/provider sanitization. Every byte outside
 * the unreserved ASCII set is UTF-8 percent encoded with uppercase hex.
 */
export function encodeSegment(value: string) {
  const bytes = new TextEncoder().encode(value)
  let result = ""
  for (const byte of bytes) {
    if (unreserved(byte)) {
      result += String.fromCharCode(byte)
      continue
    }
    result += "%" + hex[(byte >> 4) & 0x0f] + hex[byte & 0x0f]
  }
  return result
}

function fromHex(code: number) {
  if (code >= 0x30 && code <= 0x39) return code - 0x30
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10
  return -1
}

/**
 * Decode one canonical segment and reject alternate/non-canonical spellings.
 * That gives exact refs one representation and prevents ambiguous cache/index
 * keys (for example lowercase escapes or raw reserved delimiters).
 */
export function decodeSegment(value: string) {
  const bytes: number[] = []
  for (let index = 0; index < value.length; ) {
    const code = value.charCodeAt(index)
    if (code === 0x25) {
      if (index + 2 >= value.length) throw new Error("Incomplete percent escape in capability ref")
      const high = fromHex(value.charCodeAt(index + 1))
      const low = fromHex(value.charCodeAt(index + 2))
      if (high < 0 || low < 0) throw new Error("Capability ref percent escapes must use uppercase hex")
      bytes.push((high << 4) | low)
      index += 3
      continue
    }

    if (code > 0x7f || !unreserved(code)) {
      throw new Error("Capability ref segment contains an unescaped reserved byte")
    }
    bytes.push(code)
    index++
  }

  let decoded: string
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes))
  } catch {
    throw new Error("Capability ref contains invalid UTF-8")
  }
  if (encodeSegment(decoded) !== value) throw new Error("Capability ref segment is not canonical")
  return decoded
}

function key(namespace: string, segments: readonly string[]) {
  // JSON string encoding is length/escape preserving for string arrays and keeps
  // namespace changes distinct without inventing another delimiter protocol.
  return JSON.stringify([namespace, ...segments])
}

function identity(namespace: string, segments: readonly string[], ref: string, renderedPath?: string): Identity {
  return Object.freeze({
    segments: Object.freeze([...segments]),
    key: key(namespace, segments),
    ref,
    ...(renderedPath ? { renderedPath } : {}),
  })
}

export function nativeIdentity(id: string): Identity {
  if (!id) throw new Error("Native capability id cannot be empty")
  return identity("native", [id], `native:${encodeSegment(id)}`)
}

export function mcpIdentity(server: string, tool: string): Identity {
  if (!server || !tool) throw new Error("MCP server and tool names cannot be empty")
  return identity("mcp", [server, tool], `mcp:${encodeSegment(server)}/${encodeSegment(tool)}`)
}

export function mcpResourceIdentity(operation: string): Identity {
  if (!operation) throw new Error("MCP resource operation cannot be empty")
  return identity("mcp-resource", [operation], `mcp-resource:${encodeSegment(operation)}`)
}

export type SavedScope = "project" | "global"

export function savedIdentity(scope: SavedScope, id: string, revision: string): Identity {
  if (!id) throw new Error("Saved capability id cannot be empty")
  if (!revision.startsWith("sha256:") || revision.length === "sha256:".length) {
    throw new Error("Saved capability revision must use sha256:<digest> form")
  }
  const digest = revision.slice("sha256:".length)
  const segments = [scope, id, revision] as const
  const ref = `saved:${scope}/${encodeSegment(id)}@sha256:${encodeSegment(digest)}`
  return identity("saved", segments, ref)
}

export function identityFromRef(ref: string): Identity {
  if (ref.startsWith("native:")) {
    const encoded = ref.slice("native:".length)
    if (!encoded || encoded.includes("/")) throw new Error("Invalid native capability ref")
    const id = decodeSegment(encoded)
    const result = nativeIdentity(id)
    if (result.ref !== ref) throw new Error("Capability ref is not canonical")
    return result
  }

  if (ref.startsWith("mcp:")) {
    const body = ref.slice("mcp:".length)
    const slash = body.indexOf("/")
    if (slash <= 0 || slash !== body.lastIndexOf("/") || slash === body.length - 1) {
      throw new Error("Invalid MCP capability ref")
    }
    const result = mcpIdentity(decodeSegment(body.slice(0, slash)), decodeSegment(body.slice(slash + 1)))
    if (result.ref !== ref) throw new Error("Capability ref is not canonical")
    return result
  }

  if (ref.startsWith("mcp-resource:")) {
    const encoded = ref.slice("mcp-resource:".length)
    if (!encoded || encoded.includes("/")) throw new Error("Invalid MCP resource capability ref")
    const result = mcpResourceIdentity(decodeSegment(encoded))
    if (result.ref !== ref) throw new Error("Capability ref is not canonical")
    return result
  }

  if (ref.startsWith("saved:")) {
    const body = ref.slice("saved:".length)
    const slash = body.indexOf("/")
    if (slash <= 0 || slash !== body.lastIndexOf("/")) throw new Error("Invalid saved capability ref")
    const scope = body.slice(0, slash)
    if (scope !== "project" && scope !== "global") throw new Error("Invalid saved capability scope")

    const rest = body.slice(slash + 1)
    const marker = "@sha256:"
    const markerIndex = rest.indexOf(marker)
    if (markerIndex <= 0 || markerIndex !== rest.lastIndexOf(marker) || markerIndex + marker.length === rest.length) {
      throw new Error("Invalid saved capability ref")
    }
    const result = savedIdentity(
      scope,
      decodeSegment(rest.slice(0, markerIndex)),
      `sha256:${decodeSegment(rest.slice(markerIndex + marker.length))}`,
    )
    if (result.ref !== ref) throw new Error("Capability ref is not canonical")
    return result
  }

  throw new Error("Unknown capability ref namespace")
}

