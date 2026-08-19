import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit } from "effect"
import { afterEach, describe, expect } from "bun:test"
import path from "path"
import type { Tool } from "../../src/tool/tool"
import { Shell } from "@opencode-ai/core/shell"
import { ToolRegistry } from "@/tool/registry"
import { BackgroundTool } from "../../src/tool/background"
import { disposeAllInstances } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect, pollWithTimeout } from "../lib/effect"
import { TRUNCATION_DIR } from "../../src/tool/truncation-dir"

const baseCtx: Omit<Tool.Context, "ask" | "extra"> = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(LayerNode.compile(LayerNode.group([ToolRegistry.node])))

type Ask = Omit<PermissionV1.Request, "id" | "sessionID" | "tool">
type PromptCall = {
  sessionID: string
  agent: string | undefined
  parts: { type: string; synthetic: boolean; text: string }[]
}

const harness = (extra: Record<string, unknown> = {}) => {
  const asks: Ask[] = []
  const prompts: PromptCall[] = []
  const promptOps = {
    cancel: () => Effect.void,
    resolvePromptParts: () => Effect.succeed([] as never[]),
    prompt: (input: {
      sessionID: SessionID
      agent?: string
      parts: { type: "text"; synthetic: boolean; text: string }[]
    }) =>
      Effect.sync(() => {
        prompts.push({
          sessionID: String(input.sessionID),
          agent: input.agent,
          parts: input.parts,
        })
        return {} as never
      }),
  }
  const ctx: Tool.Context = {
    ...baseCtx,
    extra: { promptOps, ...extra },
    ask: (req: Ask) =>
      Effect.sync(() => {
        asks.push(req)
      }),
  }
  return { asks, prompts, ctx }
}

const toolByID = (registry: ToolRegistry.Interface, id: string) =>
  registry
    .tools({
      providerID: "opencode" as any,
      modelID: "gpt-5" as any,
      agent: { name: "build", mode: "primary" as const, permission: [], options: {} },
    })
    .pipe(Effect.map((list) => list.find((t) => t.id === id)))

const bin = `"${process.execPath.replaceAll("\\", "/")}"`
const shName = () => Shell.name(Shell.acceptable())
const evalarg = (text: string) => (shName() === "cmd" ? `"${text}"` : `'${text}'`)
const command = (code: string) => {
  const text = `${bin} -e ${evalarg(code)}`
  return ["pwsh", "powershell"].includes(shName()) ? `& ${text}` : text
}

// Long-running script: prints a marker, then waits ~30s so the job stays running.
const slow = command(`console.log("slow-start"); setTimeout(() => {}, 30000)`)
// Immediate success: prints output and exits 0.
const fast = command(`console.log("fast-done")`)
// Immediate failure: exits 7.
const failing = command(`console.log("fail-line"); process.exit(7)`)
// Reads stdin and echoes each line back.
const reader = command(
  `let d=""; process.stdin.on("data", c => { d += c; process.stdout.write("echo:" + d.split("\\n").filter(Boolean).join("|")) })`,
)

const shell = () =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const shellTool = yield* toolByID(registry, "bash")
    if (!shellTool) throw new Error("bash tool not found")
    const backgroundTool = yield* toolByID(registry, BackgroundTool.id)
    if (!backgroundTool) throw new Error("background tool not found")
    return { shellTool, backgroundTool }
  })

describe("tool.background", () => {
  it.instance("starts a background job, returns immediately, and completes", () =>
    Effect.gen(function* () {
      const { shellTool, backgroundTool } = yield* shell()
      const { asks, ctx } = harness()

      const start = yield* shellTool.execute({ command: fast, background: true }, ctx)
      expect(start.metadata.background).toBe(true)
      const jobId = start.metadata.jobId as string
      expect(jobId).toMatch(/^job_/)
      expect(start.metadata.logPath).toContain("job_")
      // Launch asks only the normal bash permission (plus external_directory if any)
      expect(asks.map((a) => a.permission)).toContain("bash")

      const done = yield* pollWithTimeout(
        Effect.gen(function* () {
          const status = yield* backgroundTool.execute({ action: "status", id: jobId }, ctx)
          return status.metadata.status === "completed" ? (status.metadata.status as string) : undefined
        }),
        `job ${jobId} never completed`,
      )
      expect(done).toBe("completed")

      const read = yield* backgroundTool.execute({ action: "read", id: jobId }, ctx)
      expect(read.output).toContain("fast-done")

      const listed = yield* backgroundTool.execute({ action: "list" }, ctx)
      expect(listed.output).toContain(jobId)
      // read-only actions must not ask for permissions
      expect(asks.filter((a) => a.permission === "bash").length).toBe(1)
    }),
  )

  it.instance("reports error status with exit code on non-zero exit", () =>
    Effect.gen(function* () {
      const { shellTool, backgroundTool } = yield* shell()
      const { ctx } = harness()
      const start = yield* shellTool.execute({ command: failing, background: true }, ctx)
      const jobId = start.metadata.jobId as string

      const status = yield* pollWithTimeout(
        Effect.gen(function* () {
          const s = yield* backgroundTool.execute({ action: "status", id: jobId }, ctx)
          return s.metadata.status === "error" ? (s.metadata.status as string) : undefined
        }),
        `job ${jobId} never errored`,
      )
      expect(status).toBe("error")
      const detail = yield* backgroundTool.execute({ action: "status", id: jobId }, ctx)
      expect(detail.output).toContain("7")
      expect(detail.output).toContain("fail-line")
    }),
  )

  it.instance("injects a completion notification via promptOps when notify is true", () =>
    Effect.gen(function* () {
      const { shellTool } = yield* shell()
      const { prompts, ctx } = harness()
      const start = yield* shellTool.execute({ command: fast, background: true, notify: true }, ctx)
      const jobId = start.metadata.jobId as string

      const injected = yield* pollWithTimeout(
        Effect.gen(function* () {
          const call = prompts.find((p) => p.parts.some((part) => part.text.includes(`job="${jobId}"`)))
          return call ? (call.parts[0].text as string) : undefined
        }),
        `completion notification for ${jobId} never injected`,
      )
      expect(injected).toContain(`state="completed"`)
      expect(injected).toContain("Background command completed")
      expect(injected).toContain("fast-done")
    }),
  )

  it.instance("does not inject when notify is false", () =>
    Effect.gen(function* () {
      const { shellTool, backgroundTool } = yield* shell()
      const { prompts, ctx } = harness()
      const start = yield* shellTool.execute({ command: fast, background: true, notify: false }, ctx)
      const jobId = start.metadata.jobId as string

      yield* pollWithTimeout(
        Effect.gen(function* () {
          const s = yield* backgroundTool.execute({ action: "status", id: jobId }, ctx)
          return s.metadata.status === "completed" ? true : undefined
        }),
        `job ${jobId} never completed`,
      )
      yield* Effect.sleep("300 millis")
      expect(prompts.length).toBe(0)
    }),
  )

  it.instance("kill cancels the job and never injects", () =>
    Effect.gen(function* () {
      const { shellTool, backgroundTool } = yield* shell()
      const { asks, prompts, ctx } = harness()
      const start = yield* shellTool.execute({ command: slow, background: true, notify: true }, ctx)
      const jobId = start.metadata.jobId as string

      yield* pollWithTimeout(
        Effect.gen(function* () {
          const s = yield* backgroundTool.execute({ action: "status", id: jobId }, ctx)
          return s.metadata.status === "running" ? true : undefined
        }),
        `job ${jobId} never became running`,
      )

      const killed = yield* backgroundTool.execute({ action: "kill", id: jobId }, ctx)
      expect(killed.metadata.status).toBe("cancelled")
      // kill asks for bash permission with the job's original command
      const bashAsk = asks.find((a) => a.permission === "bash" && a.metadata?.action === "kill")
      expect(bashAsk).toBeDefined()
      expect(bashAsk!.patterns).toContain(slow)

      const status = yield* backgroundTool.execute({ action: "status", id: jobId }, ctx)
      expect(status.metadata.status).toBe("cancelled")
      yield* Effect.sleep("300 millis")
      expect(prompts.length).toBe(0)
    }),
  )

  it.instance("explicit timeout kills the job and injects cancelled/reason=timeout", () =>
    Effect.gen(function* () {
      const { shellTool, backgroundTool } = yield* shell()
      const { prompts, ctx } = harness()
      const start = yield* shellTool.execute(
        { command: slow, background: true, notify: true, timeout: 400 },
        ctx,
      )
      const jobId = start.metadata.jobId as string

      const injected = yield* pollWithTimeout(
        Effect.gen(function* () {
          const call = prompts.find((p) => p.parts.some((part) => part.text.includes(`job="${jobId}"`)))
          return call ? (call.parts[0].text as string) : undefined
        }),
        `timeout notification for ${jobId} never injected`,
      )
      expect(injected).toContain(`state="cancelled"`)
      expect(injected).toContain(`reason="timeout"`)
      expect(injected).toContain("timed out after 400 ms")

      const status = yield* backgroundTool.execute({ action: "status", id: jobId }, ctx)
      expect(status.metadata.status).toBe("cancelled")
    }),
  )

  it.instance("wait blocks until completion and returns the tail", () =>
    Effect.gen(function* () {
      const { shellTool, backgroundTool } = yield* shell()
      const { ctx } = harness()
      const start = yield* shellTool.execute({ command: fast, background: true, notify: false }, ctx)
      const jobId = start.metadata.jobId as string

      const waited = yield* backgroundTool.execute({ action: "wait", id: jobId, timeout: 10_000 }, ctx)
      expect(waited.metadata.status).toBe("completed")
      expect(waited.output).toContain("fast-done")
    }),
  )

  it.instance("send writes to the job's stdin", () =>
    Effect.gen(function* () {
      const { shellTool, backgroundTool } = yield* shell()
      const { ctx } = harness()
      const start = yield* shellTool.execute({ command: reader, background: true, notify: false }, ctx)
      const jobId = start.metadata.jobId as string

      yield* pollWithTimeout(
        Effect.gen(function* () {
          const s = yield* backgroundTool.execute({ action: "status", id: jobId }, ctx)
          return s.metadata.status === "running" ? (s.metadata.status as string) : undefined
        }),
        `job ${jobId} never became running`,
      )

      yield* backgroundTool.execute({ action: "send", id: jobId, input: "hello" }, ctx)
      const read = yield* pollWithTimeout(
        Effect.gen(function* () {
          const r = yield* backgroundTool.execute({ action: "read", id: jobId }, ctx)
          return r.output.includes("echo:hello") ? r.output : undefined
        }),
        `stdin echo never appeared for ${jobId}`,
      )
      expect(read).toContain("echo:hello")

      // cleanup
      yield* backgroundTool.execute({ action: "kill", id: jobId }, ctx)
    }),
  )

  it.instance("read returns (no output yet) for an empty log and respects offset/limit", () =>
    Effect.gen(function* () {
      const { shellTool, backgroundTool } = yield* shell()
      const { ctx } = harness()
      const start = yield* shellTool.execute(
        { command: command(`console.log("line1"); console.log("line2"); console.log("line3")`), background: true },
        ctx,
      )
      const jobId = start.metadata.jobId as string
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const s = yield* backgroundTool.execute({ action: "status", id: jobId }, ctx)
          return s.metadata.status === "completed" ? true : undefined
        }),
        `job ${jobId} never completed`,
      )
      const read = yield* backgroundTool.execute({ action: "read", id: jobId, offset: 2, limit: 1 }, ctx)
      expect(read.output).toContain("line2")
      expect(read.output).not.toContain("line1")
    }),
  )

  it.instance("unknown job ids error clearly", () =>
    Effect.gen(function* () {
      const { backgroundTool } = yield* shell()
      const { ctx } = harness()
      for (const action of ["status", "read", "wait", "kill", "send"] as const) {
        const exit = yield* backgroundTool
          .execute({ action, id: "nope", input: action === "send" ? "x" : undefined } as any, ctx)
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit), `action ${action} should fail`).toBe(true)
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause)
          expect(error instanceof Error ? error.message : String(error)).toContain("No such job: nope")
        }
      }
    }),
  )

  it.instance("custom id collisions are rejected", () =>
    Effect.gen(function* () {
      const { shellTool } = yield* shell()
      const { ctx } = harness()

      // Pre-create a stale log on disk so the custom id is rejected at launch.
      yield* Effect.promise(() => Bun.write(path.join(TRUNCATION_DIR, "job_custom1.log"), "stale"))

      const exit = yield* shellTool
        .execute({ command: fast, background: true, id: "custom1" }, ctx)
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(error instanceof Error ? error.message : String(error)).toContain("already in use")
      }

      // Same custom id launched twice is also rejected.
      const first = yield* shellTool.execute({ command: fast, background: true, id: "bg2" }, ctx).pipe(Effect.exit)
      expect(Exit.isFailure(first), "first bg2 launch should succeed").toBe(false)
      const second = yield* shellTool.execute({ command: fast, background: true, id: "bg2" }, ctx).pipe(Effect.exit)
      expect(Exit.isFailure(second)).toBe(true)
      if (Exit.isFailure(second)) {
        const error = Cause.squash(second.cause)
        expect(error instanceof Error ? error.message : String(error)).toContain("already in use")
      }
    }),
  )

  it.instance("list shows stale jobs from on-disk meta after restart", () =>
    Effect.gen(function* () {
      const { backgroundTool } = yield* shell()
      const { ctx } = harness()
      yield* Effect.promise(() =>
        Bun.write(
          path.join(TRUNCATION_DIR, "job_ghost.json"),
          JSON.stringify({ id: "job_ghost", command: "echo ghost", startedAt: Date.now() }),
        ),
      )
      const listed = yield* backgroundTool.execute({ action: "list" }, ctx)
      // jobFileStem strips a leading "job_" prefix, so "job_ghost" displays as "ghost"
      expect(listed.output).toContain("ghost")
      expect(listed.output).toContain("stale")
      expect(listed.output).toContain("echo ghost")
      // read works on a stale job (id still resolves through the on-disk meta)
      const read = yield* backgroundTool.execute({ action: "read", id: "job_ghost" }, ctx)
      expect(read.output).toBe("(no output yet)")
    }),
  )
})
