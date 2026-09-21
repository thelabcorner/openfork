import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { NodePath } from "@effect/platform-node"
import { Cause, Duration, Effect, Layer, Option, Schedule, Context } from "effect"
import path from "path"
import type { Agent } from "../agent/agent"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { evaluate } from "@/permission/evaluate"
import { Config } from "@/config/config"
import { ToolID } from "./schema"
import { TRUNCATION_DIR } from "./truncation-dir"
import { heldJobStems } from "@/background/shell-jobs"
import { ToolOutputProjection } from "@opencode-ai/core/tool-output-projection"
import { ToolOutputRetention } from "@opencode-ai/core/tool-output-retention"

const RETENTION = Duration.days(7)

export const MAX_LINES = 2000
export const MAX_BYTES = 50 * 1024
export const DIR = TRUNCATION_DIR
export const GLOB = path.join(TRUNCATION_DIR, "*")

export type Result =
  | { content: string; truncated: false }
  | {
      content: string
      truncated: true
      outputPath?: string
      originalLines: number
      originalBytes: number
      retainedBytes: number
      omittedBytes: number
      strategy: ToolOutputProjection.Strategy
      segments: ReadonlyArray<ToolOutputProjection.PreviewSegment>
    }

export interface Options {
  maxLines?: number
  maxBytes?: number
  direction?: ToolOutputProjection.Strategy
}

const JOB_PREFIX = "job_"

// Extract the job file stem from a `job_<stem>.log`/`job_<stem>.json` name.
function jobStemFromFile(name: string): string | undefined {
  if (!name.startsWith(JOB_PREFIX)) return undefined
  const base = name.slice(JOB_PREFIX.length)
  if (!base.endsWith(".log") && !base.endsWith(".json")) return undefined
  return base.slice(0, base.length - (base.endsWith(".log") ? 4 : 5))
}

function hasTaskTool(agent?: Agent.Info) {
  if (!agent?.permission) return false
  return evaluate("task", "*", agent.permission).action !== "deny"
}

export interface Interface {
  readonly cleanup: () => Effect.Effect<void>
  readonly write: (text: string) => Effect.Effect<string>
  readonly writer: (initial?: string) => Effect.Effect<Writer>
  /**
   * Returns output unchanged when it fits within the limits, otherwise writes the full text
   * to the truncation directory and returns a preview plus a hint to inspect the saved file.
   */
  readonly output: (text: string, options?: Options, agent?: Agent.Info) => Effect.Effect<Result>
  /**
   * Resolved truncation limits: values from `tool_output` in opencode config, or MAX_LINES / MAX_BYTES if unset.
   */
  readonly limits: () => Effect.Effect<{ maxLines: number; maxBytes: number }>
}

export interface Writer {
  readonly outputPath?: string
  readonly write: (text: string) => Effect.Effect<void>
  readonly close: Effect.Effect<void>
  readonly healthy: () => boolean
}

export type ProjectionMetadata = {
  truncated: boolean
  producerTruncated?: boolean
  providerTruncated: boolean
  outputPath?: string
  providerOutputPath?: string
  outputProjection?: {
    strategy: ToolOutputProjection.Strategy
    originalLines: number
    originalBytes: number
    retainedBytes: number
    omittedBytes: number
    segments: ReadonlyArray<ToolOutputProjection.PreviewSegment>
  }
}

/**
 * Compose producer/domain truncation metadata with the harness-owned final
 * provider projection. A producer may report semantic paging/capping, but it
 * never gains authority to waive the provider-facing hard bound.
 */
export function mergeMetadata<T extends Record<string, unknown>>(metadata: T, projected: Result): T & ProjectionMetadata {
  const producerDeclared = metadata.truncated !== undefined
  const producerTruncated = metadata.truncated === true
  const existingOutputPath = typeof metadata.outputPath === "string" ? metadata.outputPath : undefined
  return {
    ...metadata,
    truncated: producerTruncated || projected.truncated,
    ...(producerDeclared && { producerTruncated }),
    providerTruncated: projected.truncated,
    ...(projected.truncated && {
      ...(projected.outputPath
        ? existingOutputPath
          ? { providerOutputPath: projected.outputPath }
          : { outputPath: projected.outputPath, providerOutputPath: projected.outputPath }
        : {}),
      outputProjection: {
        strategy: projected.strategy,
        originalLines: projected.originalLines,
        originalBytes: projected.originalBytes,
        retainedBytes: projected.retainedBytes,
        omittedBytes: projected.omittedBytes,
        segments: projected.segments,
      },
    }),
  } as T & ProjectionMetadata
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Truncate") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service

    const cleanup = Effect.fn("Truncate.cleanup")(function* () {
      const cutoff = Date.now() - Duration.toMillis(RETENTION)
      const held = heldJobStems()
      const entries = yield* fs.readDirectory(TRUNCATION_DIR).pipe(
        Effect.map((all) => all.filter((name) => name.startsWith("tool_") || name.startsWith("job_"))),
        Effect.catch(() => Effect.succeed([])),
      )
      for (const entry of entries) {
        // Never sweep a live job's log/meta: a quiet long-running job could
        // exceed the mtime cutoff without writing new output.
        const stem = jobStemFromFile(entry)
        if (stem !== undefined && held.has(stem)) continue
        const file = path.join(TRUNCATION_DIR, entry)
        const info = yield* fs.stat(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
        const mtime = info && Option.getOrUndefined(info.mtime)
        if (!mtime || mtime.getTime() >= cutoff) continue
        yield* fs.remove(file).pipe(Effect.catch(() => Effect.void))
      }
    })

    const write = Effect.fn("Truncate.write")(function* (text: string) {
      const file = path.join(TRUNCATION_DIR, `${ToolID.ascending()}.br`)
      yield* fs.ensureDir(TRUNCATION_DIR).pipe(Effect.orDie)
      const compressed = yield* Effect.tryPromise({
        try: () => ToolOutputRetention.compressText(text),
        catch: (cause) => cause,
      }).pipe(Effect.orDie)
      yield* fs.writeFile(file, compressed, { flag: "wx" }).pipe(Effect.orDie)
      return file
    })

    const disabledWriter = (): Writer => ({
      outputPath: undefined,
      write: () => Effect.void,
      close: Effect.void,
      healthy: () => false,
    })

    const writer = Effect.fn("Truncate.writer")(function* (initial = "") {
      const file = path.join(TRUNCATION_DIR, `${ToolID.ascending()}.br`)
      const ready = yield* fs.ensureDir(TRUNCATION_DIR).pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          Effect.logWarning("failed to initialize streaming tool-output retention; continuing without recovery", {
            cause: String(cause),
          }).pipe(Effect.as(false)),
        ),
      )
      if (!ready) return disabledWriter()

      const raw = yield* Effect.try({
        try: () => ToolOutputRetention.createWriter(file),
        catch: (cause) => cause,
      }).pipe(
        Effect.map(Option.some),
        Effect.catch((cause) =>
          Effect.logWarning("failed to create streaming tool-output writer; continuing without recovery", {
            cause: String(cause),
          }).pipe(Effect.as(Option.none<ToolOutputRetention.Writer>())),
        ),
      )
      if (Option.isNone(raw)) return disabledWriter()
      let healthy = true
      const writeChunk = (text: string) =>
        healthy
          ? Effect.tryPromise({
              try: () => raw.value.write(text),
              catch: (cause) => cause,
            }).pipe(
              Effect.catch((cause) =>
                Effect.sync(() => {
                  healthy = false
                }).pipe(
                  Effect.andThen(
                    Effect.logWarning("failed while retaining streaming tool output; continuing without recovery", {
                      cause: String(cause),
                    }),
                  ),
                ),
              ),
            )
          : Effect.void
      const close = Effect.tryPromise({
        try: () => raw.value.close(),
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          Effect.sync(() => {
            healthy = false
          }).pipe(
            Effect.andThen(
              Effect.logWarning("failed to finalize streaming tool output retention", { cause: String(cause) }),
            ),
          ),
        ),
      )
      if (initial) yield* writeChunk(initial)
      return {
        get outputPath() {
          return healthy ? file : undefined
        },
        write: writeChunk,
        close,
        healthy: () => healthy,
      } satisfies Writer
    })

    const limits = Effect.fn("Truncate.limits")(function* () {
      const configSvc = yield* Effect.serviceOption(Config.Service)
      if (Option.isNone(configSvc)) return { maxLines: MAX_LINES, maxBytes: MAX_BYTES }
      const cfg = yield* configSvc.value.get().pipe(Effect.catch(() => Effect.succeed(undefined)))
      return {
        maxLines: cfg?.tool_output?.max_lines ?? MAX_LINES,
        maxBytes: cfg?.tool_output?.max_bytes ?? MAX_BYTES,
      }
    })

    const output = Effect.fn("Truncate.output")(function* (text: string, options: Options = {}, agent?: Agent.Info) {
      const resolved = yield* limits()
      const maxLines = options.maxLines ?? resolved.maxLines
      const maxBytes = options.maxBytes ?? resolved.maxBytes
      const direction = options.direction ?? "balanced"
      const analysis = ToolOutputProjection.analyze(text, { maxLines, maxBytes })

      if (!analysis.truncated) {
        return { content: text, truncated: false } as const
      }

      // The producer has already succeeded. Managed retention improves
      // recoverability, but a storage defect must not convert that success into
      // a failed tool call. Preserve a strict, explicitly lossy projection even
      // when the recovery artifact cannot be created.
      const file = yield* write(text).pipe(
        Effect.map((outputPath) => Option.some(outputPath)),
        Effect.catchDefect((defect) =>
          Effect.logWarning("failed to retain full tool output; returning bounded preview", {
            defect: String(defect),
          }).pipe(Effect.as(Option.none<string>())),
        ),
      )
      const outputPath = Option.getOrUndefined(file)

      const taskHint = hasTaskTool(agent)
        ? " You can delegate archive inspection to an explore agent with the Task tool to preserve your context."
        : ""
      const marker = outputPath
        ? `... output truncated (original: ${analysis.originalLines} lines, ${analysis.originalBytes} bytes; showing ${direction === "balanced" ? "beginning + end" : direction}). Full output saved to ${outputPath} (brotli compressed). Use archive({action:"read", path:"${outputPath}"}) to inspect it.${taskHint} ...`
        : `... output truncated (original: ${analysis.originalLines} lines, ${analysis.originalBytes} bytes; showing ${direction === "balanced" ? "beginning + end" : direction}). Full-output retention failed; omitted content is unavailable from managed storage. ...`
      const projected = ToolOutputProjection.project(
        text,
        { maxLines, maxBytes, marker, strategy: direction },
        analysis,
      )

      return {
        content: projected.content,
        truncated: true,
        ...(outputPath ? { outputPath } : {}),
        originalLines: projected.originalLines,
        originalBytes: projected.originalBytes,
        retainedBytes: projected.retainedBytes,
        omittedBytes: projected.omittedBytes,
        strategy: projected.strategy,
        segments: projected.segments,
      } as const
    })

    yield* cleanup().pipe(
      Effect.catchCause((cause) => Effect.logError("truncation cleanup failed", { cause: Cause.pretty(cause) })),
      Effect.repeat(Schedule.spaced(Duration.hours(1))),
      Effect.delay(Duration.minutes(1)),
      Effect.forkScoped,
    )

    return Service.of({ cleanup, write, writer, output, limits })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [FSUtil.node] })

export * as Truncate from "./truncate"
