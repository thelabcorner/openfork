import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Identifier } from "@/id/id"
import { BackgroundJob } from "@/background/job"
import {
  ShellJobs,
  jobLogPath,
  jobMetaPath,
  jobLogPathLegacy,
  jobMetaPathLegacy,
  type ShellJobDelivery,
  type ShellJobKind,
} from "@/background/shell-jobs"
import { withBackgroundProcessSlot } from "./process-concurrency"
import { MonitorDelivery } from "@/background/monitor-delivery"
import { TRUNCATION_DIR } from "@/tool/truncation-dir"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { Effect, Layer, Context, Stream, Scope } from "effect"
import { createWriteStream } from "node:fs"
import path from "node:path"
import * as Truncate from "@/tool/truncate"
import { MessageID, type SessionID } from "@/session/schema"
import { ShellLaunch } from "@/tool/shell/launch"
import { Snapshot } from "@/snapshot"
import type { SessionPromptOps } from "@/session/prompt-contract"
import { SessionTurnProvenance } from "@opencode-ai/core/v1/session-turn-provenance"

const previewBound = (text: string, max = 30_000) => (text.length <= max ? text : "...\n\n" + text.slice(-max))

export type ShellJobOutputStream = "stdout" | "stderr"

/** Monitor wake payloads are observations, not diagnostics. */
export const shouldPublishMonitorStream = (stream: ShellJobOutputStream) => stream === "stdout"

function tail(text: string, maxLines: number, maxBytes: number) {
  const lines = text.split("\n")
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes) return { text, cut: false }
  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        const buf = Buffer.from(lines[i], "utf-8")
        let start = buf.length - maxBytes
        if (start < 0) start = 0
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
        out.unshift(buf.subarray(start).toString("utf-8"))
      }
      break
    }
    out.unshift(lines[i])
    bytes += size
  }
  return { text: out.join("\n"), cut: true }
}

function escapeXML(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

export type LaunchInput = {
  id?: string
  command: string
  shell: string
  cwd: string
  env: NodeJS.ProcessEnv
  kind: ShellJobKind
  delivery: ShellJobDelivery
  description?: string
  timeoutMs?: number
}

export type LaunchResult = {
  jobId: string
  logPath: string
  metaPath: string
}

export interface Interface {
  readonly launch: (
    input: LaunchInput,
    ctx: { sessionID: SessionID; callID?: string; agent?: string; extra?: unknown; abort?: AbortSignal },
  ) => Effect.Effect<LaunchResult, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ShellJobService") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const jobs = yield* ShellJobs.Service
    const fs = yield* FSUtil.Service
    const spawner = yield* ChildProcessSpawner
    const trunc = yield* Truncate.Service
    const monitor = yield* MonitorDelivery.Service
    const snapshot = yield* Snapshot.Service
    const scope = yield* Scope.Scope

    // helper to validate and allocate job id
    const ensureJobId = Effect.fn("ShellJob.ensureJobId")(function* (id?: string) {
      if (!id) return Identifier.ascending("job")
      if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid job id: ${id}. Must match ^[A-Za-z0-9_-]+$`)
      const existing = yield* background.get(id)
      if (existing) throw new Error(`job id "${id}" is already in use`)
      const logExists = yield* fs.existsSafe(jobLogPath(id))
      const metaExists = yield* fs.existsSafe(jobMetaPath(id))
      const legacyLogExists = yield* fs.existsSafe(jobLogPathLegacy(id))
      const legacyMetaExists = yield* fs.existsSafe(jobMetaPathLegacy(id))
      if (logExists || metaExists || legacyLogExists || legacyMetaExists)
        throw new Error(`job id "${id}" is already in use (a stale log exists on disk; pick a new id)`)
      return id
    })

    const pollUntilRegistered = Effect.fn("ShellJob.pollUntilRegistered")(function* (jobId: string) {
      let waited = 0
      while (waited < 2000) {
        const entry = yield* jobs.get(jobId)
        if (entry) return
        const info = yield* background.get(jobId)
        if (info && info.status !== "running") return
        yield* Effect.sleep("10 millis")
        waited += 10
      }
    })

    const launch: Interface["launch"] = Effect.fn("ShellJob.launch")(function* (input, ctx) {
      const jobId = yield* ensureJobId(input.id)
      const logPath = jobLogPath(jobId)
      const metaPath = jobMetaPath(jobId)
      const startedAt = Date.now()
      const timeoutMs = input.timeoutMs
      const kind = input.kind
      const delivery = input.delivery
      const description = input.description

      yield* fs.ensureDir(path.dirname(logPath))
      yield* fs.writeFileString(logPath, "")
      const meta: Record<string, unknown> = {
        id: jobId,
        command: input.command,
        shell: input.shell,
        cwd: input.cwd,
        startedAt,
        kind,
        delivery,
        ...(description ? { description } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        // legacy compat
        notify: delivery.mode === "completion",
      }
      yield* fs.writeJson(metaPath, meta)

      // For monitor kind, attach delivery pipeline before spawn so ingest is ready
      if (delivery.mode === "events") {
        yield* monitor.attach({
          jobID: jobId,
          ownerSessionID: delivery.ownerSessionID as any as SessionID,
          description: delivery.description,
          debounceMs: delivery.debounceMs,
        })
      }

      const metadata: Record<string, unknown> = {
        background: true,
        jobId,
        logPath,
        kind,
        delivery,
        startedAt,
        ...(description ? { description } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        // legacy notify flag for old readers
        notify: delivery.mode === "completion",
      }

      // Define the background run effect
      const run = Effect.gen(function* () {
        const limits = yield* trunc.limits()
        const keep = limits.maxBytes * 2
        type Chunk = { text: string; size: number }
        const list: Chunk[] = []
        let used = 0
        let last = ""
        let sink: ReturnType<typeof createWriteStream> | undefined
        let timedOut = false

        const closeSink = Effect.fnUntraced(function* () {
          const stream = sink
          if (!stream) return
          sink = undefined
          if (stream.destroyed || stream.closed) return
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                let settled = false
                const done = () => {
                  if (settled) return
                  settled = true
                  stream.off("close", done)
                  stream.off("error", done)
                  stream.off("finish", done)
                  resolve()
                }
                stream.once("close", done)
                stream.once("error", done)
                stream.once("finish", done)
                stream.end(done)
              }),
          ).pipe(Effect.catch(() => Effect.void))
        })

        const previewText = Effect.fnUntraced(function* () {
          const raw = list.map((item) => item.text).join("")
          const end = tail(raw, limits.maxLines, limits.maxBytes)
          return end.text || "(no output)"
        })

        const code: number | null = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.addFinalizer(closeSink)
            sink = createWriteStream(logPath, { flags: "a" })
            const handle = yield* spawner.spawn(
              ShellLaunch.command(
                input.shell,
                input.command,
                input.cwd,
                input.env,
                { stream: "pipe", endOnDone: false },
                { forceKillAfter: "3 seconds" },
              ),
            )
            // register live handle
            yield* jobs.register({
              id: jobId,
              handle,
              command: input.command,
              shell: input.shell,
              cwd: input.cwd,
              env: input.env,
              logPath,
              metaPath,
              notify: delivery.mode === "completion",
              timeoutMs,
              kind,
              delivery,
              startedAt,
              description,
            })
            yield* Effect.addFinalizer(() => jobs.remove(jobId).pipe(Effect.ignore))

            const recordChunk = (chunk: string) => {
              const size = Buffer.byteLength(chunk, "utf-8")
              list.push({ text: chunk, size })
              used += size
              while (used > keep && list.length > 1) {
                const item = list.shift()
                if (!item) break
                used -= item.size
              }
              last = previewBound(last + chunk)
              sink?.write(chunk)
            }

            if (delivery.mode === "events") {
              // Monitor wake semantics are stdout-only by contract. Keep stderr
              // in the diagnostic log/preview, but never publish it as an
              // external observation that can wake the model.
              yield* Effect.forkScoped(
                Stream.runForEach(Stream.decodeText(handle.stdout), (chunk) => {
                  recordChunk(chunk)
                  return shouldPublishMonitorStream("stdout") ? monitor.ingest(jobId, chunk) : Effect.void
                }),
              )
              yield* Effect.forkScoped(
                Stream.runForEach(Stream.decodeText(handle.stderr), (chunk) => {
                  recordChunk(chunk)
                  return shouldPublishMonitorStream("stderr") ? monitor.ingest(jobId, chunk) : Effect.void
                }),
              )
            } else {
              yield* Effect.forkScoped(
                Stream.runForEach(Stream.decodeText(handle.all), (chunk) => {
                  recordChunk(chunk)
                  return Effect.void
                }),
              )
            }

            const exit = yield* timeoutMs !== undefined
              ? Effect.raceAll([
                  handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code }))),
                  Effect.sleep(`${timeoutMs + 100} millis`).pipe(
                    Effect.map(() => ({ kind: "timeout" as const, code: null })),
                  ),
                ])
              : handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code })))

            if (exit.kind === "timeout") {
              timedOut = true
              yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
              // For completion delivery, injection will happen via background.wait path in caller
              // For monitor, delivery complete will handle timeout terminal
              if (delivery.mode === "events") {
                yield* monitor.complete(jobId, null, true).pipe(Effect.ignore)
              }
              yield* background.cancel(jobId).pipe(Effect.ignore)
            } else {
              if (delivery.mode === "events") {
                yield* monitor.complete(jobId, exit.code, false).pipe(Effect.ignore)
              }
            }
            return exit.code
          }),
        ).pipe(Effect.orDie)

        if (!timedOut && code !== null && code !== 0) {
          return yield* Effect.fail(new Error(`Command exited with code ${code}`))
        }
        return yield* previewText()
      })

      yield* background.start({
        id: jobId,
        type: "shell",
        title: input.command,
        metadata,
        // The launch call returns while this effect continues running. Keep the
        // Snapshot mutation lease on the actual process lifetime so captures
        // cannot race a monitor/background command that is still writing files.
        run: snapshot.withMutation(withBackgroundProcessSlot(run), `background:${kind}`),
      })

      yield* pollUntilRegistered(jobId)

      // For completion delivery, schedule notify wake (existing behavior)
      if (delivery.mode === "completion") {
        const ops = (ctx.extra as { promptOps?: SessionPromptOps } | undefined)?.promptOps
        if (ops) {
          // fire-and-forget background waiter that injects completion result
          yield* Effect.gen(function* () {
            const limits = yield* trunc.limits()
            const result = yield* background.wait({ id: jobId })
            const info = result.info
            const preview = yield* Effect.gen(function* () {
              if (info?.status === "completed") return info.output ?? "(no output)"
              // for error, read tail
              const text = yield* fs.readFileStringSafe(logPath).pipe(Effect.catch(() => Effect.succeed("")))
              if (!text) return "(no output)"
              return tail(text, limits.maxLines, limits.maxBytes).text || "(no output)"
            }).pipe(Effect.catch(() => Effect.succeed("(no output)")))
            const meta = { jobId, command: input.command, logPath, notify: true, timeoutMs }
            const render = (state: string, body: string) =>
              [
                `<background_shell job="${jobId}" state="${state}">`,
                `<summary>Background command ${state}: ${escapeXML(input.command)}</summary>`,
                `<command>${escapeXML(input.command)}</command>`,
                body,
                `Full output: ${logPath}`,
                `</background_shell>`,
              ].join("\n")
            let injection: string | undefined
            if (info?.status === "completed") injection = render("completed", `<preview>\n${preview}\n</preview>`)
            else if (info?.status === "error")
              injection = render(
                "error",
                `<error>${escapeXML(info.error ?? "Command failed")}</error>\n<preview>\n${preview}\n</preview>`,
              )
            else if (info?.status === "cancelled") {
              // explicit kill — no wake per spec §52
              injection = undefined
            }
            if (injection) {
              const workerRootMessageID = (ctx.extra as { workerRootMessageID?: unknown } | undefined)?.workerRootMessageID
              if (typeof workerRootMessageID !== "string" || workerRootMessageID.length === 0) {
                yield* Effect.logWarning("dropping background shell-job notification without a launch worker root", {
                  sessionID: ctx.sessionID,
                  jobID: jobId,
                })
                return
              }
              yield* ops
                .prompt({
                  sessionID: ctx.sessionID,
                  agent: ctx.agent ?? "build",
                  parts: [{ type: "text", synthetic: true, text: injection }],
                }, {
                  source: SessionTurnProvenance.Source.BackgroundShellSummary,
                  sourceMessageID: MessageID.make(workerRootMessageID),
                  ref: jobId,
                })
                .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
            }
          }).pipe(Effect.forkIn(scope, { startImmediately: true }), Effect.ignore)
        }
      }

      return { jobId, logPath, metaPath }
    })

    return Service.of({ launch })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    BackgroundJob.node,
    ShellJobs.node,
    MonitorDelivery.node,
    Truncate.node,
    CrossSpawnSpawner.node,
    FSUtil.node,
    Snapshot.node,
  ],
})

export * as ShellJob from "./shell-job"
