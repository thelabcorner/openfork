import path from "path"
import fs from "node:fs/promises"
import { Effect } from "effect"
import { createTwoFilesPatch } from "diff"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { JsonEngine } from "@/json/engine"
import { assertExternalDirectoryEffect } from "./external-directory"
import { trimDiff } from "./edit"
import * as Tool from "./tool"
import DESCRIPTION from "./json.txt"

export const Parameters = JsonEngine.Parameters

type JsonInput = {
  readonly raw: Buffer
  readonly source: string
  readonly abs: string
  readonly rel: string
}

const readJsonInput = Effect.fn("JsonTool.readInput")(function* (
  ctx: Tool.Context,
  instance: { directory: string; worktree: string },
  filePath: string | undefined,
  jsonText: string | undefined,
  maxBytes: number,
) {
  if (jsonText !== undefined) {
    const raw = Buffer.from(jsonText, "utf8")
    if (raw.length > maxBytes) throw new Error(`JSON text exceeds maxBytes (${raw.length} > ${maxBytes})`)
    return { raw, source: "jsonText", abs: "", rel: "" } satisfies JsonInput
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
  return {
    raw,
    source: "file",
    abs: normalized,
    rel: rel.split(path.sep).join("/"),
  } satisfies JsonInput
})

const writeJson = Effect.fn("JsonTool.write")(function* (
  ctx: Tool.Context,
  input: JsonInput,
  before: Uint8Array,
  after: string | Uint8Array,
) {
  const beforePreview = Buffer.from(before).toString("base64").slice(0, 64)
  const afterPreview =
    typeof after === "string" ? after : Buffer.from(after).toString("base64").slice(0, 64)
  yield* ctx.ask({
    permission: "edit",
    patterns: [input.rel],
    always: [input.rel],
    metadata: {
      filepath: input.abs,
      diff: trimDiff(createTwoFilesPatch(input.rel, input.rel, beforePreview, afterPreview)),
    },
  })
  yield* Effect.promise(() => fs.writeFile(input.abs, after))
})

export const JsonTool = Tool.define<typeof Parameters, JsonEngine.Metadata, never>(
  "json",
  Effect.gen(function* () {
    return {
      exposure: "lazy" as const,
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const currentLimits = JsonEngine.limits(params)
          const input = yield* readJsonInput(
            ctx,
            instance,
            params.filePath,
            params.jsonText,
            currentLimits.maxBytes,
          )
          const source = input.rel || input.source
          const document: JsonEngine.Document = {
            raw: input.raw,
            source,
            fileHint: params.filePath,
            writable: Boolean(input.abs),
          }

          const compare =
            (params.mode ?? "scaffold") === "diff"
              ? yield* readJsonInput(
                  ctx,
                  instance,
                  params.compareFilePath,
                  params.compareJsonText,
                  currentLimits.maxBytes,
                )
              : undefined
          const compareDocument: JsonEngine.Document | undefined = compare
            ? {
                raw: compare.raw,
                source: compare.rel || compare.source,
                fileHint: params.compareFilePath,
                writable: false,
              }
            : undefined

          const result = JsonEngine.execute(params, document, compareDocument)
          if (result.write && input.abs) {
            yield* writeJson(ctx, input, input.raw, result.write.content)
          }
          const { write: _write, ...toolResult } = result
          return toolResult
        }).pipe(Effect.orDie),
    }
  }),
)

export * as JsonToolModule from "./json"
