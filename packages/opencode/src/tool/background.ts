import { Effect, Schema, Stream } from "effect"
import path from "path"
import * as Tool from "./tool"
import DESCRIPTION from "./background.txt"
import { BackgroundJob } from "@/background/job"
import { ShellJobs, jobLogPath, jobMetaPath, jobMetaPathLegacy, jobFileStem } from "@/background/shell-jobs"
import { ShellID } from "./shell/id"
import { BashArity } from "@/permission/arity"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { NonNegativeInt, PositiveInt } from "@opencode-ai/core/schema"
import { TRUNCATION_DIR } from "./truncation-dir"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["list", "status", "kill", "read", "wait", "send"]).annotate({
    description:
      "What to do: 'list' shows all jobs, 'status' shows one job, 'read' reads its live log, 'wait' blocks until it finishes, 'send' writes to its stdin, 'kill' terminates it",
  }),
  id: Schema.optional(Schema.String).annotate({
    description: "Job id returned by the bash tool's background launch. Required for all actions except 'list'",
  }),
  offset: Schema.optional(NonNegativeInt).annotate({
    description: "For 'read': 1-indexed line to start from (default 1)",
  }),
  limit: Schema.optional(PositiveInt).annotate({
    description: "For 'read': max number of lines to return (default 2000)",
  }),
  timeout: Schema.optional(NonNegativeInt).annotate({
    description: "For 'wait': max milliseconds to wait. Omit to wait indefinitely; 0 polls once",
  }),
  input: Schema.optional(Schema.String).annotate({
    description: "For 'send': text to write to the job's stdin (a newline is appended if missing)",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>

type Row = {
  id: string
  status: string
  kind: string
  description?: string
  command: string
  startedAt?: number
  timeoutMs?: number
  logPath?: string
  exit?: number | null
}

const exitOf = (info: BackgroundJob.Info | undefined): number | null => {
  if (!info) return null
  if (info.status === "completed") return 0
  if (info.status === "error") {
    const match = /exited with code (\d+)/.exec(info.error ?? "")
    return match ? Number(match[1]) : null
  }
  return null
}

const metaString = (meta: Record<string, unknown> | undefined, key: string): string | undefined => {
  const value = meta?.[key]
  return typeof value === "string" ? value : undefined
}

const metaNumber = (meta: Record<string, unknown> | undefined, key: string): number | undefined => {
  const value = meta?.[key]
  return typeof value === "number" ? value : undefined
}

function renderList(rows: Row[]): string {
  if (rows.length === 0) return "No background jobs."
  const header = `${"Job".padEnd(24)} ${"Status".padEnd(14)} ${"Kind".padEnd(10)} Command`
  const lines = [header]
  for (const row of rows) {
    const status =
      row.status === "stale"
        ? "stale"
        : row.status === "running"
          ? "running"
          : row.exit !== null && row.exit !== undefined
            ? `${row.status} (exit ${row.exit})`
            : row.status
    const kind = (row.kind ?? "shell").padEnd(10)
    const cmd = row.description ? `${row.command.slice(0, 45)} — ${row.description}` : row.command.slice(0, 60)
    lines.push(`${row.id.padEnd(24)} ${status.padEnd(14)} ${kind} ${cmd}`)
  }
  if (rows.length > 0) {
    lines.push("")
    lines.push("Use `background status {id}` for details, `background read {id}` for output, `background kill {id}` to terminate.")
    lines.push("Monitor jobs share this manager; start them with the `monitor` tool.")
  }
  return lines.join("\n")
}

export const BackgroundTool = Tool.define(
  "background",
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const jobs = yield* ShellJobs.Service
    const fs = yield* FSUtil.Service

    const readLog = Effect.fn("BackgroundTool.readLog")(function* (logPath: string, offset: number, limit: number) {
      const text = yield* fs.readFileStringSafe(logPath)
      if (!text) return "(no output yet)"
      const lines = text.replace(/\r\n/g, "\n").split("\n")
      const start = Math.max(0, offset - 1)
      const shown = lines.slice(start, start + limit)
      const out = shown.join("\n") || "(no output yet)"
      if (start + shown.length < lines.length) {
        return `${out}\n...\n(Showing lines ${start + 1}-${start + shown.length} of ${lines.length}; use offset=${start + shown.length + 1} to continue)`
      }
      return out
    })

    const jobRow = Effect.fn("BackgroundTool.jobRow")(function* (id: string) {
      const entry = yield* jobs.get(id)
      const info = yield* background.get(id)
      if (entry || info) {
        const kind = (entry as any)?.kind ?? (info?.metadata as any)?.kind ?? "shell"
        const description = (entry as any)?.description ?? metaString(info?.metadata, "description")
        return {
          id,
          status: info?.status ?? "running",
          kind,
          description,
          command: entry?.command ?? info?.title ?? id,
          startedAt: info?.started_at,
          timeoutMs: metaNumber(info?.metadata, "timeoutMs"),
          logPath: entry?.logPath ?? metaString(info?.metadata, "logPath"),
          exit: exitOf(info),
        }
      }
      // stale leftover on disk — try new subdir then legacy
      const meta = yield* fs.readJson(jobMetaPath(id)).pipe(
        Effect.catch(() => fs.readJson(jobMetaPathLegacy(id))),
      ).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (meta && typeof meta === "object" && "id" in meta && typeof meta.id === "string") {
        const record = meta as Record<string, unknown>
        const metaId = record.id as string
        const command = typeof record.command === "string" ? record.command : undefined
        const startedAt = typeof record.startedAt === "number" ? record.startedAt : undefined
        const logPath = typeof record.logPath === "string" ? record.logPath : undefined
        const kind = typeof record.kind === "string" ? record.kind : "shell"
        const description = typeof record.description === "string" ? record.description : undefined
        return {
          id: metaId,
          status: "stale",
          kind,
          description,
          command: command ?? metaId,
          startedAt,
          logPath: logPath ?? jobLogPath(metaId),
        }
      }
      return undefined
    })

    const askCommand = Effect.fn("BackgroundTool.askCommand")(function* (
      ctx: Tool.Context,
      action: "kill" | "send",
      row: Row,
    ) {
      const command = row.command
      const tokens = command.split(/\s+/)
      yield* ctx.ask({
        permission: ShellID.ToolID,
        patterns: [command],
        always: [BashArity.prefix(tokens).join(" ") + " *"],
        metadata: { action, jobId: row.id, command },
      })
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      formatValidationError: (error) => {
        const message = error instanceof Error ? error.message : String(error)
        // The common miss is calling `background` like the `bash` tool (no
        // `action`, or bash-only params like command/workdir). Guide instead of
        // leaking the raw SchemaError.
        if (message.includes("Missing key") && message.includes('["action"]')) {
          return [
            'The `background` tool manages jobs already launched by the `bash` tool (`background: true`); it has no `command` parameter.',
            'To launch a job, call `bash` with `background: true` — it returns a job id.',
            "To manage one, pass `action` (one of list | status | kill | read | wait | send) and the job's `id`, e.g. background({ action: \"read\", id: \"job_abc\" }).",
            "Call background({ action: \"list\" }) to see running jobs and ids.",
          ].join(" ")
        }
        return message
      },
      execute: (params: Params, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult> =>
        Effect.gen(function* () {
          switch (params.action) {
            case "list": {
              const infos = yield* background.list()
              const rows: Row[] = infos.map((info) => ({
                id: info.id,
                status: info.status,
                kind: metaString(info.metadata, "kind") ?? "shell",
                description: metaString(info.metadata, "description"),
                command: info.title ?? info.id,
                startedAt: info.started_at,
                logPath: metaString(info.metadata, "logPath"),
                exit: exitOf(info),
              }))
              // stale leftovers from disk — check both legacy flat dir and new subdir
              const live = new Set(rows.map((row) => row.id))
              const scanDirs = [TRUNCATION_DIR, path.join(TRUNCATION_DIR, "job-output")]
              const entries: Array<{ name: string; dir: string }> = []
              for (const dir of scanDirs) {
                const chunk = yield* fs.readDirectoryEntries(dir).pipe(Effect.catch(() => Effect.succeed([] as any[])))
                for (const e of chunk as any[]) entries.push({ name: e.name, dir })
              }
              for (const { name, dir } of entries) {
                if (!name.startsWith("job_") || !name.endsWith(".json")) continue
                const meta = yield* fs.readJson(path.join(dir, name)).pipe(
                  Effect.catch(() => Effect.succeed(undefined)),
                )
                if (!meta || typeof meta !== "object") continue
                const m = meta as { id?: string; command?: string; startedAt?: number; kind?: string; description?: string }
                const id = m.id ?? jobFileStem(name.slice(0, -".json".length))
                if (!id || live.has(id)) continue
                rows.push({ id, status: "stale", kind: m.kind ?? "shell", description: m.description, command: m.command ?? id, startedAt: m.startedAt, logPath: jobLogPath(id) })
                live.add(id)
              }
              rows.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
              return {
                title: "background list",
                metadata: { action: "list", count: rows.length, jobs: rows },
                output: renderList(rows),
              }
            }

            case "status": {
              if (!params.id) throw new Error("status requires an id")
              const row = yield* jobRow(params.id)
              if (!row) throw new Error(`No such job: ${params.id}`)
              const lines = [
                `<job id="${row.id}" status="${row.status}" kind="${row.kind}">`,
                `<command>${row.command}</command>`,
                `Kind: ${row.kind}`,
                ...(row.description ? [`Description: ${row.description}`] : []),
                `Status: ${row.status}${row.exit !== null && row.exit !== undefined ? ` (exit ${row.exit})` : ""}`,
              ]
              if (row.startedAt) lines.push(`Started: ${new Date(row.startedAt).toISOString()}`)
              if (row.logPath) lines.push(`Log: ${row.logPath}`)
              const info = yield* background.get(params.id)
              if (info?.status === "error" && info.error) lines.push(`Error: ${info.error}`)
              if (info?.status === "completed" && info.output) {
                lines.push("")
                lines.push("Output tail:")
                lines.push(info.output.slice(0, 2000))
              }
              lines.push("</job>")
              return {
                title: `background status ${params.id}`,
                metadata: {
                  action: "status",
                  jobId: params.id,
                  status: row.status,
                  logPath: row.logPath,
                  exit: row.exit ?? null,
                  startedAt: row.startedAt,
                  timeoutMs: row.timeoutMs,
                },
                output: lines.join("\n"),
              }
            }

            case "read": {
              if (!params.id) throw new Error("read requires an id")
              const row = yield* jobRow(params.id)
              if (!row) throw new Error(`No such job: ${params.id}`)
              const logPath = row.logPath ?? jobLogPath(params.id)
              const offset = params.offset ?? 1
              const limit = params.limit ?? 2000
              const output = yield* readLog(logPath, offset, limit)
              return {
                title: `background read ${params.id}`,
                metadata: { action: "read", jobId: params.id, logPath },
                output,
              }
            }

            case "wait": {
              if (!params.id) throw new Error("wait requires an id")
              const result = yield* background.wait({
                id: params.id,
                ...(params.timeout !== undefined ? { timeout: params.timeout } : {}),
              })
              if (!result.info) {
                const stale = yield* jobRow(params.id)
                if (stale?.status === "stale") throw new Error(`job no longer running (instance restarted): ${params.id}`)
                throw new Error(`No such job: ${params.id}`)
              }
              const info = result.info
              const exit = exitOf(info)
              const lines = [
                `<job id="${info.id}" status="${info.status}">`,
                `Status: ${info.status}${exit !== null ? ` (exit ${exit})` : ""}`,
                ...(info.error ? [`Error: ${info.error}`] : []),
                ...(info.output ? ["", "Output tail:", info.output.slice(0, 2000)] : []),
                "</job>",
              ]
              return {
                title: `background wait ${params.id}`,
                metadata: {
                  action: "wait",
                  jobId: params.id,
                  status: info.status,
                  logPath: metaString(info.metadata, "logPath"),
                  exit,
                  timedOut: result.timedOut,
                  startedAt: info.started_at,
                },
                output: lines.join("\n"),
              }
            }

            case "send": {
              if (!params.id) throw new Error("send requires an id")
              if (params.input === undefined) throw new Error("send requires an input string")
              const entry = yield* jobs.get(params.id)
              if (!entry) {
                const info = yield* background.get(params.id)
                if (info) throw new Error(`job no longer running: ${params.id}`)
                throw new Error(`No such job: ${params.id}`)
              }
              yield* askCommand(ctx, "send", {
                id: params.id,
                status: "running",
                command: entry.command,
                logPath: entry.logPath,
              })
              const text = params.input.endsWith("\n") ? params.input : params.input + "\n"
              yield* Stream.run(Stream.make(new TextEncoder().encode(text)), entry.handle.stdin).pipe(
                Effect.catch(() => Effect.fail(new Error(`job no longer running: ${params.id}`))),
              )
              return {
                title: `background send ${params.id}`,
                metadata: { action: "send", jobId: params.id },
                output: `Sent input to job ${params.id}.`,
              }
            }

            case "kill": {
              if (!params.id) throw new Error("kill requires an id")
              const entry = yield* jobs.get(params.id)
              const info = yield* background.get(params.id)
              if (!entry && !info) {
                const stale = yield* jobRow(params.id)
                if (stale?.status === "stale") throw new Error(`job no longer running (instance restarted): ${params.id}`)
                throw new Error(`No such job: ${params.id}`)
              }
              const command = entry?.command ?? info?.title ?? params.id
              yield* askCommand(ctx, "kill", { id: params.id, status: "running", command, logPath: entry?.logPath })
              if (!info || info.status === "running") {
                // Cancel first: sets status "cancelled" deterministically and closes the
                // job scope (the spawn release kills the process). handle.kill after is a
                // belt-and-suspenders in case the release path is insufficient.
                yield* background.cancel(params.id).pipe(Effect.ignore)
                if (entry) yield* entry.handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.ignore)
              }
              const after = yield* background.get(params.id)
              return {
                title: `background kill ${params.id}`,
                metadata: { action: "kill", jobId: params.id, status: after?.status ?? "cancelled" },
                output: `Killed job ${params.id}. Status: ${after?.status ?? "cancelled"}.`,
              }
            }

            default:
              throw new Error(`Unknown background action: ${String(params.action)}`)
          }
        }).pipe(Effect.orDie),
    }
  }),
)
