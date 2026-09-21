import { describe, expect, test } from "bun:test"

/**
 * Tier D ownership regressions (05-verification.md § 2, T9 deliverables 1).
 *
 * These are NEGATIVE tests: they assert that something does not happen. They
 * are the cheapest and most valuable part of the suite because they fail the
 * moment a future change reintroduces a Tier 3 dependency into the Tier 0
 * scheduling surface.
 */

const repoRoot = new URL("../../../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")

const scheduledTaskSources = [
  "packages/opencode/src/scheduled-task/runner.ts",
  "packages/opencode/src/scheduled-task/executor.ts",
  "packages/core/src/scheduled-task.ts",
  "packages/core/src/scheduled-task/agent.ts",
  "packages/core/src/scheduled-task/creation-policy.ts",
  "packages/core/src/scheduled-task/index.ts",
  "packages/core/src/scheduled-task/lease.ts",
  "packages/core/src/scheduled-task/policy.ts",
  "packages/core/src/scheduled-task/recurrence.ts",
  "packages/core/src/scheduled-task/schema.ts",
  "packages/core/src/scheduled-task/sql.ts",
  "packages/opencode/src/server/routes/instance/httpapi/groups/scheduled-task.ts",
  "packages/opencode/src/server/routes/instance/httpapi/handlers/scheduled-task.ts",
  "packages/opencode/src/tool/scheduled-task.ts",
]

async function source(path: string): Promise<string> {
  return Bun.file(`${repoRoot}/${path}`).text()
}

/** Comments may discuss the prohibition; only executable code must obey it. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
}

describe("D7: Tier 0 scheduling infrastructure never imports InstanceStore", () => {
  test("only executor.ts may import InstanceStore", async () => {
    const offenders: string[] = []
    for (const path of scheduledTaskSources) {
      const text = await source(path)
      const importsInstanceStore = /from\s+["']@\/project\/instance-store["']/.test(text) || /\bInstanceStore\b/.test(text)
      if (importsInstanceStore && !path.endsWith("executor.ts")) offenders.push(path)
    }
    expect(offenders).toEqual([])
  })

  test("the executor imports InstanceStore exactly once and it is the real Tier 3 boundary", async () => {
    const text = await source("packages/opencode/src/scheduled-task/executor.ts")
    const matches = text.match(/@\/project\/instance-store/g) ?? []
    expect(matches).toHaveLength(1)
    expect(text).toContain("TIER 3 BOUNDARY")
  })

  test("core scheduled-task modules never reference the execution runtime at all", async () => {
    const core = scheduledTaskSources.filter((path) => path.startsWith("packages/core/"))
    for (const path of core) {
      const text = await source(path)
      expect(text).not.toMatch(/instance-store|InstanceStore|SessionPrompt|@\/session|@\/project/)
    }
  })
})

describe("D5: unattended execution never reads process.cwd()", () => {
  test("no scheduled-task source falls back to the current working directory", async () => {
    for (const path of scheduledTaskSources) {
      const text = stripComments(await source(path))
      expect(text).not.toContain("process.cwd")
    }
  })

  test("the executor stats the target before loading any Instance", async () => {
    const text = await source("packages/opencode/src/scheduled-task/executor.ts")
    const targetIndex = text.indexOf("const targetDirectory = task.targetDirectory")
    const statIndex = text.indexOf("isDir(targetDirectory)")
    const loadIndex = text.indexOf("store.provide(")
    expect(targetIndex).toBeGreaterThan(-1)
    expect(statIndex).toBeGreaterThan(-1)
    expect(statIndex).toBeGreaterThan(targetIndex)
    expect(loadIndex).toBeGreaterThan(statIndex)
  })
})

describe("Tier 0 group placement (D1/D2 ownership by construction)", () => {
  test("all scheduled-task transport, including runNow enqueue, is on RootHttpApi", async () => {
    const api = await source("packages/opencode/src/server/routes/instance/httpapi/api.ts")
    const root = api.slice(api.indexOf("export const RootHttpApi"), api.indexOf("export const InstanceHttpApi"))
    const instance = api.slice(api.indexOf("export const InstanceHttpApi"), api.indexOf("export const OpenCodeHttpApi"))
    expect(root).toContain(".addHttpApi(ScheduledTaskApi)")
    expect(instance).not.toContain("ScheduledTaskApi)")
    expect(api).not.toContain("ScheduledTaskRuntimeApi")
  })

  test("the Tier 0 group and handler declare no instance/runtime dependency", async () => {
    const group = await source("packages/opencode/src/server/routes/instance/httpapi/groups/scheduled-task.ts")
    const handler = await source("packages/opencode/src/server/routes/instance/httpapi/handlers/scheduled-task.ts")
    expect(group).not.toContain("InstanceContextMiddleware")
    expect(group).not.toContain("WorkspaceRoutingMiddleware")
    expect(group).toContain('HttpApiEndpoint.post("runNow"')
    expect(handler).not.toContain("InstanceHttpApi")
    expect(handler).not.toContain('from "@/scheduled-task/runner"')
    expect(handler).not.toContain("yield* ScheduledTaskRunner.Service")
  })
})

describe("agent-created schedules preserve the Tier 0 admission boundary", () => {
  test("the conversational admission path does not import execution/runtime ownership", async () => {
    const agent = stripComments(await source("packages/core/src/scheduled-task/agent.ts"))
    const tool = stripComments(await source("packages/opencode/src/tool/scheduled-task.ts"))
    const combined = agent + "\n" + tool
    expect(combined).not.toMatch(/InstanceStore|InstanceState|ScheduledTaskRunner|ScheduledTaskExecutor/)
    expect(agent).toContain("SessionStore")
    expect(agent).toContain('source: "agent"')
    expect(agent).toContain("sourceMessageID")
  })

  test("scheduled_task is provider-visible and backed by the shared Core agent service", async () => {
    const registry = await source("packages/opencode/src/tool/registry.ts")
    expect(registry).toContain('import { ScheduledTaskTool } from "./scheduled-task"')
    expect(registry).toContain("ScheduledTaskAgent.node")
    expect(registry).toContain("tool.scheduledTask")
  })

  test("public HTTP creation cannot forge trusted agent creation provenance", async () => {
    const group = await source("packages/opencode/src/server/routes/instance/httpapi/groups/scheduled-task.ts")
    const create = group.slice(group.indexOf("export const CreatePayload"), group.indexOf("export const UpdatePayload"))
    expect(create).not.toContain("sourceMessageID")
    expect(create).not.toMatch(/\bsource\s*:/)
  })

  test("conversational create has no idempotency preflight on the uncontended hot path", async () => {
    const agent = stripComments(await source("packages/core/src/scheduled-task/agent.ts"))
    const createIndex = agent.indexOf("tasks.create({")
    const recoveryIndex = agent.indexOf("tasks.findByName(")
    expect(createIndex).toBeGreaterThan(-1)
    expect(recoveryIndex).toBeGreaterThan(createIndex)
  })
})

describe("provenance ownership follows the shared Session turn contract", () => {
  test("scheduled admission owns canonical host/run provenance and revalidates durable run correlation atomically", async () => {
    const admission = stripComments(await source("packages/opencode/src/scheduled-task/session-admission.ts"))
    const executor = stripComments(await source("packages/opencode/src/scheduled-task/executor.ts"))
    expect(admission).toContain("SessionTurnProvenance.Source.ScheduledTaskRun")
    expect(admission).toContain("actor: { type: \"host\" }")
    expect(admission).toContain("ref: input.runID")
    expect(admission).toContain("tasks.authorizeRunSession({")
    expect(admission).toContain("ScheduledTask.authorizeRunSessionIn(db")
    expect(executor).not.toContain("SessionTurnProvenance.Source.ScheduledTaskRun")
  })

  test("public PromptInput cannot submit provenance; trusted host admission owns construction", async () => {
    const prompt = await source("packages/opencode/src/session/prompt.ts")
    const contract = await source("packages/opencode/src/session/prompt-contract.ts")
    const input = contract.slice(contract.indexOf("export const PromptInput"), contract.indexOf("export type PromptInput"))
    expect(input).not.toContain("provenance")
    expect(contract).toContain('readonly source: SessionTurnProvenance.CanonicalHostSource')
    expect(prompt).toContain("const source = provenance?.source ?? SessionTurnProvenance.Source.HostPrompt")
    expect(prompt).toContain("SessionTurnProvenance.host(source")
  })
})

describe("D3/D4/N2: one timer, no polling loop", () => {
  test("the runner uses a single clamped timer and never setInterval", async () => {
    const runner = await source("packages/opencode/src/scheduled-task/runner.ts")
    expect(runner).not.toContain("setInterval")
    expect(runner).toContain("MAX_SLEEP_MS")
    // Exactly one scheduling sleep; the startup grace and heartbeat cadence are
    // lifecycle waits, not additional timers.
    expect((runner.match(/Effect\.sleep\(delay\)/g) ?? []).length).toBe(1)
  })

  test("N8: sub-minute schedules are rejected so the event rate is bounded", async () => {
    const { validateSchedule } = await import("@opencode-ai/core/scheduled-task/recurrence")
    const rejected = validateSchedule({ kind: "cron", expression: "* * * * * *" })
    expect(rejected.ok).toBe(false)
    expect(rejected.ok ? "" : rejected.reason).toContain("seconds")
  })
})

describe("N9: on-time due scans perform zero recurrence evaluation", () => {
  test("the grace-window fast path returns before any recurrence call", async () => {
    const policy = await source("packages/core/src/scheduled-task/policy.ts")
    const decision = policy.slice(policy.indexOf("export function decideDue"), policy.indexOf("export function missedInstants"))
    const graceIndex = decision.indexOf("LATE_GRACE_MS")
    const recurrenceIndex = decision.indexOf("nextOccurrence(")
    expect(graceIndex).toBeGreaterThan(-1)
    expect(recurrenceIndex).toBeGreaterThan(graceIndex)
  })
})
