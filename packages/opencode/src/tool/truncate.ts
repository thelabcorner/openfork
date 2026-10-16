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
import * as SessionToolOutput from "@opencode-ai/core/session/tool-output"
import { Database } from "@opencode-ai/core/database/database"
import type { SessionSchema } from "@opencode-ai/core/session/schema"
import type { MessageID } from "@opencode-ai/core/v1/session"

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
      /** True only when the complete result was durably retained in the session timeline. */
      timelineOutput?: true
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
  /**
   * The producer already durably retained its complete semantic output under
   * this tool call. Provider projection must preserve that authority instead of
   * replacing it with a second, smaller retention of the projected producer
   * result.
   */
  timelineRetained?: boolean
}

export type TimelineOwner = {
  sessionID: SessionSchema.ID
  messageID: MessageID
  toolCallID: string
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
  readonly writer: (initial: string | undefined, owner?: TimelineOwner) => Effect.Effect<Writer>
  /**
   * Returns output unchanged when it fits within the limits, otherwise writes the full text
   * to the truncation directory and returns a preview plus a hint to inspect the saved file.
   */
  readonly output: (text: string, options?: Options, agent?: Agent.Info, owner?: TimelineOwner) => Effect.Effect<Result>
  /**
   * Best-effort durable timeline retention, independent of provider projections
   * and archive TTL. False means the provider result must remain usable but the
   * timeline must not advertise full-output recovery.
   */
  readonly retainTimeline: (owner: TimelineOwner, text: string) => Effect.Effect<boolean>
  /**
   * Resolved truncation limits: values from `tool_output` in opencode config, or MAX_LINES / MAX_BYTES if unset.
   */
  readonly limits: () => Effect.Effect<{ maxLines: number; maxBytes: number }>
}

export interface Writer {
  readonly outputPath?: string
  readonly write: (text: string) => Effect.Effect<void>
  readonly close: Effect.Effect<void>
  /** Optional Brotli archive health. */
  readonly healthy: () => boolean
  /** Complete session-timeline retention health. */
  readonly timelineHealthy: () => boolean
}

export type ProjectionMetadata = {
  truncated: boolean
  producerTruncated?: boolean
  providerTruncated: boolean
  outputPath?: string
  providerOutputPath?: string
  timelineOutput?: boolean
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
    ...(projected.truncated && projected.timelineOutput ? { timelineOutput: true } : {}),
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
    const database = yield* Database.Service
    const beginTimeline = (owner: TimelineOwner) =>
      SessionToolOutput.begin(owner).pipe(Effect.provideService(Database.Service, database))
    const appendTimelineChunk = (owner: TimelineOwner, index: number, offset: number, text: string) =>
      SessionToolOutput.append(owner, index, offset, text).pipe(Effect.provideService(Database.Service, database))
    const finishTimeline = (owner: TimelineOwner) =>
      SessionToolOutput.finish(owner).pipe(Effect.provideService(Database.Service, database))
    const persistTimeline = (owner: TimelineOwner, text: string) =>
      SessionToolOutput.persist(owner, text).pipe(Effect.provideService(Database.Service, database))

    // Full-output timeline retention is a recovery feature, not semantic tool
    // success. Missing/invalid ownership or storage failure must never turn an
    // otherwise successful tool result into a Session failure.
    const retainTimeline = Effect.fn("Truncate.retainTimeline")(function* (owner: TimelineOwner, text: string) {
      if (!owner.toolCallID) {
        yield* Effect.logWarning("skipping durable tool-output timeline retention without a tool-call owner", {
          sessionID: owner.sessionID,
          messageID: owner.messageID,
        })
        return false
      }
      return yield* persistTimeline(owner, text).pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to retain complete tool output in the session timeline; continuing with bounded provider output", {
            sessionID: owner.sessionID,
            messageID: owner.messageID,
            toolCallID: owner.toolCallID,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(false)),
        ),
      )
    })

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
      timelineHealthy: () => false,
    })

    const writer = Effect.fn("Truncate.writer")(function* (initial = "", owner?: TimelineOwner) {
      let timelineHealthy = false
      if (owner?.toolCallID) {
        timelineHealthy = yield* beginTimeline(owner).pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to initialize durable streaming tool-output timeline; continuing without timeline recovery", {
              sessionID: owner.sessionID,
              messageID: owner.messageID,
              toolCallID: owner.toolCallID,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(false)),
          ),
        )
      } else {
        yield* Effect.logWarning("streaming tool output has no durable tool-call owner; continuing without timeline recovery", {
          ...(owner ? { sessionID: owner.sessionID, messageID: owner.messageID } : {}),
        })
      }
      const file = path.join(TRUNCATION_DIR, `${ToolID.ascending()}.br`)
      const archiveReady = yield* fs.ensureDir(TRUNCATION_DIR).pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          Effect.logWarning("failed to initialize streaming tool-output archive; continuing without archive recovery", {
            cause: String(cause),
          }).pipe(Effect.as(false)),
        ),
      )
      const raw = archiveReady
        ? yield* Effect.try({
            try: () => ToolOutputRetention.createWriter(file),
            catch: (cause) => cause,
          }).pipe(
            Effect.map(Option.some),
            Effect.catch((cause) =>
              Effect.logWarning("failed to create streaming tool-output writer; continuing without archive recovery", {
                cause: String(cause),
              }).pipe(Effect.as(Option.none<ToolOutputRetention.Writer>())),
            ),
          )
        : Option.none<ToolOutputRetention.Writer>()
      let archiveHealthy = Option.isSome(raw)
      let nextOffset = 0
      let chunkIndex = 0
      const buffer = SessionToolOutput.createChunkBuffer()
      const appendTimeline = (target: TimelineOwner, value: string) =>
        Effect.forEach(
          buffer.push(value),
          (ready) => {
            const index = chunkIndex++
            const offset = nextOffset
            nextOffset += Array.from(ready).length
            return appendTimelineChunk(target, index, offset, ready)
          },
          { discard: true },
        ).pipe(Effect.as(undefined))
      const writeChunk = (value: string) =>
        Effect.gen(function* () {
          if (archiveHealthy && Option.isSome(raw)) {
            yield* Effect.tryPromise({ try: () => raw.value.write(value), catch: (cause) => cause }).pipe(
              Effect.catch((cause) =>
                Effect.sync(() => {
                  archiveHealthy = false
                }).pipe(Effect.andThen(Effect.logWarning("failed to write optional compressed tool-output archive", { cause: String(cause) }))),
              ),
            )
          }
          if (timelineHealthy && owner) {
            // Coalesce many deltas into fixed Unicode-safe chunks; each flush is
            // durable before the producer acknowledges the chunk to the UI.
            yield* appendTimeline(owner, value).pipe(
              Effect.catchCause((cause) =>
                Effect.sync(() => {
                  timelineHealthy = false
                }).pipe(
                  Effect.andThen(
                    Effect.logWarning("failed while retaining streaming tool output in the session timeline; continuing without timeline recovery", {
                      sessionID: owner.sessionID,
                      messageID: owner.messageID,
                      toolCallID: owner.toolCallID,
                      cause: Cause.pretty(cause),
                    }),
                  ),
                ),
              ),
            )
          }
        })
      const close = Effect.gen(function* () {
        if (archiveHealthy && Option.isSome(raw)) {
          yield* Effect.tryPromise({ try: () => raw.value.close(), catch: (cause) => cause }).pipe(
            Effect.catch((cause) =>
              Effect.sync(() => {
                archiveHealthy = false
              }).pipe(Effect.andThen(Effect.logWarning("failed to finalize optional compressed tool-output archive", { cause: String(cause) }))),
            ),
          )
        }
        if (timelineHealthy && owner) {
          yield* Effect.gen(function* () {
            for (const ready of buffer.flush()) {
              yield* appendTimelineChunk(owner, chunkIndex++, nextOffset, ready)
              nextOffset += Array.from(ready).length
            }
            yield* finishTimeline(owner)
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                timelineHealthy = false
              }).pipe(
                Effect.andThen(
                  Effect.logWarning("failed to finalize streaming tool output in the session timeline; continuing without timeline recovery", {
                    sessionID: owner.sessionID,
                    messageID: owner.messageID,
                    toolCallID: owner.toolCallID,
                    cause: Cause.pretty(cause),
                  }),
                ),
              ),
            ),
          )
        }
      })
      if (!archiveHealthy && !timelineHealthy) {
        if (initial) yield* Effect.void
        return disabledWriter()
      }
      if (initial) yield* writeChunk(initial)
      return {
        get outputPath() {
          return archiveHealthy ? file : undefined
        },
        write: writeChunk,
        close,
        healthy: () => archiveHealthy,
        timelineHealthy: () => timelineHealthy,
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

    const output = Effect.fn("Truncate.output")(function* (
      text: string,
      options: Options = {},
      agent?: Agent.Info,
      owner?: TimelineOwner,
    ) {
      const resolved = yield* limits()
      const maxLines = options.maxLines ?? resolved.maxLines
      const maxBytes = options.maxBytes ?? resolved.maxBytes
      const direction = options.direction ?? "balanced"
      const analysis = ToolOutputProjection.analyze(text, { maxLines, maxBytes })

      if (!analysis.truncated) {
        return { content: text, truncated: false } as const
      }

      // Provider context stays bounded regardless of whether this execution has
      // a durable ToolPart owner. When the producer already owns complete
      // timeline retention (for example streaming shell output), preserve that
      // authority rather than replacing it with this smaller provider input.
      // Otherwise timeline recovery remains opportunistic: ownership or storage
      // defects must not convert semantic tool success into failure.
      const timelineOutput = options.timelineRetained === true
        ? true
        : owner
          ? yield* retainTimeline(owner, text)
          : false

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
        : timelineOutput
          ? `... output truncated (original: ${analysis.originalLines} lines, ${analysis.originalBytes} bytes; showing ${direction === "balanced" ? "beginning + end" : direction}). Full output is retained in the durable session timeline; archive recovery is unavailable. ...`
          : `... output truncated (original: ${analysis.originalLines} lines, ${analysis.originalBytes} bytes; showing ${direction === "balanced" ? "beginning + end" : direction}). Full-output retention failed; omitted content is unavailable from managed storage. ...`
      const projected = ToolOutputProjection.project(
        text,
        { maxLines, maxBytes, marker, strategy: direction },
        analysis,
      )

      return {
        content: projected.content,
        truncated: true,
        ...(timelineOutput ? { timelineOutput: true as const } : {}),
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

    return Service.of({ cleanup, write, writer, output, limits, retainTimeline })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [FSUtil.node, Database.node] })

export * as Truncate from "./truncate"
