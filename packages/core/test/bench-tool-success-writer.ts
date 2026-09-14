/**
 * Jumbo Tool.Success contention benchmark.
 *
 * Measures the exact EventV2 + SessionProjector publish path after the tool
 * overlay remediation. The scout baseline on the old mutable-assistant design
 * was 1 MiB 7.88ms, 4 MiB 17.29ms, 6 MiB 24.62ms, 8 MiB 27.54ms.
 *
 * Run: bun run packages/core/test/bench-tool-success-writer.ts
 */
import { DateTime, Effect, Fiber } from "effect"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { EventTrace } from "../src/event-trace"
import { ModelV2 } from "../src/model"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { ProviderV2 } from "../src/provider"
import { AbsolutePath } from "../src/schema"
import { SessionEvent } from "../src/session/event"
import { SessionMessage } from "../src/session/message"
import { SessionMessageProjection } from "../src/session/message-projection"
import { SessionProjector } from "../src/session/projector"
import { SessionSchema } from "../src/session/schema"
import { SessionMessageTable, SessionTable } from "../src/session/sql"
import { eq, sql } from "drizzle-orm"

const layer = AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node]), [
  [Database.node, Database.layerFromPath(":memory:")],
])
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }
const directory = AbsolutePath.make("/bench-tool-success")

const startTool = (
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  assistantMessageID: SessionMessage.ID,
  callID: string,
  timestamp: number,
) =>
  Effect.gen(function* () {
    yield* events.publish(SessionEvent.Tool.Input.Started, {
      sessionID,
      assistantMessageID,
      timestamp: DateTime.makeUnsafe(timestamp),
      callID,
      name: "read",
    })
    yield* events.publish(SessionEvent.Tool.Called, {
      sessionID,
      assistantMessageID,
      timestamp: DateTime.makeUnsafe(timestamp + 1),
      callID,
      tool: "read",
      input: { path: `${callID}.png` },
      provider: { executed: false },
    })
  })

const publishJumbo = (
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  assistantMessageID: SessionMessage.ID,
  callID: string,
  mib: number,
  timestamp: number,
) =>
  Effect.gen(function* () {
    const uri = `data:image/png;base64,${"A".repeat(mib * 1024 * 1024)}`
    let lastTick = performance.now()
    let maxLag = 0
    const timer = setInterval(() => {
      const now = performance.now()
      maxLag = Math.max(maxLag, now - lastTick)
      lastTick = now
    }, 1)
    const started = performance.now()
    EventTrace.reset()
    yield* events.publish(SessionEvent.Tool.Success, {
      sessionID,
      assistantMessageID,
      timestamp: DateTime.makeUnsafe(timestamp),
      callID,
      structured: { bytes: uri.length },
      content: [{ type: "file", uri, mime: "image/png", name: `${callID}.png` }],
      provider: { executed: false },
    })
    const elapsed = performance.now() - started
    const writerMs = EventTrace.state().timings[`durable.transaction.${SessionEvent.Tool.Success.type}`]?.maxMs ?? -1
    yield* Effect.sleep("3 millis")
    clearInterval(timer)
    const baseBytes = (
      yield* dbUnsafe().get<{ bytes: number }>(
        sql`SELECT length(CAST(data AS BLOB)) AS bytes FROM session_message WHERE id = ${assistantMessageID}`,
      )
    )?.bytes
    return { elapsed, writerMs, maxLag, baseBytes: baseBytes ?? -1 }
  })

let currentDb: Database.Interface["db"] | undefined
const dbUnsafe = () => {
  if (!currentDb) throw new Error("benchmark database not initialized")
  return currentDb
}

const program = Effect.gen(function* () {
  const { db } = yield* Database.Service
  currentDb = db
  const events = yield* EventV2.Service
  EventTrace.configure({ enabled: true })
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)

  console.log("\n=== Jumbo Tool.Success writer benchmark ===")
  console.log("old mutable-assistant baseline: 1MiB 7.88ms | 4MiB 17.29ms | 6MiB 24.62ms | 8MiB 27.54ms")
  console.log(`${"MiB".padStart(4)} | ${"publish ms".padStart(10)} | ${"writer ms".padStart(9)} | ${"max lag ms".padStart(10)} | ${"base row B".padStart(10)}`)
  console.log("-----+------------+-----------+------------+-----------")

  let sequence = 1
  for (const mib of [1, 4, 6, 8]) {
    const sessionID = SessionSchema.ID.make(`ses_bench_tool_${mib}`)
    const assistantMessageID = SessionMessage.ID.make(`msg_bench_tool_${mib}`)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: sessionID,
        directory,
        title: "bench",
        version: "bench",
      })
      .run()
      .pipe(Effect.orDie)
    yield* events.publish(SessionEvent.Step.Started, {
      sessionID,
      assistantMessageID,
      timestamp: DateTime.makeUnsafe(sequence++),
      agent: "build",
      model,
    })
    const callID = `call-${mib}`
    yield* startTool(events, sessionID, assistantMessageID, callID, sequence++)
    const result = yield* publishJumbo(events, sessionID, assistantMessageID, callID, mib, sequence++)
    console.log(
      `${String(mib).padStart(4)} | ${result.elapsed.toFixed(2).padStart(10)} | ${result.writerMs.toFixed(2).padStart(9)} | ${result.maxLag.toFixed(2).padStart(10)} | ${String(result.baseBytes).padStart(10)}`,
    )
  }

  // Historical-amplification probe: four 6 MiB settlements in one assistant.
  const sessionID = SessionSchema.ID.make("ses_bench_tool_accumulated")
  const assistantMessageID = SessionMessage.ID.make("msg_bench_tool_accumulated")
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: sessionID,
      directory,
      title: "bench accumulated",
      version: "bench",
    })
    .run()
    .pipe(Effect.orDie)
  yield* events.publish(SessionEvent.Step.Started, {
    sessionID,
    assistantMessageID,
    timestamp: DateTime.makeUnsafe(sequence++),
    agent: "build",
    model,
  })

  console.log("\n6 MiB repeated settlements in one assistant")
  console.log(`${"tool #".padStart(6)} | ${"publish ms".padStart(10)} | ${"writer ms".padStart(9)} | ${"base row B".padStart(10)}`)
  console.log("-------+------------+-----------+-----------")
  for (let index = 1; index <= 4; index++) {
    const callID = `call-acc-${index}`
    yield* startTool(events, sessionID, assistantMessageID, callID, sequence++)
    const result = yield* publishJumbo(events, sessionID, assistantMessageID, callID, 6, sequence++)
    console.log(`${String(index).padStart(6)} | ${result.elapsed.toFixed(2).padStart(10)} | ${result.writerMs.toFixed(2).padStart(9)} | ${String(result.baseBytes).padStart(10)}`)
  }

  // Pay the cold-reader cost once to verify all four authoritative event
  // payloads reconstruct while the mutable base remains tiny.
  const row = yield* db
    .select()
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.id, assistantMessageID))
    .get()
    .pipe(Effect.orDie)
  let coldLastTick = performance.now()
  let coldMaxLag = 0
  const coldTimer = setInterval(() => {
    const now = performance.now()
    coldMaxLag = Math.max(coldMaxLag, now - coldLastTick)
    coldLastTick = now
  }, 1)
  const coldStarted = performance.now()
  const projected = yield* SessionMessageProjection.decodeRow(db, row!).pipe(Effect.orDie)
  const coldMs = performance.now() - coldStarted
  yield* Effect.sleep("3 millis")
  clearInterval(coldTimer)
  if (projected.type !== "assistant") throw new Error("expected assistant projection")
  console.log(
    `cold reconstruction of ${projected.content.length} parts / 24 MiB tool media: ${coldMs.toFixed(2)} ms total, ${coldMaxLag.toFixed(2)} ms max event-loop gap`,
  )

  // Direct cross-session fairness probe. Session A begins an 8 MiB completion;
  // after A reaches its first cooperative staging boundary, Session B publishes
  // a tiny rename. B should acquire the shared writer between A's bounded chunk
  // writes instead of waiting for the entire jumbo body.
  const sessionB = SessionSchema.ID.make("ses_bench_tool_tiny_b")
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionB,
      project_id: Project.ID.global,
      slug: sessionB,
      directory,
      title: "tiny B",
      version: "bench",
    })
    .run()
    .pipe(Effect.orDie)
  const fairnessCall = "call-fairness-a"
  yield* startTool(events, sessionID, assistantMessageID, fairnessCall, sequence++)
  const aStarted = performance.now()
  const aFiber = yield* Effect.forkScoped(
    publishJumbo(events, sessionID, assistantMessageID, fairnessCall, 8, sequence++),
  )
  yield* Effect.yieldNow
  const bStarted = performance.now()
  yield* events.publish(SessionEvent.Renamed, {
    sessionID: sessionB,
    timestamp: DateTime.makeUnsafe(sequence++),
    title: "tiny B renamed",
  })
  const bMs = performance.now() - bStarted
  const aResult = yield* Fiber.join(aFiber)
  const aMs = performance.now() - aStarted
  console.log(`cross-session fairness: A 8 MiB ${aMs.toFixed(2)} ms total; B tiny durable event ${bMs.toFixed(2)} ms`)
  console.log(`A final semantic writer hold during fairness probe: ${aResult.writerMs.toFixed(2)} ms`)
  EventTrace.configure({ enabled: false })
}).pipe(Effect.scoped, Effect.provide(layer))

Effect.runPromise(program).catch((error) => {
  console.error(error)
  process.exit(1)
})
