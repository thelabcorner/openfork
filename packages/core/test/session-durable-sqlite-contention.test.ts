import { expect, test } from "bun:test"
import { Database as NativeSQLite } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { SessionTelemetry } from "../src/session/telemetry"
import { SessionSchema } from "../src/session/schema"
import { Checkpoint } from "../src/checkpoint"
import { Snapshot } from "../src/snapshot"
import { Location } from "../src/location"
import { AbsolutePath } from "../src/schema"

test("a contended WAL writer does not abort settled session telemetry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openfork-telemetry-busy-"))
  const filename = join(directory, "session.db")
  const layer = AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionTelemetry.node]),
    [[Database.node, Database.layerFromPath(filename)]],
  )
  let peer: NativeSQLite | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const sessionID = SessionSchema.ID.make("ses_contended_telemetry")
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { db, readDb } = yield* Database.Service
      const telemetry = yield* SessionTelemetry.Service
      yield* db.run(sql`
        INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
        VALUES ('prj_contended_telemetry', '/repo', 1, 1, '[]')
      `)
      yield* db.run(sql`
        INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
        VALUES (${sessionID}, 'prj_contended_telemetry', 'busy', '/repo', 'Busy', 'test', 1, 1)
      `)
      yield* telemetry.begin({
        sessionID,
        assistantMessageID: "msg_contended",
        requestSentAt: Date.now(),
        model: { providerID: "opencode-go", modelID: "deepseek-v4.1-flash", contextLimit: 1_000_000 },
      })
      peer = new NativeSQLite(filename)
      peer.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE")
      // The primary connection waits only 75ms per failed attempt. Release
      // after multiple attempts to prove yield/backoff rather than one native
      // blocking busy_timeout.
      timer = setTimeout(() => peer?.exec("COMMIT"), 460)
      yield* telemetry.settle({
        sessionID,
        assistantMessageID: "msg_contended",
        completedAt: Date.now(),
        cost: 0.0065202,
        tokens: { input: 42860, output: 78, reasoning: 74, cache: { read: 0, write: 0 } },
      })
      const row = yield* readDb.get<{
        count: number
        provider_id: string
        model_id: string
        tokens_output: number
      }>(sql`SELECT count(*) AS count, provider_id, model_id, tokens_output
        FROM session_telemetry WHERE session_id = ${sessionID}`)
      expect(row).toMatchObject({
        count: 1,
        provider_id: "opencode-go",
        model_id: "deepseek-v4.1-flash",
        tokens_output: 78,
      })
    }).pipe(Effect.provide(layer), Effect.timeout("12 seconds"))))
  } finally {
    if (timer) clearTimeout(timer)
    try { peer?.exec("ROLLBACK") } catch {}
    peer?.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)

test("a contended WAL writer does not abort checkpoint creation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openfork-checkpoint-busy-"))
  const filename = join(directory, "checkpoint.db")
  const absolute = AbsolutePath.make(directory)
  const location = Location.Service.of({
    directory: absolute,
    project: { id: "prj_contended_checkpoint" as never, directory: absolute },
  })
  const layer = AppNodeBuilder.build(
    LayerNode.group([Database.node, Checkpoint.node]),
    [
      [Database.node, Database.layerFromPath(filename)],
      [Snapshot.node, Snapshot.noopLayer],
      [Location.node, Layer.succeed(Location.Service, location)],
    ],
  )
  let peer: NativeSQLite | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const sessionID = SessionSchema.ID.make("ses_contended_checkpoint")
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { db, readDb } = yield* Database.Service
      const checkpoint = yield* Checkpoint.Service
      yield* db.run(sql`
        INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
        VALUES ('prj_contended_checkpoint', '/repo', 1, 1, '[]')
      `)
      yield* db.run(sql`
        INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
        VALUES (${sessionID}, 'prj_contended_checkpoint', 'busy', '/repo', 'Busy', 'test', 1, 1)
      `)
      peer = new NativeSQLite(filename)
      peer.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE")
      timer = setTimeout(() => peer?.exec("COMMIT"), 460)
      const created = yield* checkpoint.create({
        sessionID,
        ordinal: 2,
        kind: "turn",
        beforeSnapshot: null,
        userMessageID: "msg_contended_user",
      })
      expect(created).toMatchObject({
        sessionID,
        ordinal: 2,
        status: "capturing",
        userMessageID: "msg_contended_user",
      })
      const rows = yield* readDb.all<{ status: string }>(sql`
        SELECT status FROM session_checkpoint WHERE session_id = ${sessionID}
      `)
      expect(rows).toEqual([{ status: "capturing" }])
    }).pipe(Effect.provide(layer), Effect.timeout("12 seconds"))))
  } finally {
    if (timer) clearTimeout(timer)
    try { peer?.exec("ROLLBACK") } catch {}
    peer?.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)