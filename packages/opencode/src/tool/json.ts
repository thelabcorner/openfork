import { Effect, Schema } from "effect"
import path from "path"
import fs from "node:fs/promises"
import * as Tool from "./tool"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { createTwoFilesPatch } from "diff"
import { trimDiff } from "./edit"
import * as Core from "./json/core"
import DESCRIPTION from "./json.txt"

export const Parameters = Schema.Struct({
  mode: Schema.optional(Schema.Literals(["validate", "scaffold", "query", "search", "schema", "format", "patch", "diff", "stats"])).annotate({
    description: "Operation to run (default: scaffold)",
  }),
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
    description: "Default true for write modes (format/patch). false applies the change after a write permission prompt.",
  }),
  maxBytes: Schema.optional(NonNegativeInt).annotate({ description: "Maximum JSON input size in bytes." }),
  maxDepth: Schema.optional(NonNegativeInt).annotate({ description: "Maximum scaffold depth." }),
  maxObjectKeys: Schema.optional(NonNegativeInt).annotate({ description: "Maximum object keys shown per node." }),
  maxArrayItems: Schema.optional(NonNegativeInt).annotate({ description: "Maximum array items shown per node." }),
  maxNodes: Schema.optional(NonNegativeInt).annotate({ description: "Maximum scaffold nodes." }),
  maxResults: Schema.optional(NonNegativeInt).annotate({ description: "Maximum search results." }),
})

type JsonInput = {
  text?: string
  raw?: Buffer
  source: string
  abs: string
  rel: string
}

type JsonMeta = {
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

function outputPreview(text: string, maxBytes = 120_000): { text: string; truncated: boolean; bytes: number } {
  const bytes = Buffer.byteLength(text, "utf8")
  if (bytes <= maxBytes) return { text, truncated: false, bytes }
  return { text: text.slice(0, maxBytes) + `\n… truncated at ${maxBytes} bytes`, truncated: true, bytes }
}

const readJsonInput = Effect.fn("JsonTool.readInput")(function* (
  ctx: Tool.Context,
  instance: { directory: string; worktree: string },
  filePath: string | undefined,
  jsonText: string | undefined,
  maxBytes: number,
) {
  if (jsonText !== undefined) {
    const buf = Buffer.from(jsonText, "utf8")
    if (buf.length > maxBytes) throw new Error(`JSON text exceeds maxBytes (${buf.length} > ${maxBytes})`)
    return { text: jsonText, raw: buf, source: "jsonText", abs: "", rel: "" }
  }
  if (!filePath) throw new Error("Either filePath or jsonText is required")
  const abs = path.isAbsolute(filePath) ? filePath : path.join(instance.directory, filePath)
  const normalized = process.platform === "win32" ? FSUtil.normalizePath(abs) : abs
  const rel = path.relative(instance.worktree, normalized)
  yield* ctx.ask({ permission: "read", patterns: [rel], always: [rel], metadata: { filepath: normalized } })
  yield* assertExternalDirectoryEffect(ctx, normalized, { kind: "file" })
  const stat = yield* Effect.promise(() => fs.stat(normalized))
  if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`)
  if (stat.size > maxBytes) throw new Error(`File exceeds maxBytes (${stat.size} > ${maxBytes}): ${filePath}`)
  const raw = yield* Effect.promise(() => fs.readFile(normalized))
  const text = raw.includes(0) ? undefined : raw.toString("utf8") // binary if nul
  return { text, raw, source: "file", abs: normalized, rel: rel.split(path.sep).join("/") }
})

const writeJson = Effect.fn("JsonTool.write")(function* (
  ctx: Tool.Context,
  input: JsonInput & { raw?: Buffer },
  rel: string,
  before: string | Buffer,
  after: string | Buffer,
) {
  const beforeStr = Buffer.isBuffer(before) ? before.toString("base64").slice(0,64) : before
  const afterStr = Buffer.isBuffer(after) ? after.toString("base64").slice(0,64) : after
  yield* ctx.ask({
    permission: "edit",
    patterns: [rel],
    always: [rel],
    metadata: {
      filepath: input.abs,
      diff: trimDiff(createTwoFilesPatch(rel, rel, String(beforeStr), String(afterStr))),
    },
  })
  yield* Effect.promise(() => fs.writeFile(input.abs, after))
})

export const JsonTool = Tool.define<typeof Parameters, JsonMeta, never>(
  "json",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const limits = {
            ...Core.DEFAULT_LIMITS,
            maxBytes: params.maxBytes ?? Core.DEFAULT_LIMITS.maxBytes,
            maxDepth: params.maxDepth ?? Core.DEFAULT_LIMITS.maxDepth,
            maxObjectKeys: params.maxObjectKeys ?? Core.DEFAULT_LIMITS.maxObjectKeys,
            maxArrayItems: params.maxArrayItems ?? Core.DEFAULT_LIMITS.maxArrayItems,
            maxNodes: params.maxNodes ?? Core.DEFAULT_LIMITS.maxNodes,
            maxSearchResults: params.maxResults ?? Core.DEFAULT_LIMITS.maxSearchResults,
          }
          const mode: string = params.mode ?? "scaffold"

          const input = yield* readJsonInput(ctx, instance, params.filePath, params.jsonText, limits.maxBytes)
          const source = input.rel || input.source
          const rawForHash = input.raw ?? Buffer.from(input.text ?? "")
          const beforeHash = Core.hashText(rawForHash)
          const parsed = Core.parseJsonWithDiagnostics(input.raw ?? input.text ?? "", params.filePath)
          if (!parsed.ok) {
            return {
              title: "json validation failed",
              output: Core.validationXml(parsed, source),
              metadata: { mode: "validate", source, ok: false, preview: parsed.error.slice(0, 500) },
            }
          }
          const value = parsed.value
          const inputFormat = (parsed as any).format || "json"

          if (mode === "validate") {
            return { title: "json validate", output: Core.validationXml(parsed, source), metadata: { mode, source, ok: true, bytes: parsed.bytes } }
          }

          if (mode === "scaffold") {
            const scaffold = Core.buildScaffold(value, limits)
            const output = Core.scaffoldToXml(scaffold, { source, bytes: parsed.bytes, parseMs: parsed.parseMs })
            return { title: "json scaffold", output, metadata: { mode, source, nodes: scaffold.stats.nodes, preview: output.slice(0, 500) } }
          }

          if (mode === "stats") {
            const scaffold = Core.buildScaffold(value, { ...limits, maxDepth: Math.min(limits.maxDepth, 6), maxNodes: Math.min(limits.maxNodes, 500) })
            const output = [
              `<json-stats source="${Core.escapeXml(source)}" bytes="${parsed.bytes}" parseMs="${parsed.parseMs.toFixed(3)}" hash="${beforeHash}">`,
              `  <root type="${Core.typeOfJson(value)}" />`,
              `  <nodes total="${scaffold.stats.nodes}" objects="${scaffold.stats.objects}" arrays="${scaffold.stats.arrays}" primitives="${scaffold.stats.primitives}" maxDepth="${scaffold.stats.maxDepthSeen}" truncated="${scaffold.stats.truncatedNodes}" />`,
              "</json-stats>",
            ].join("\n")
            return { title: "json stats", output, metadata: { mode, source, nodes: scaffold.stats.nodes, preview: output.slice(0, 500) } }
          }

          if (mode === "query") {
            const p = params.path ?? "$"
            const hit = Core.getAtPath(value, p)
            if (!hit.found) {
              const output = `<json-query path="${Core.escapeXml(p)}" found="false" />`
              return { title: "json query", output, metadata: { mode, source, found: false, preview: output } }
            }
            const preview = outputPreview(JSON.stringify(hit.value, null, 2))
            const output = [
              `<json-query path="${Core.escapeXml(p)}" found="true" type="${Core.typeOfJson(hit.value)}" bytes="${preview.bytes}" truncated="${preview.truncated}">`,
              `<value>\n${Core.escapeXml(preview.text)}\n</value>`,
              "</json-query>",
            ].join("\n")
            return { title: "json query", output, metadata: { mode, source, found: true, preview: output.slice(0, 500) } }
          }

          if (mode === "search") {
            const results = Core.searchJson(value, params.query ?? "", { type: params.type, maxResults: limits.maxSearchResults })
            const output = Core.searchResultsToXml(results, params.query ?? params.type ?? "")
            return { title: "json search", output, metadata: { mode, source, count: results.length, preview: output.slice(0, 500) } }
          }

          if (mode === "schema") {
            const schema = Core.inferJsonSchema(value, { maxArrayItems: limits.maxArrayItems * 4, maxObjectKeys: limits.maxObjectKeys * 4 })
            const text = Core.stableStringify(schema, 2, true)
            const output = `<json-schema source="${Core.escapeXml(source)}">\n${Core.escapeXml(text)}\n</json-schema>`
            return { title: "json schema", output, metadata: { mode, source, preview: output.slice(0, 500) } }
          }

          if (mode === "format") {
            const indent = params.indent === 0 ? 0 : params.indent ?? 2
            const nextContent = Core.stringifyForFormat(value, inputFormat, indent, Boolean(params.sortKeys))
            const isBin = inputFormat === "bson"
            const nextForWrite = isBin ? Core.bsonSerialize(value) : nextContent
            const nextHash = Core.hashText(isBin ? nextForWrite : nextContent)
            let written = false
            const note = input.abs
              ? "dry run; no file was written. Re-run with dryRun:false to apply (a write permission prompt will appear)."
              : "jsonText input; no file write possible"
            if (input.abs && params.dryRun === false) {
              yield* writeJson(ctx, input as any, input.rel, input.raw ?? input.text ?? "", nextForWrite)
              written = true
            }
            const previewText = isBin ? "[binary BSON, " + (nextForWrite as Buffer).length + " bytes]" : nextContent
            const preview = outputPreview(previewText)
            const output = [
              `<json-format source="${Core.escapeXml(source)}" written="${written}" beforeHash="${beforeHash}" afterHash="${nextHash}" bytes="${preview.bytes}" truncated="${preview.truncated}">`,
              `  <note>${Core.escapeXml(note)}</note>`,
              `  <preview>\n${Core.escapeXml(preview.text)}\n  </preview>`,
              "</json-format>",
            ].join("\n")
            return { title: "json format", output, metadata: { mode, source, written, beforeHash, afterHash: nextHash, preview: output.slice(0, 500) } }
          }

          if (mode === "patch") {
            const ops = params.patch ?? []
            if (!Array.isArray(ops) || ops.length === 0) throw new Error("patch mode requires a non-empty patch array")
            const nextVal = Core.applyJsonPatch(value, ops)
            const nextContent = Core.stringifyForFormat(nextVal, inputFormat, params.indent ?? 2, Boolean(params.sortKeys))
            const isBin = inputFormat === "bson"
            const nextForWrite = isBin ? Core.bsonSerialize(nextVal) : nextContent
            const nextHash = Core.hashText(isBin ? nextForWrite : nextContent)
            let written = false
            const note = input.abs
              ? "dry run; no file was written. Re-run with dryRun:false to apply (a write permission prompt will appear)."
              : "jsonText input; no file write possible"
            if (input.abs && params.dryRun === false) {
              yield* writeJson(ctx, input as any, input.rel, input.raw ?? input.text ?? "", nextForWrite)
              written = true
            }
            const output = [
              `<json-patch source="${Core.escapeXml(source)}" ops="${ops.length}" written="${written}" beforeHash="${beforeHash}" afterHash="${nextHash}">`,
              `  <note>${Core.escapeXml(note)}</note>`,
              ...ops.map((op, i) => `  <op index="${i + 1}" kind="${Core.escapeXml((op as { op?: unknown }).op)}" path="${Core.escapeXml((op as { path?: unknown }).path)}" />`),
              "</json-patch>",
            ].join("\n")
            return { title: "json patch", output, metadata: { mode, source, ops: ops.length, written, beforeHash, afterHash: nextHash, preview: output.slice(0, 500) } }
          }

          if (mode === "diff") {
            const other = yield* readJsonInput(ctx, instance, params.compareFilePath, params.compareJsonText, limits.maxBytes)
            const otherRaw = other.raw ?? Buffer.from(other.text ?? "")
            const otherParsed = Core.parseJsonWithDiagnostics(otherRaw, params.compareFilePath)
            if (!otherParsed.ok) {
              return {
                title: "json compare validation failed",
                output: Core.validationXml(otherParsed, other.rel || other.source),
                metadata: { mode: "diff", source, ok: false, preview: otherParsed.error.slice(0, 500) },
              }
            }
            const diffs = Core.diffJson(value, otherParsed.value, { maxDiffs: limits.maxDiffs })
            const output = Core.diffToXml(diffs)
            return { title: "json diff", output, metadata: { mode, source, count: diffs.length, preview: output.slice(0, 500) } }
          }

          throw new Error(`Unsupported mode: ${mode}`)
        }).pipe(Effect.orDie),
    }
  }),
)
