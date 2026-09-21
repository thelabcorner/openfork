/**
 * Performance budget measurement (05-verification.md § 5).
 *
 * Run from packages/core:
 *   bun test/scheduled-task/bench-scheduler.ts
 *
 * Prints actual numbers next to the documented budget. This is a measurement
 * tool, not a pass/fail test: closeout records the numbers as measured.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { ScheduledTask } from "@opencode-ai/core/scheduled-task"
import { ScheduledTaskAgent } from "@opencode-ai/core/scheduled-task/agent"
import { ScheduledTaskLease } from "@opencode-ai/core/scheduled-task/lease"
import { ScheduledTaskSessionBinding } from "@opencode-ai/core/scheduled-task/session-binding"
import { ScheduledTaskRunTable } from "@opencode-ai/core/scheduled-task/sql"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-st-bench-"))
const dbPath = path.join(directory, "bench.sqlite")
const T0 = Date.parse("2026-06-01T00:00:00Z")

const layer = AppNodeBuilder.build(
  LayerNode.group([
    Database.node,
    EventV2.node,
    ScheduledTask.node,
    ScheduledTaskSessionBinding.node,
    ScheduledTaskLease.node,
    ScheduledTaskAgent.node,
  ]),
  [[Database.node, Database.layerFromPath(dbPath)]],
)

const measure = <A>(label: string, effect: Effect.Effect<A>) =>
  Effect.gen(function* () {
    const started = performance.now()
    const value = yield* effect
    return { label, ms: performance.now() - started, value }
  })

const program = Effect.gen(function* () {
  const tasks = yield* ScheduledTask.Service
  const { db } = yield* Database.Service

  // 500 tasks, one indexed list query.
  yield* Effect.forEach(
    Array.from({ length: 500 }, (_, index) => index),
    (index) =>
      tasks.create({
        targetDirectory: "/scheduled/bench",
        name: `bench-${index}`,
        enabled: true,
        schedule: { kind: "daily", times: [{ hour: 9, minute: 0 }] },
        timezone: "America/New_York",
        action: { prompt: "hello" },
        now: T0,
      }),
    { concurrency: 1, discard: true },
  )

  const listTiming = yield* measure("list 500 tasks (one indexed query)", tasks.list({}))
  const timerTiming = yield* measure("nextDueAt (MIN cursor re-arm)", tasks.nextDueAt(T0))
  const agendaTiming = yield* measure(
    "agenda 30d across 500 daily tasks (bounded to 5000 rows)",
    tasks.agenda({ from: T0, to: T0 + 30 * 24 * 60 * 60 * 1_000, limit: 5_000 }),
  )
  const generationIterations = 1_000
  const generationTiming = yield* measure(
    `generation x${generationIterations} (idle cross-process liveness probe)`,
    Effect.forEach(Array.from({ length: generationIterations }), () => tasks.generation(), {
      concurrency: 1,
      discard: true,
    }),
  )

  // 50,000 settled run rows across the 500 tasks.
  const all = yield* tasks.list()
  const rows = Array.from({ length: 50_000 }, (_, index) => ({
    id: ScheduledTask.RunID.make(`str_bench_${index}`),
    task_id: all[index % all.length]!.id,
    fire_for: T0 + index,
    trigger: "schedule" as const,
    status: "succeeded" as const,
    acknowledged_at: T0 + index,
    started_at: T0 + index,
    finished_at: T0 + index,
  }))
  for (let offset = 0; offset < rows.length; offset += 5_000) {
    yield* db
      .insert(ScheduledTaskRunTable)
      .values(rows.slice(offset, offset + 5_000))
      .run()
      .pipe(Effect.orDie)
  }

  const inboxTiming = yield* measure("inbox newest 50 across 50k runs", tasks.inbox({ limit: 50 }))
  const unreadTiming = yield* measure("unread count across 50k runs", tasks.unreadCount())

  // Conversational creation hot path: one durable Session PK read followed by
  // the canonical create transaction. Unique names ensure this measures normal
  // creation rather than the duplicate/replay recovery path.
  const projectID = ProjectV2.ID.make("scheduled-bench-agent-project")
  const sessionID = SessionV2.ID.make("ses_scheduled_bench_agent")
  yield* db
    .insert(ProjectTable)
    .values({ id: projectID, worktree: AbsolutePath.make("/scheduled/bench-agent"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: projectID,
      slug: "scheduled-bench-agent",
      directory: "/scheduled/bench-agent",
      title: "Scheduled benchmark",
      version: "bench",
    })
    .run()
    .pipe(Effect.orDie)
  const agent = yield* ScheduledTaskAgent.Service
  const bindings = yield* ScheduledTaskSessionBinding.Service
  const reusable = yield* tasks.create({
    projectID,
    targetDirectory: "/scheduled/bench-agent",
    name: "binding-bench",
    enabled: false,
    schedule: { kind: "daily", times: [{ hour: 9, minute: 0 }] },
    timezone: "America/New_York",
    action: { prompt: "hello" },
    sessionPolicy: { kind: "reuse" },
    now: T0,
  })
  yield* bindings.install({
    taskID: reusable.id,
    taskRevision: reusable.revision,
    sessionID,
    expectedGeneration: undefined,
    now: T0,
  })
  const extraCandidates = Array.from({ length: 99 }, (_, index) => ({
    id: SessionV2.ID.make(`ses_scheduled_bench_candidate_${index}`),
    project_id: projectID,
    slug: `scheduled-bench-candidate-${index}`,
    directory: "/scheduled/bench-agent",
    title: `Candidate ${index}`,
    version: "bench",
    time_created: T0 + index + 1,
    time_updated: T0 + index + 1,
  }))
  yield* db.insert(SessionTable).values(extraCandidates).run().pipe(Effect.orDie)

  const bindingIterations = 1_000
  const bindingTiming = yield* measure(
    `binding get x${bindingIterations} (Tier-0 scalar projection)`,
    Effect.forEach(Array.from({ length: bindingIterations }), () => bindings.get(reusable.id), {
      concurrency: 1,
      discard: true,
    }),
  )
  const candidateIterations = 100
  const candidateTiming = yield* measure(
    `Session candidates x${candidateIterations} (100 compact roots)`,
    Effect.forEach(
      Array.from({ length: candidateIterations }),
      () => bindings.candidates({ targetDirectory: "/scheduled/bench-agent", projectID, limit: 100 }),
      { concurrency: 1 },
    ),
  )
  const conversationalIterations = 100
  const conversationalTiming = yield* measure(
    `conversational create x${conversationalIterations} (uncontended)`,
    Effect.forEach(
      Array.from({ length: conversationalIterations }, (_, index) => index),
      (index) =>
        agent
          .create(
            sessionID,
            {
              name: `agent-bench-${index}`,
              schedule: { kind: "daily", times: [{ hour: 9, minute: 0 }] },
              timezone: "America/New_York",
              prompt: "hello",
            },
            { userMessageID: `msg_agent_bench_${index}`, userText: "Schedule this every day at 9." },
          )
          .pipe(Effect.orDie),
      { concurrency: 1, discard: true },
    ),
  )

  const output = {
    budget: {
      list500: "<10ms, one indexed query, 0 instance loads",
      inbox50k: "<20ms",
      timerRearm: "one MIN(next_run_at) query",
      idleGenerationProbe: "one primary-key scalar read per 60s while truly idle",
      conversationalCreate: "1 Session PK read + canonical create transaction; 0 preflight lookup; 0 Instance loads",
      agenda30d: "one bounded Tier-0 request per visible window; <=32 days; <=5000 compact rows; 0 Instance loads",
      bindingRead: "Tier-0 scalar read; 0 Instance loads",
      sessionCandidates: "bounded compact root projection; no history hydration; 0 Instance loads",
    },
    measured: {
      list500Ms: Number(listTiming.ms.toFixed(2)),
      listRows: (listTiming.value as unknown[]).length,
      nextDueAtMs: Number(timerTiming.ms.toFixed(2)),
      nextDueAt: timerTiming.value,
      agenda30dMs: Number(agendaTiming.ms.toFixed(2)),
      agenda30dRows: (agendaTiming.value as unknown[]).length,
      generation1000Ms: Number(generationTiming.ms.toFixed(2)),
      generationAverageUs: Number(((generationTiming.ms * 1000) / generationIterations).toFixed(2)),
      inboxMs: Number(inboxTiming.ms.toFixed(2)),
      inboxRows: (inboxTiming.value as unknown[]).length,
      unreadMs: Number(unreadTiming.ms.toFixed(2)),
      unread: unreadTiming.value,
      conversationalCreate100Ms: Number(conversationalTiming.ms.toFixed(2)),
      conversationalCreateAverageMs: Number((conversationalTiming.ms / conversationalIterations).toFixed(3)),
      bindingGet1000Ms: Number(bindingTiming.ms.toFixed(2)),
      bindingGetAverageUs: Number(((bindingTiming.ms * 1000) / bindingIterations).toFixed(2)),
      sessionCandidates100Ms: Number(candidateTiming.ms.toFixed(2)),
      sessionCandidatesAverageMs: Number((candidateTiming.ms / candidateIterations).toFixed(3)),
      sessionCandidatesRows: candidateTiming.value.at(-1)?.length ?? 0,
    },
    tz: process.versions.icu ?? "unknown",
  }
  console.log(JSON.stringify(output, null, 2))
})

await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped))
const size = (await fs.stat(dbPath)).size
console.log(JSON.stringify({ databaseBytes: size }))
await fs.rm(directory, { recursive: true, force: true })
process.exit(0)
