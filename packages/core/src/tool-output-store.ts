export * as ToolOutputStore from "./tool-output-store"

import path from "path"
import { Context, Duration, Effect, Layer, Option, Schedule, Schema } from "effect"
import { Config } from "./config"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { makeGlobalNode, makeLocationNode } from "./effect/app-node"
import { SessionSchema } from "./session/schema"
import { Identifier } from "./util/identifier"
import type { ToolOutput } from "@opencode-ai/llm"
import { ToolOutputProjection } from "./tool-output-projection"
import { ToolOutputRetention } from "./tool-output-retention"

export const MAX_LINES = 2_000
export const MAX_BYTES = 50 * 1024
export const RETENTION = Duration.days(7)

export const MANAGED_DIRECTORY = "tool-output"

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
        try: () => ToolOutputRetention.compressText(content),
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
      const analysis = ToolOutputProjection.analyze(contextual, outputLimits)
      if (!analysis.truncated)
        return {
          output: input.output,
          outputPaths: [],
        }

      // Retention is a recovery optimization, not part of tool success. Once
      // the producer has succeeded, a disk-full/permission/compression failure
      // must not rewrite that semantic success into a tool failure. The bounded
      // preview remains a valid (explicitly lossy) settlement.
      const outputPath = yield* write(contextual).pipe(
        Effect.map((file) => Option.some(file)),
        Effect.catch((error) =>
          Effect.logWarning("failed to retain full tool output; returning bounded preview", {
            sessionID: input.sessionID,
            toolCallID: input.toolCallID,
            error: error.message,
          }).pipe(Effect.as(Option.none<string>())),
        ),
      )
      const retained = Option.getOrUndefined(outputPath)
      const marker = retained
        ? `... output truncated (original: ${analysis.originalLines} lines, ${analysis.originalBytes} bytes; showing beginning + end). Full content saved to ${retained} (brotli compressed). Use archive({action:"read", path:"${retained}"}) to inspect it. ...`
        : `... output truncated (original: ${analysis.originalLines} lines, ${analysis.originalBytes} bytes; showing beginning + end). Full-output retention failed; omitted content is unavailable from managed storage. ...`
      const projected = ToolOutputProjection.project(
        contextual,
        {
          ...outputLimits,
          marker,
          strategy: "balanced",
        },
        analysis,
      )

      return {
        output: {
          structured: input.output.structured,
          content: [
            {
              type: "text" as const,
              text: projected.content,
            },
            ...media,
          ],
        },
        outputPaths: retained ? [retained] : [],
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
