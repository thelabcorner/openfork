import { Schema } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import * as Core from "@/tool/json/core"

export const Parameters = Schema.Struct({
  mode: Schema.optional(
    Schema.Literals(["validate", "scaffold", "query", "search", "schema", "format", "patch", "diff", "stats"]),
  ).annotate({ description: "Operation to run (default: scaffold)" }),
  filePath: Schema.optional(Schema.String).annotate({
    description: "JSON file path relative to the working directory (or absolute). Optional if jsonText is provided.",
  }),
  jsonText: Schema.optional(Schema.String).annotate({
    description: "Raw JSON text input. Prefer filePath for large JSON.",
  }),
  compareFilePath: Schema.optional(Schema.String).annotate({
    description: "Second JSON file path for diff mode.",
  }),
  compareJsonText: Schema.optional(Schema.String).annotate({
    description: "Second raw JSON text for diff mode.",
  }),
  path: Schema.optional(Schema.String).annotate({
    description: "JSONPath for query mode, e.g. $.users[0].name.",
  }),
  query: Schema.optional(Schema.String).annotate({
    description: "Search query for key/value text in search mode.",
  }),
  type: Schema.optional(Schema.Literals(["object", "array", "string", "number", "boolean", "null"])).annotate({
    description: "Search by JSON value type in search mode.",
  }),
  patch: Schema.optional(Schema.Array(Schema.Unknown)).annotate({
    description: "RFC6902-style patch operations: add, replace, remove, copy, move, test.",
  }),
  indent: Schema.optional(NonNegativeInt).annotate({
    description: "Pretty print indent for format/patch output. Use 0 for minified output.",
  }),
  sortKeys: Schema.optional(Schema.Boolean).annotate({
    description: "Sort object keys recursively for stable output.",
  }),
  dryRun: Schema.optional(Schema.Boolean).annotate({
    description: "Default true for write modes (format/patch). false applies the change after write authorization.",
  }),
  maxBytes: Schema.optional(NonNegativeInt).annotate({ description: "Maximum JSON input size in bytes." }),
  maxDepth: Schema.optional(NonNegativeInt).annotate({ description: "Maximum scaffold depth." }),
  maxObjectKeys: Schema.optional(NonNegativeInt).annotate({ description: "Maximum object keys shown per node." }),
  maxArrayItems: Schema.optional(NonNegativeInt).annotate({ description: "Maximum array items shown per node." }),
  maxNodes: Schema.optional(NonNegativeInt).annotate({ description: "Maximum scaffold nodes." }),
  maxResults: Schema.optional(NonNegativeInt).annotate({ description: "Maximum search results." }),
})
export type Input = Schema.Schema.Type<typeof Parameters>

export type Metadata = {
  mode: string
  source: string
  ok?: boolean
  bytes?: number
  nodes?: number
  found?: boolean
  count?: number
  ops?: number
  written?: boolean
  beforeHash?: string
  afterHash?: string
  preview?: string
}

export interface Document {
  readonly raw: Uint8Array
  readonly source: string
  readonly fileHint?: string
  readonly writable: boolean
}

export interface WritePlan {
  readonly content: string | Uint8Array
  readonly beforeHash: string
  readonly afterHash: string
}

export interface Result {
  readonly title: string
  readonly output: string
  readonly metadata: Metadata
  readonly write?: WritePlan
}

function outputPreview(text: string, maxBytes = 120_000): { text: string; truncated: boolean; bytes: number } {
  const bytes = Buffer.byteLength(text, "utf8")
  if (bytes <= maxBytes) return { text, truncated: false, bytes }
  return { text: text.slice(0, maxBytes) + `\n… truncated at ${maxBytes} bytes`, truncated: true, bytes }
}

export function limits(input: Input) {
  return {
    ...Core.DEFAULT_LIMITS,
    maxBytes: input.maxBytes ?? Core.DEFAULT_LIMITS.maxBytes,
    maxDepth: input.maxDepth ?? Core.DEFAULT_LIMITS.maxDepth,
    maxObjectKeys: input.maxObjectKeys ?? Core.DEFAULT_LIMITS.maxObjectKeys,
    maxArrayItems: input.maxArrayItems ?? Core.DEFAULT_LIMITS.maxArrayItems,
    maxNodes: input.maxNodes ?? Core.DEFAULT_LIMITS.maxNodes,
    maxSearchResults: input.maxResults ?? Core.DEFAULT_LIMITS.maxSearchResults,
  }
}

export function execute(input: Input, document: Document, compare?: Document): Result {
  const mode = input.mode ?? "scaffold"
  const currentLimits = limits(input)
  if (document.raw.byteLength > currentLimits.maxBytes) {
    throw new Error(`JSON input exceeds maxBytes (${document.raw.byteLength} > ${currentLimits.maxBytes})`)
  }

  const source = document.source
  const beforeHash = Core.hashText(document.raw)
  const parsed = Core.parseJsonWithDiagnostics(document.raw, document.fileHint)
  if (!parsed.ok) {
    return {
      title: "json validation failed",
      output: Core.validationXml(parsed, source),
      metadata: { mode: "validate", source, ok: false, preview: parsed.error.slice(0, 500) },
    }
  }
  const value = parsed.value
  const inputFormat = (parsed as { format?: string }).format || "json"

  if (mode === "validate") {
    return {
      title: "json validate",
      output: Core.validationXml(parsed, source),
      metadata: { mode, source, ok: true, bytes: parsed.bytes },
    }
  }

  if (mode === "scaffold") {
    const scaffold = Core.buildScaffold(value, currentLimits)
    const output = Core.scaffoldToXml(scaffold, { source, bytes: parsed.bytes, parseMs: parsed.parseMs })
    return {
      title: "json scaffold",
      output,
      metadata: { mode, source, nodes: scaffold.stats.nodes, preview: output.slice(0, 500) },
    }
  }

  if (mode === "stats") {
    const scaffold = Core.buildScaffold(value, {
      ...currentLimits,
      maxDepth: Math.min(currentLimits.maxDepth, 6),
      maxNodes: Math.min(currentLimits.maxNodes, 500),
    })
    const output = [
      `<json-stats source="${Core.escapeXml(source)}" bytes="${parsed.bytes}" parseMs="${parsed.parseMs.toFixed(3)}" hash="${beforeHash}">`,
      `  <root type="${Core.typeOfJson(value)}" />`,
      `  <nodes total="${scaffold.stats.nodes}" objects="${scaffold.stats.objects}" arrays="${scaffold.stats.arrays}" primitives="${scaffold.stats.primitives}" maxDepth="${scaffold.stats.maxDepthSeen}" truncated="${scaffold.stats.truncatedNodes}" />`,
      "</json-stats>",
    ].join("\n")
    return {
      title: "json stats",
      output,
      metadata: { mode, source, nodes: scaffold.stats.nodes, preview: output.slice(0, 500) },
    }
  }

  if (mode === "query") {
    const targetPath = input.path ?? "$"
    const hit = Core.getAtPath(value, targetPath)
    if (!hit.found) {
      const output = `<json-query path="${Core.escapeXml(targetPath)}" found="false" />`
      return { title: "json query", output, metadata: { mode, source, found: false, preview: output } }
    }
    const preview = outputPreview(JSON.stringify(hit.value, null, 2))
    const output = [
      `<json-query path="${Core.escapeXml(targetPath)}" found="true" type="${Core.typeOfJson(hit.value)}" bytes="${preview.bytes}" truncated="${preview.truncated}">`,
      `<value>\n${Core.escapeXml(preview.text)}\n</value>`,
      "</json-query>",
    ].join("\n")
    return {
      title: "json query",
      output,
      metadata: { mode, source, found: true, preview: output.slice(0, 500) },
    }
  }

  if (mode === "search") {
    const results = Core.searchJson(value, input.query ?? "", {
      type: input.type,
      maxResults: currentLimits.maxSearchResults,
    })
    const output = Core.searchResultsToXml(results, input.query ?? input.type ?? "")
    return {
      title: "json search",
      output,
      metadata: { mode, source, count: results.length, preview: output.slice(0, 500) },
    }
  }

  if (mode === "schema") {
    const schema = Core.inferJsonSchema(value, {
      maxArrayItems: currentLimits.maxArrayItems * 4,
      maxObjectKeys: currentLimits.maxObjectKeys * 4,
    })
    const text = Core.stableStringify(schema, 2, true)
    const output = `<json-schema source="${Core.escapeXml(source)}">\n${Core.escapeXml(text)}\n</json-schema>`
    return { title: "json schema", output, metadata: { mode, source, preview: output.slice(0, 500) } }
  }

  if (mode === "format") {
    const indent = input.indent === 0 ? 0 : input.indent ?? 2
    const nextContent = Core.stringifyForFormat(value, inputFormat, indent, Boolean(input.sortKeys))
    const isBin = inputFormat === "bson"
    const nextForWrite = isBin ? Core.bsonSerialize(value) : nextContent
    const nextHash = Core.hashText(nextForWrite)
    const written = document.writable && input.dryRun === false
    const note = !document.writable
      ? "jsonText input; no file write possible"
      : written
        ? "write applied after authorization and commit-time revalidation"
        : "dry run; no file was written. Re-run with dryRun:false to apply."
    const nextBytes =
      typeof nextForWrite === "string" ? Buffer.byteLength(nextForWrite, "utf8") : nextForWrite.byteLength
    const previewText = isBin ? `[binary BSON, ${nextBytes} bytes]` : nextContent
    const preview = outputPreview(previewText)
    const output = [
      `<json-format source="${Core.escapeXml(source)}" written="${written}" beforeHash="${beforeHash}" afterHash="${nextHash}" bytes="${preview.bytes}" truncated="${preview.truncated}">`,
      `  <note>${Core.escapeXml(note)}</note>`,
      `  <preview>\n${Core.escapeXml(preview.text)}\n  </preview>`,
      "</json-format>",
    ].join("\n")
    return {
      title: "json format",
      output,
      metadata: { mode, source, written, beforeHash, afterHash: nextHash, preview: output.slice(0, 500) },
      ...(written ? { write: { content: nextForWrite, beforeHash, afterHash: nextHash } } : {}),
    }
  }

  if (mode === "patch") {
    const ops = input.patch ?? []
    if (!Array.isArray(ops) || ops.length === 0) throw new Error("patch mode requires a non-empty patch array")
    const nextValue = Core.applyJsonPatch(value, ops)
    const nextContent = Core.stringifyForFormat(nextValue, inputFormat, input.indent ?? 2, Boolean(input.sortKeys))
    const isBin = inputFormat === "bson"
    const nextForWrite = isBin ? Core.bsonSerialize(nextValue) : nextContent
    const nextHash = Core.hashText(nextForWrite)
    const written = document.writable && input.dryRun === false
    const note = !document.writable
      ? "jsonText input; no file write possible"
      : written
        ? "write applied after authorization and commit-time revalidation"
        : "dry run; no file was written. Re-run with dryRun:false to apply."
    const output = [
      `<json-patch source="${Core.escapeXml(source)}" ops="${ops.length}" written="${written}" beforeHash="${beforeHash}" afterHash="${nextHash}">`,
      `  <note>${Core.escapeXml(note)}</note>`,
      ...ops.map(
        (op, index) =>
          `  <op index="${index + 1}" kind="${Core.escapeXml((op as { op?: unknown }).op)}" path="${Core.escapeXml((op as { path?: unknown }).path)}" />`,
      ),
      "</json-patch>",
    ].join("\n")
    return {
      title: "json patch",
      output,
      metadata: {
        mode,
        source,
        ops: ops.length,
        written,
        beforeHash,
        afterHash: nextHash,
        preview: output.slice(0, 500),
      },
      ...(written ? { write: { content: nextForWrite, beforeHash, afterHash: nextHash } } : {}),
    }
  }

  if (mode === "diff") {
    if (!compare) throw new Error("diff mode requires compareFilePath or compareJsonText")
    if (compare.raw.byteLength > currentLimits.maxBytes) {
      throw new Error(`JSON compare input exceeds maxBytes (${compare.raw.byteLength} > ${currentLimits.maxBytes})`)
    }
    const otherParsed = Core.parseJsonWithDiagnostics(compare.raw, compare.fileHint)
    if (!otherParsed.ok) {
      return {
        title: "json compare validation failed",
        output: Core.validationXml(otherParsed, compare.source),
        metadata: { mode: "diff", source, ok: false, preview: otherParsed.error.slice(0, 500) },
      }
    }
    const diffs = Core.diffJson(value, otherParsed.value, { maxDiffs: currentLimits.maxDiffs })
    const output = Core.diffToXml(diffs)
    return {
      title: "json diff",
      output,
      metadata: { mode, source, count: diffs.length, preview: output.slice(0, 500) },
    }
  }

  throw new Error(`Unsupported mode: ${mode}`)
}

export * as JsonEngine from "./engine"
