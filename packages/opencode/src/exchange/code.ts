import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import { CodeMode, Tool as CodeModeTool, ToolSchema, toolError } from "@opencode-ai/codemode"
import { HOST_LIMITS } from "@/code/execution"
import * as InputAdmission from "@/code/input-admission"
import { PreparedProgramCache } from "@/code/prepared"
import * as Revision from "@/code/revision"
import { rankCapabilities } from "./capability-search"

export const DESCRIPTION =
  "Stateless confined Code Mode over this external transport. Use search to discover exact transport capability refs, describe before guessing arguments, and run JavaScript/TypeScript that composes them through await call(ref, input). This surface has no ambient filesystem/process/network/import/credential authority; every leaf call is re-authorized by the transport. Durable replay/save/call belong to a real native OpenFork Session (for example ACP) and are intentionally not fabricated here."

const MAX_QUERY_CHARS = 4_096
const MAX_REF_CHARS = 4_096
const MAX_CURSOR_CHARS = 8_192

export const Fields = {
  action: Schema.Literals(["search", "describe", "run"]).annotate({
    description: "Operation: discover capability refs, inspect one exact contract, or run confined JavaScript/TypeScript.",
  }),
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(MAX_QUERY_CHARS))).annotate({ description: "search: optional broad query." }),
  ref: Schema.optional(Schema.String.check(Schema.isMaxLength(MAX_REF_CHARS))).annotate({ description: "describe: exact ref returned by search." }),
  limit: Schema.optional(Schema.Number).annotate({ description: "search: maximum results (default 8, maximum 25)." }),
  cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(MAX_CURSOR_CHARS))).annotate({ description: "search: opaque continuation cursor." }),
  code: Schema.optional(Schema.String).annotate({ description: "run: inline JavaScript/TypeScript source." }),
  input: Schema.optional(Schema.Unknown).annotate({ description: "run: JSON-safe program input; defaults to {}." }),
} as const

export const Parameters = Schema.Struct(Fields)
export type Parameters = typeof Parameters.Type

export type Summary = {
  readonly ref: string
  readonly description: string
}

export type Descriptor = Summary & {
  readonly inputSchema: unknown
  readonly outputSchema?: unknown
}

export type Attachment = {
  readonly kind: "file" | "resource"
  readonly handle: string
  readonly mediaType?: string
  readonly name?: string
  readonly bytes?: number
}

export type LeafResult = {
  readonly value: unknown
  readonly attachments?: readonly Attachment[]
  readonly mutation?: { readonly attempted: boolean; readonly committed: boolean }
}

export interface Host<E = unknown> {
  readonly list: () => Effect.Effect<readonly Summary[], E>
  /**
   * Optional source-owned ranking. A transport may know its actual action
   * names without advertising huge schemas or putting hidden metadata into
   * tool results. Ranking cannot introduce an undiscovered capability.
   */
  readonly rank?: (items: readonly Summary[], query: string) => readonly Summary[]
  readonly rankVersion?: string
  readonly describe: (ref: string) => Effect.Effect<Descriptor, E>
  readonly call: (ref: string, input: unknown) => Effect.Effect<LeafResult, E>
}

export class InvalidRequest extends Error {
  constructor(readonly detail: string) {
    super(detail)
    this.name = "ExternalCodeInvalidRequest"
  }
}

export function validate(input: Parameters) {
  const admission = InputAdmission.inspect(input)
  if (!admission.ok) throw new InvalidRequest(admission.reason.replaceAll("durable ", ""))

  switch (input.action) {
    case "search":
      if (input.ref !== undefined || input.code !== undefined || input.input !== undefined) {
        throw new InvalidRequest("code.search accepts only query, limit, and cursor.")
      }
      if (typeof input.query === "string" && input.query.length > MAX_QUERY_CHARS) {
        throw new InvalidRequest(`code.search query exceeds the ${MAX_QUERY_CHARS}-character limit.`)
      }
      if (typeof input.cursor === "string" && input.cursor.length > MAX_CURSOR_CHARS) {
        throw new InvalidRequest(`code.search cursor exceeds the ${MAX_CURSOR_CHARS}-character limit.`)
      }
      if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 25)) {
        throw new InvalidRequest("code.search limit must be an integer from 1 to 25.")
      }
      return input
    case "describe":
      if (!input.ref) throw new InvalidRequest("code.describe requires ref.")
      if (input.ref.length > MAX_REF_CHARS) {
        throw new InvalidRequest(`code.describe ref exceeds the ${MAX_REF_CHARS}-character limit.`)
      }
      if (input.query !== undefined || input.limit !== undefined || input.cursor !== undefined || input.code !== undefined || input.input !== undefined) {
        throw new InvalidRequest("code.describe accepts only ref.")
      }
      return input
    case "run":
      if (input.code === undefined) throw new InvalidRequest("code.run requires code.")
      if (input.query !== undefined || input.ref !== undefined || input.limit !== undefined || input.cursor !== undefined) {
        throw new InvalidRequest("code.run accepts only code and input.")
      }
      return input
  }
}

function generation(items: readonly Summary[], rankVersion?: string) {
  const hash = createHash("sha256")
  // A cursor is an offset in a *ranking*, not just a catalog snapshot. Invalidate
  // old offsets if ranking semantics change even when the refs stay identical.
  hash.update("ax-search-v5-intent-scaffolding\0")
  if (rankVersion !== undefined) hash.update(rankVersion).update("\0")
  for (const item of [...items].sort((a, b) => a.ref.localeCompare(b.ref))) {
    hash.update(item.ref).update("\0").update(item.description).update("\xff")
  }
  return `external-code:${hash.digest("hex")}`
}

function cursorScope(query: string | undefined) {
  return query?.trim().toLowerCase() ?? ""
}

function encodeCursor(generation: string, query: string | undefined, offset: number) {
  return Buffer.from(JSON.stringify({ generation, query: cursorScope(query), offset }), "utf8").toString("base64url")
}

function decodeCursor(value: string | undefined, expected: string, query: string | undefined) {
  if (!value) return 0
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      generation?: unknown
      query?: unknown
      offset?: unknown
    }
    if (
      parsed.generation !== expected ||
      parsed.query !== cursorScope(query) ||
      !Number.isSafeInteger(parsed.offset) ||
      Number(parsed.offset) < 0
    ) {
      throw new Error("stale")
    }
    return Number(parsed.offset)
  } catch {
    throw new InvalidRequest("code.search cursor is invalid or stale; restart discovery without cursor.")
  }
}

function signature(item: Descriptor) {
  const input = ToolSchema.jsonSchemaToTypeScript(item.inputSchema as CodeModeTool.JsonSchema, true)
  const output = item.outputSchema === undefined
    ? "unknown"
    : ToolSchema.jsonSchemaToTypeScript(item.outputSchema as CodeModeTool.JsonSchema, true)
  const ref = JSON.stringify(item.ref)
  return {
    signature: `declare function call(ref: ${ref}, input: ${input}): Promise<${output}>;`,
    example: `const result = await call(${ref}, /* input */)`,
  }
}

export function execute<E>(input: Parameters, host: Host<E>) {
  return Effect.gen(function* () {
    const params = yield* Effect.try({
      try: () => validate(input),
      catch: (cause) =>
        cause instanceof InvalidRequest
          ? cause
          : new InvalidRequest(cause instanceof Error ? cause.message : "Invalid external Code request."),
    })

    if (params.action === "search") {
      const all = yield* host.list()
      const currentGeneration = generation(all, host.rankVersion)
      const offset = yield* Effect.try({
        try: () => decodeCursor(params.cursor, currentGeneration, params.query),
        catch: (cause) =>
          cause instanceof InvalidRequest
            ? cause
            : new InvalidRequest(cause instanceof Error ? cause.message : "Invalid Code search cursor."),
      })
      const limit = params.limit ?? 8
      const ranked = host.rank
        ? host.rank(all, params.query ?? "")
        : rankCapabilities(all.map((item) => ({ id: item.ref, description: item.description, item })), params.query)
            .map(({ item }) => item)
      // Transport-provided rankings only order the very same advertised refs;
      // no shadow entries or additional root/session privileges may appear.
      const permitted = new Map(all.map((entry) => [entry.ref, entry]))
      const seen = new Set<string>()
      const items = ranked.flatMap((entry) => {
        const canonical = permitted.get(entry.ref)
        if (!canonical || seen.has(entry.ref)) return []
        seen.add(entry.ref)
        return [canonical]
      })
      const page = items.slice(offset, offset + limit)
      const nextOffset = offset + page.length
      return {
        ok: true as const,
        action: "search" as const,
        generation: currentGeneration,
        items: page,
        remaining: Math.max(0, items.length - nextOffset),
        next: nextOffset < items.length ? encodeCursor(currentGeneration, params.query, nextOffset) : null,
      }
    }

    if (params.action === "describe") {
      const item = yield* host.describe(params.ref!)
      return {
        ok: true as const,
        action: "describe" as const,
        item: {
          ...item,
          ...signature(item),
        },
      }
    }

    const source = Revision.canonicalSource(params.code!)
    const sourceHash = Revision.sha256(source)
    let prepared: CodeMode.PreparedProgram | undefined
    try {
      prepared = PreparedProgramCache.get(source, sourceHash)
    } catch {
      // Preserve normalized parser diagnostics by falling back to ordinary execute.
    }

    const attachments: Attachment[] = []
    let mutationAttempted = false
    let mutationCommitted = false
    const options = {
      input: params.input ?? {},
      call: (ref: string, value: unknown) =>
        host.call(ref, value).pipe(
          Effect.map((result) => {
            if (result.attachments?.length) attachments.push(...result.attachments)
            if (result.mutation?.attempted) mutationAttempted = true
            if (result.mutation?.committed) mutationCommitted = true
            return result.value
          }),
          Effect.mapError((cause) =>
            toolError(cause instanceof Error ? cause.message : "Capability call failed", cause),
          ),
        ),
      limits: HOST_LIMITS,
      budget: CodeMode.createExecutionBudget(HOST_LIMITS),
    }
    const result = yield* (prepared
      ? CodeMode.executePrepared(prepared, options)
      : CodeMode.execute({ ...options, code: source }))

    return {
      ...result,
      action: "run" as const,
      sourceHash,
      ...(attachments.length ? { attachments } : {}),
      ...(mutationAttempted || mutationCommitted
        ? { mutation: { attempted: mutationAttempted, committed: mutationCommitted } }
        : {}),
    }
  })
}

export * as ExternalCode from "./code"
