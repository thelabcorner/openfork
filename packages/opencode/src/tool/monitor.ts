import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./monitor.txt"
import { Config } from "@/config/config"
import { Shell } from "@opencode-ai/core/shell"
import { ShellID } from "./shell/id"
import { containsPath } from "../project/instance-context"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Plugin } from "@/plugin"
import { ShellJob } from "@/background/shell-job"
import { InstanceState } from "@/effect/instance-state"
import path from "path"

export const Parameters = Schema.Struct({
  command: Schema.String.annotate({ description: "Long-running shell command whose stdout lines are meaningful future events. The command must stay quiet until a meaningful state change; every stdout line may wake the agent, so filter noisy output at the source (e.g. grep --line-buffered)." }),
  description: Schema.String.annotate({ description: "Short specific description of what is being watched (e.g. 'quota source files changed', 'CI checks for PR 482'). Shown in UI and event envelopes." }),
  workdir: Schema.optional(Schema.String).annotate({ description: "Working directory for the command (defaults to project root). Use this instead of cd." }),
  timeout_ms: Schema.optional(Schema.Number).annotate({ description: "Optional timeout in milliseconds (default 300000 = 5 min). Persistent monitors use no timeout unless set." }),
  id: Schema.optional(Schema.String).annotate({ description: "Optional short job id, e.g. 'mon1'. Must match ^[A-Za-z0-9_-]+$. Auto-generated if omitted." }),
  persistent: Schema.optional(Schema.Boolean).annotate({ description: "If true, monitor runs until explicitly killed (no timeout). Default false (5 min timeout)." }),
})
export type Params = Schema.Schema.Type<typeof Parameters>

const escapeXML = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

function renderStarted(jobId: string, command: string, description: string, logPath: string, persistent: boolean) {
  return [
    `<monitor job="${jobId}" state="monitoring">`,
    `  <summary>Monitoring ${escapeXML(description)}</summary>`,
    `  <description>${escapeXML(description)}</description>`,
    `  <command>${escapeXML(command)}</command>`,
    ``,
    `  The monitor is running asynchronously.`,
    `  Each meaningful stdout line may wake you in a future turn (200 ms batched).`,
    `  Do not sleep or poll this job.`,
    ``,
    `  Underlying background job: ${jobId}`,
    `  Use the \`background\` tool with that ID to read, inspect, send input, wait, or kill.`,
    `  Full output streams to: ${logPath}`,
    `  ${persistent ? "Persistent: runs until killed." : "Timeout: 5 min (pass persistent=true or timeout_ms to change)."}`,
    `</monitor>`,
  ].join("\n")
}

export const MonitorTool = Tool.define(
  "monitor",
  Effect.gen(function* () {
    const config = yield* Config.Service
    const plugin = yield* Plugin.Service
    const shellJob = yield* ShellJob.Service
    const fs = yield* FSUtil.Service

    const resolvePath = Effect.fn("MonitorTool.resolvePath")(function* (text: string, root: string, _shell: string) {
      if (process.platform === "win32") return FSUtil.normalizePath(path.resolve(root, FSUtil.windowsPath(text)))
      return path.resolve(root, text)
    })

    const shellEnv = Effect.fn("MonitorTool.shellEnv")(function* (ctx: Tool.Context, cwd: string) {
      const extra = yield* plugin.trigger("shell.env", { cwd, sessionID: ctx.sessionID, callID: ctx.callID }, { env: {} })
      return { ...process.env, ...extra.env }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context) =>
        Effect.gen(function* () {
          // Subagent guard (§66) — deny monitor to subagents in V1
          if ((ctx.extra as any)?.bypassAgentCheck === true) throw new Error("Monitor is not available to subagents in V1")
          try {
            const agentService: any = yield* Effect.serviceOption((yield* Effect.promise(() => import("@/agent/agent"))).Agent.Service).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (agentService) {
              const ag = yield* agentService.get(ctx.agent).pipe(Effect.catch(() => Effect.succeed(undefined)))
              if (ag && ag.mode === "subagent") throw new Error("Monitor is not available to subagents in V1 — run it from the primary session.")
            }
          } catch {}

          const cfg = yield* config.get()
          const shell = Shell.acceptable(cfg.shell)

          let instance: any
          try {
            instance = yield* (InstanceState as any).context
          } catch {
            instance = { directory: process.cwd(), worktree: process.cwd() }
          }

          const cwd = params.workdir ? yield* resolvePath(params.workdir, instance.directory, shell) : instance.directory

          if (!params.description || params.description.trim().length === 0) throw new Error("description is required — short label for what is being watched")

          // Permissions — same authority as shell: external_directory + bash patterns
          // Simple external dir check for cwd
          if (!containsPath(cwd, instance)) {
            const dir = cwd
            const globs = [process.platform === "win32" ? FSUtil.normalizePathPattern(path.join(dir, "*")) : path.join(dir, "*")]
            yield* ctx.ask({ permission: "external_directory", patterns: globs, always: globs, metadata: { command: params.command, directories: [dir], patterns: globs } })
          }
          // Shell command permission — mirror shell tool's Bash patterns (simplified)
          const tokens = params.command.trim().split(/\s+/)
          const prefix = tokens.slice(0, 2).join(" ") + " *"
          yield* ctx.ask({ permission: ShellID.ToolID, patterns: [params.command], always: [prefix], metadata: { command: params.command } })

          const env = yield* shellEnv(ctx, cwd)

          // Determine timeout: persistent => no timeout, else timeout_ms or 5min default
          const persistent = params.persistent ?? false
          let timeoutMs: number | undefined
          if (persistent) timeoutMs = params.timeout_ms
          else timeoutMs = params.timeout_ms ?? 5 * 60 * 1000

          // Launch via shared runtime
          const job = yield* shellJob.launch(
            {
              command: params.command,
              shell,
              cwd,
              env,
              kind: "monitor",
              delivery: {
                mode: "events",
                ownerSessionID: ctx.sessionID as any,
                description: params.description,
                debounceMs: 200,
                eventStream: "stdout",
              },
              description: params.description,
              timeoutMs,
              id: params.id,
            },
            ctx as any,
          )

          return {
            title: `monitor ${params.description}`,
            metadata: {
              jobId: job.jobId,
              logPath: job.logPath,
              kind: "monitor",
              description: params.description,
              command: params.command,
              persistent,
              timeoutMs,
            },
            output: renderStarted(job.jobId, params.command, params.description, job.logPath, persistent),
          }
        }).pipe(Effect.orDie) as any,
    }
  }),
)
