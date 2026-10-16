/**
 * OXP tools/list pagination, independent of execution/Session services.
 *
 * Canonical generated tools are identity-cached. The modern MCP-era catalog
 * must never be rehashed on a warm tools/list request. The approved immutable
 * legacy projection is registered only by our stateless protocol factory.
 *
 * Arbitrary caller-provided tools remain uncached because a shallow frozen
 * array may still contain mutable nested schemas and stale cursors must fail.
 */
import { createHash } from "node:crypto"
import type { Tool } from "@modelcontextprotocol/server"
import { OXP_STATIC_TRANSPORT } from "./transport-manifest"
import { canonicalTransportJson } from "./transport-canonical"

const DEFAULT_PAGE_BYTES = 2 * 1024 * 1024

interface Cursor {
  readonly v: 1
  readonly offset: number
  readonly fingerprint: string
}
interface Projection {
  readonly ordered: readonly Tool[]
  readonly costs: readonly number[]
  readonly fingerprint: string
}

const legacyProjections = new WeakMap<readonly Tool[], Projection>()
let fixed: Projection | undefined

function fingerprintOf(tools: readonly Tool[]) {
  return createHash("sha256")
    .update(canonicalTransportJson([...tools].sort((a, b) => a.name.localeCompare(b.name))))
    .digest("hex")
}

function projection(tools: readonly Tool[], fingerprint: string): Projection {
  const ordered = [...tools].sort((a, b) => a.name.localeCompare(b.name))
  return {
    ordered,
    costs: ordered.map((tool) => Buffer.byteLength(JSON.stringify(tool), "utf8") + 1),
    fingerprint,
  }
}

export function registerLegacyManifest(tools: readonly Tool[]): readonly Tool[] {
  // This is called only for immutable outputSchema-wrapped server tools.
  // Unlike untrusted custom arrays, their schema content cannot mutate.
  legacyProjections.set(tools, projection(tools, fingerprintOf(tools)))
  return tools
}

function decodeCursor(value: string | undefined, fingerprint: string, length: number) {
  if (value === undefined) return 0
  if (value.length > 1024) throw new Error("Invalid tools/list cursor")
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<Cursor>
    if (
      parsed.v !== 1 ||
      parsed.fingerprint !== fingerprint ||
      !Number.isSafeInteger(parsed.offset) ||
      (parsed.offset ?? -1) < 0 ||
      (parsed.offset ?? 0) > length
    ) throw new Error("stale")
    return parsed.offset!
  } catch {
    throw new Error("Invalid or stale tools/list cursor; restart discovery from the first page")
  }
}

export function paginateToolList(
  tools: readonly Tool[],
  cursor?: string,
  byteBudget = DEFAULT_PAGE_BYTES,
): { readonly tools: Tool[]; readonly nextCursor?: string } {
  const cached = tools === OXP_STATIC_TRANSPORT.tools
    ? (fixed ??= projection(tools, OXP_STATIC_TRANSPORT.fingerprint))
    : legacyProjections.get(tools)
  const ordered = cached?.ordered ?? [...tools].sort((a, b) => a.name.localeCompare(b.name))
  const fingerprint = cached?.fingerprint ?? fingerprintOf(ordered)
  const offset = decodeCursor(cursor, fingerprint, ordered.length)
  const budget = Math.max(1, Math.floor(byteBudget))
  const page: Tool[] = []
  let bytes = 0
  let index = offset
  while (index < ordered.length) {
    const tool = ordered[index]!
    const cost = cached?.costs[index] ?? Buffer.byteLength(JSON.stringify(tool), "utf8") + 1
    if (page.length > 0 && bytes + cost > budget) break
    page.push(tool)
    bytes += cost
    index++
  }
  return {
    tools: page,
    ...(index < ordered.length
      ? { nextCursor: Buffer.from(JSON.stringify({ v: 1, offset: index, fingerprint }), "utf8").toString("base64url") }
      : {}),
  }
}
