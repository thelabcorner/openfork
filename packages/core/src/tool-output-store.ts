export * as ToolOutputStore from "./tool-output-store"

import path from "path"
import { brotliCompress, constants } from "node:zlib"
import { promisify } from "node:util"
import { Context, Duration, Effect, Layer, Option, Schedule, Schema } from "effect"
import { Config } from "./config"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { makeGlobalNode, makeLocationNode } from "./effect/app-node"
import { SessionSchema } from "./session/schema"
import { Identifier } from "./util/identifier"
import type { ToolOutput } from "@opencode-ai/llm"

export const MAX_LINES = 2_000
export const MAX_BYTES = 50 * 1024
export const RETENTION = Duration.days(7)

export const MANAGED_DIRECTORY = "tool-output"

// Callback-based zlib runs on the libuv threadpool, so compressing a large tool
// output never blocks the server event loop. A synchronous quality-4 pass over a
// multi-megabyte payload costs hundreds of milliseconds, which stalls every SSE
// subscriber and HTTP route for the duration and invalidates transport latency
// measurements. The same lesson is documented in the desktop main process.
const brotliCompressAsync = promisify(brotliCompress)

export interface BoundInput {
  readonly sessionID: SessionSchema.ID
  readonly toolCallID: string
  readonly output: ToolOutput
}

export interface BoundResult {
  readonly output: ToolOutput
  readonly outputPaths: ReadonlyArray<string>
}

export class StorageError extends Schema.TaggedErrorClass<StorageError>()("ToolOutputStore.StorageError", {
  operation: Schema.Literals(["encode", "write"]),
  cause: Schema.Defect(),
}) {
  override get message() {
    const detail = this.cause instanceof Error ? this.cause.message : String(this.cause)
    return `Failed to ${this.operation} tool output${detail ? `: ${detail}` : ""}`
  }
}

export type Error = StorageError

export interface Interface {
  readonly limits: () => Effect.Effect<{ readonly maxLines: number; readonly maxBytes: number }>
  readonly bound: (input: BoundInput) => Effect.Effect<BoundResult, Error>
  readonly cleanup: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ToolOutputStore") {}

const utf8Forward = (input: string, index: number) => {
  const code = input.charCodeAt(index)
  if (code < 0x80) return { bytes: 1, units: 1 }
  if (code < 0x800) return { bytes: 2, units: 1 }
  if (code >= 0xd800 && code <= 0xdbff && index + 1 < input.length) {
    const low = input.charCodeAt(index + 1)
    if (low >= 0xdc00 && low <= 0xdfff) return { bytes: 4, units: 2 }
  }
  return { bytes: 3, units: 1 }
}

const utf8Backward = (input: string, end: number) => {
  const code = input.charCodeAt(end - 1)
  if (code >= 0xdc00 && code <= 0xdfff && end >= 2) {
    const high = input.charCodeAt(end - 2)
    if (high >= 0xd800 && high <= 0xdbff) return { bytes: 4, units: 2 }
  }
  if (code < 0x80) return { bytes: 1, units: 1 }
  if (code < 0x800) return { bytes: 2, units: 1 }
  return { bytes: 3, units: 1 }
}

const takePrefix = (input: string, maximumBytes: number) => {
  let bytes = 0
  let index = 0
  while (index < input.length) {
    const width = utf8Forward(input, index)
    if (bytes + width.bytes > maximumBytes) break
    bytes += width.bytes
    index += width.units
  }
  return input.slice(0, index)
}

const takeSuffix = (input: string, maximumBytes: number) => {
  let bytes = 0
  let index = input.length
  while (index > 0) {
    const width = utf8Backward(input, index)
    if (bytes + width.bytes > maximumBytes) break
    bytes += width.bytes
    index -= width.units
  }
  return input.slice(index)
}

const withinByteLimit = (input: string, maximumBytes: number) => {
  let bytes = 0
  for (let index = 0; index < input.length; ) {
    const width = utf8Forward(input, index)
    bytes += width.bytes
    if (bytes > maximumBytes) return false
    index += width.units
  }
  return true
}

const hasMoreThanLines = (input: string, maximumLines: number) => {
  if (maximumLines < 1) return input.length > 0
  let at = -1
  for (let line = 0; line < maximumLines; line++) {
    at = input.indexOf("\n", at + 1)
    if (at === -1) return false
  }
  return true
}

const takeHeadLines = (input: string, count: number) => {
  if (count <= 0) return ""
  let at = -1
  for (let line = 0; line < count; line++) {
    at = input.indexOf("\n", at + 1)
    if (at === -1) return input
  }
  return input.slice(0, at)
}

const takeTailLines = (input: string, count: number) => {
  if (count <= 0) return ""
  let at = input.length
  for (let line = 0; line < count; line++) {
    const previous = input.lastIndexOf("\n", at - 1)
    if (previous === -1) return input
    at = previous
  }
  return input.slice(at + 1)
}

const preview = (text: string, maxLines: number, maxBytes: number) => {
  const overLines = hasMoreThanLines(text, maxLines)
  const headLines = Math.ceil(maxLines / 2)
  const tailLines = Math.floor(maxLines / 2)
  const head = overLines ? takeHeadLines(text, headLines) : text
  const tail = overLines && tailLines > 0 ? takeTailLines(text, tailLines) : ""
  const sampled = overLines ? `${head}\n${tail}` : head
  if (withinByteLimit(sampled, maxBytes)) {
    return overLines ? { head, tail } : { head: sampled, tail: "" }
  }
  const headBytes = Math.ceil(maxBytes / 2)
  const tailBytes = Math.floor(maxBytes / 2)
  return { head: takePrefix(sampled, headBytes), tail: takeSuffix(sampled, tailBytes) }
}

const boundedPreview = (text: string, marker: string, maxLines: number, maxBytes: number) => {
  const markerOnly = takePrefix(marker, maxBytes).split("\n").slice(0, maxLines).join("\n")
  const markerBytes = Buffer.byteLength(marker, "utf-8")
  if (maxLines <= 4 || maxBytes <= markerBytes + 4) return markerOnly
  const bounded = preview(text, maxLines - 4, maxBytes - markerBytes - 4)
  return bounded.tail ? `${bounded.head}\n\n${marker}\n\n${bounded.tail}` : `${bounded.head}\n\n${marker}`
}

const withinLimits = (text: string, maxLines: number, maxBytes: number) => {
  let lines = 1
  let bytes = 0
  for (let index = 0; index < text.length; ) {
    const width = utf8Forward(text, index)
    bytes += width.bytes
    if (bytes > maxBytes) return false
    if (text.charCodeAt(index) === 10 && ++lines > maxLines) return false
    index += width.units
  }
  return lines <= maxLines
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const config = yield* Effect.serviceOption(Config.Service)
    const directory = path.join(global.data, MANAGED_DIRECTORY)
    const limits = Effect.fn("ToolOutputStore.limits")(function* () {
      if (Option.isNone(config)) return { maxLines: MAX_LINES, maxBytes: MAX_BYTES }
      const entries = yield* config.value.entries().pipe(Effect.catch(() => Effect.succeed([] as Config.Entry[])))
      const configured = Object.assign(
        {},
        ...entries.flatMap((entry) => (entry.type === "document" ? [entry.info.tool_output ?? {}] : [])),
      )
      return { maxLines: configured.max_lines ?? MAX_LINES, maxBytes: configured.max_bytes ?? MAX_BYTES }
    })

    const write = Effect.fn("ToolOutputStore.write")(function* (content: string) {
      const file = path.join(directory, `tool_${Identifier.ascending()}.br`)
      yield* fs.ensureDir(directory).pipe(Effect.mapError((cause) => new StorageError({ operation: "write", cause })))
      const compressed = yield* Effect.tryPromise({
        try: () =>
          brotliCompressAsync(Buffer.from(content, "utf-8"), {
            params: {
              [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
              [constants.BROTLI_PARAM_QUALITY]: 4,
            },
          }),
        catch: (cause) => new StorageError({ operation: "write", cause }),
      })
      yield* fs
        .writeFile(file, compressed, { flag: "wx" })
        .pipe(Effect.mapError((cause) => new StorageError({ operation: "write", cause })))
      return file
    })

    const bound = Effect.fn("ToolOutputStore.bound")(function* (input: BoundInput) {
      const outputLimits = yield* limits()
      const media = input.output.content.filter((item) => item.type === "file")
      const text = input.output.content.filter((item) => item.type === "text")
      const contextual =
        input.output.content.length === 0
          ? yield* Effect.try({
              try: () => JSON.stringify(input.output.structured, null, 2) ?? String(input.output.structured),
              catch: (cause) => new StorageError({ operation: "encode", cause }),
            })
          : text.map((item) => item.text).join("")
      if (withinLimits(contextual, outputLimits.maxLines, outputLimits.maxBytes))
        return {
          output: input.output,
          outputPaths: [],
        }

      const outputPath = yield* write(contextual)
      const marker = `... output truncated; full content saved to ${outputPath} (brotli compressed). Use the archive tool to view it: archive({action:"read", path:"${outputPath}"}) ...`

      return {
        output: {
          structured: input.output.structured,
          content: [
            {
              type: "text" as const,
              text: boundedPreview(contextual, marker, outputLimits.maxLines, outputLimits.maxBytes),
            },
            ...media,
          ],
        },
        outputPaths: [outputPath],
      }
    })

    const cleanup = Effect.fn("ToolOutputStore.cleanup")(function* () {
      const entries = yield* fs.readDirectory(directory).pipe(Effect.catch(() => Effect.succeed([])))
      const cutoff = Date.now() - Duration.toMillis(RETENTION)
      for (const entry of entries) {
        if (!entry.startsWith("tool_")) continue
        const file = path.join(directory, entry)
        const info = yield* fs.stat(file).pipe(Effect.catch(() => Effect.void))
        const modified = info?.mtime.pipe(
          Option.map((date) => date.getTime()),
          Option.getOrUndefined,
        )
        // An unavailable mtime is not evidence that a file is old. Skipping is
        // the safe direction: deleting on `0 < cutoff` removes a freshly written
        // output, and the removal is unrecoverable.
        if (modified === undefined) continue
        if (modified < cutoff) yield* fs.remove(file).pipe(Effect.catch(() => Effect.void))
      }
    })

    return Service.of({ limits, bound, cleanup })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [FSUtil.node, Global.node, Config.node] })

export const nodeWithoutConfig = makeLocationNode({ service: Service, layer, deps: [FSUtil.node, Global.node] })

/** Runs retention scanning once globally rather than once per active Location. */
export const cleanupLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* Service
    yield* store.cleanup().pipe(Effect.repeat(Schedule.spaced(Duration.hours(1))), Effect.forkScoped)
  }),
)

export const cleanupNode = makeGlobalNode({
  name: "tool-output-cleanup",
  layer: Layer.merge(layer, cleanupLayer.pipe(Layer.provide(layer))),
  deps: [FSUtil.node, Global.node],
})
