import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { asc, eq, sql } from "drizzle-orm"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "../../src/database/sqlite.bun"
import { DatabaseMigration } from "../../src/database/migration"
import { ensureChunkDB } from "../../src/database/chunkdb"
import { runSemanticPrunePass, SemanticPrune } from "../../src/database/chunk-prune"
import { indexSemanticEvent, SemanticKind } from "../../src/database/chunk-semantic"
import { compressDeltaRef } from "../../src/database/json-codec"
import {
  inflateCompactedHistory,
  isCompactedSequence,
  loadCompaction,
} from "../../src/database/chunk-compaction"
import { Database } from "../../src/database/database"
import { isSqliteBusy, retrySqliteBusy } from "../../src/database/sqlite-busy"
import { Flag } from "../../src/flag/flag"
import { EventV2 } from "../../src/event"
import { EventTable } from "../../src/event/sql"
import { SessionProjector } from "../../src/session/projector"
import { SessionV1 } from "../../src/v1/session"
import { LayerNode } from "../../src/effect/layer-node"
import { AppNodeBuilder } from "../../src/effect/app-node-builder"

process.env.OPENCODE_SEAL_ENABLED = "1"
process.env.OPENCODE_SEAL_DEDUP = "1"
process.env.OPENCODE_SEAL_PRUNE = "1"
process.env.OPENCODE_SEAL_WORKERS = "0"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "chunk-prune-"))
  return { dir, path: join(dir, "db.sqlite") }
}

function message(id: string, sessionID: string, agent: string) {
  return JSON.stringify({
    sessionID,
    info: {
      id,
      sessionID,
      role: "user",
      time: { created: 1 },
      agent,
      model: { providerID: "provider", modelID: "model" },
    },
  })
}

function part(id: string, messageID: string, sessionID: string, text: string) {
  return JSON.stringify({
    sessionID,
    part: { id, messageID, sessionID, type: "text", text },
    time: 1,
  })
}

describe("ChunkDB semantic prune", () => {
  test("semantic pruning defaults on and retains an explicit emergency kill switch", () => {
    const previous = process.env.OPENCODE_SEAL_PRUNE
    try {
      delete process.env.OPENCODE_SEAL_PRUNE
      expect(Flag.OPENCODE_SEAL_PRUNE).toBe(true)
      process.env.OPENCODE_SEAL_PRUNE = "0"
      expect(Flag.OPENCODE_SEAL_PRUNE).toBe(false)
      process.env.OPENCODE_SEAL_PRUNE = "false"
      expect(Flag.OPENCODE_SEAL_PRUNE).toBe(false)
      process.env.OPENCODE_SEAL_PRUNE = "1"
      expect(Flag.OPENCODE_SEAL_PRUNE).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_SEAL_PRUNE
      else process.env.OPENCODE_SEAL_PRUNE = previous
    }
  })

  test("SQLITE_BUSY retry repeats the exact operation and never retries non-busy failures", async () => {
    let attempts = 0
    const value = await Effect.runPromise(
      retrySqliteBusy(() => {
        attempts++
        if (attempts < 3) return Effect.fail(new Error("SQLITE_BUSY: database is locked"))
        return Effect.succeed(42)
      }, 1),
    )
    expect(value).toBe(42)
    expect(attempts).toBe(3)

    let fatalAttempts = 0
    const exit = await Effect.runPromise(
      Effect.exit(
        retrySqliteBusy(() => {
          fatalAttempts++
          return Effect.fail(new Error("constraint failed"))
        }, 1),
      ),
    )
    expect(exit._tag).toBe("Failure")
    expect(fatalAttempts).toBe(1)

    const defect = await Effect.runPromise(
      Effect.exit(Effect.die(new Error("SQLITE_BUSY: database is locked inside migration defect"))),
    )
    expect(defect._tag).toBe("Failure")
    if (defect._tag === "Failure") expect(isSqliteBusy(defect.cause)).toBe(true)
  })
  test("write-time semantic identity indexing is tiny and exact", async () => {
    const { dir, path } = tempDb()
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* makeDatabase
          yield* DatabaseMigration.apply(db)
          yield* ensureChunkDB(db)
          yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq, owner_id) VALUES ('ses_identity', 7, NULL)`).pipe(Effect.orDie)
          expect(
            yield* indexSemanticEvent(db, {
              aggregateID: "ses_identity",
              seq: 7,
              type: "message.part.updated",
              data: {
                sessionID: "ses_identity",
                part: { id: "prt_identity", messageID: "msg_identity", sessionID: "ses_identity" },
              },
            }),
          ).toBe(true)
          const row = yield* db.get<{ kind: number; entity_id: string; parent_id: string; proven: number }>(sql`
            SELECT s.kind, e.entity_id, e.parent_id, s.proven
            FROM event_semantic s
            JOIN semantic_aggregate a ON a.aggregate_key = s.aggregate_key
            JOIN semantic_entity e ON e.entity_key = s.entity_key
            WHERE a.aggregate_id = 'ses_identity' AND s.seq = 7
          `).pipe(Effect.orDie)
          expect(row).toEqual({
            kind: SemanticKind.Part,
            entity_id: "prt_identity",
            parent_id: "msg_identity",
            proven: 1,
          })
          const epoch = yield* db.get<{ user_version: number }>(sql`PRAGMA user_version`).pipe(Effect.orDie)
          expect(epoch?.user_version).toBe(4)
        }).pipe(Effect.provide(sqliteLayer({ filename: path }))),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("projection data mutations invalidate provenance while search-only updates do not", async () => {
    const { dir, path } = tempDb()
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* makeDatabase
          yield* DatabaseMigration.apply(db)
          yield* ensureChunkDB(db)
          const sessionID = "ses_provenance"
          const messageID = "msg_provenance"
          const partID = "prt_provenance"
          const now = Date.now()
          yield* db.run(sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('global', '/tmp', '[]', ${now}, ${now})`).pipe(Effect.orDie)
          yield* db.run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (${sessionID}, 'global', 's', '/tmp', 's', 'test', 1, 1)`).pipe(Effect.orDie)
          yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq, owner_id) VALUES (${sessionID}, 2, NULL)`).pipe(Effect.orDie)
          yield* db.run(sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (${messageID}, ${sessionID}, 1, 1, '{}')`).pipe(Effect.orDie)
          yield* db.run(sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, search_text) VALUES (${partID}, ${messageID}, ${sessionID}, 1, 1, '{"type":"text","text":"one"}', 'one')`).pipe(Effect.orDie)

          expect(
            yield* indexSemanticEvent(db, {
              aggregateID: sessionID,
              seq: 1,
              type: "message.part.updated",
              data: { sessionID, part: { id: partID, messageID, sessionID, type: "text", text: "one" } },
            }),
          ).toBe(true)
          const proven = () =>
            db.get<{ proven: number }>(sql`
              SELECT s.proven
              FROM event_semantic s
              JOIN semantic_aggregate a ON a.aggregate_key = s.aggregate_key
              WHERE a.aggregate_id = ${sessionID} AND s.seq = 1
            `).pipe(Effect.orDie)
          expect((yield* proven())?.proven).toBe(1)

          yield* db.run(sql`UPDATE part SET search_text = 'rebuilt' WHERE id = ${partID}`).pipe(Effect.orDie)
          expect((yield* proven())?.proven).toBe(1)

          yield* db.run(sql`UPDATE part SET data = '{"type":"text","text":"two"}' WHERE id = ${partID}`).pipe(Effect.orDie)
          expect((yield* proven())?.proven).toBe(0)

          // The legacy projection never changes message_id on PartUpdated
          // conflict. Refuse to certify an impossible parent transition.
          expect(
            yield* indexSemanticEvent(db, {
              aggregateID: sessionID,
              seq: 2,
              type: "message.part.updated",
              data: {
                sessionID,
                part: { id: partID, messageID: "msg_different_parent", sessionID, type: "text", text: "two" },
              },
            }),
          ).toBe(false)
          expect(
            (yield* db.get<{ count: number }>(sql`
              SELECT count(*) AS count
              FROM event_semantic s
              JOIN semantic_aggregate a ON a.aggregate_key = s.aggregate_key
              WHERE a.aggregate_id = ${sessionID} AND s.seq = 2
            `).pipe(Effect.orDie))?.count,
          ).toBe(0)
        }).pipe(Effect.provide(sqliteLayer({ filename: path }))),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("rewrites only superseded projection-verified snapshots and keeps latest rows", async () => {
    const { dir, path } = tempDb()
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* makeDatabase
          yield* db.run("PRAGMA journal_mode=WAL").pipe(Effect.orDie)
          yield* db.run("PRAGMA foreign_keys=ON").pipe(Effect.orDie)
          yield* DatabaseMigration.apply(db)
          yield* ensureChunkDB(db)

          const sessionID = "ses_prune"
          const messageID = "msg_prune"
          const partID = "prt_prune"
          const now = Date.now()
          yield* db.run(sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('global', '/tmp', '[]', ${now}, ${now})`).pipe(Effect.orDie)
          yield* db.run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (${sessionID}, 'global', 's', '/tmp', 's', 'test', 1, 1)`).pipe(Effect.orDie)
          yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq, owner_id) VALUES (${sessionID}, 4, NULL)`).pipe(Effect.orDie)

          yield* db.run(sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (${messageID}, ${sessionID}, 1, 1, ${JSON.stringify({ role: "user", time: { created: 1 }, agent: "after", model: { providerID: "provider", modelID: "model" } })})`).pipe(Effect.orDie)
          yield* db.run(sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, search_text) VALUES (${partID}, ${messageID}, ${sessionID}, 1, 1, ${JSON.stringify({ type: "text", text: "three" })}, '')`).pipe(Effect.orDie)

          yield* db.run(sql`INSERT INTO event (id, aggregate_id, seq, type, data) VALUES ('evt_m1', ${sessionID}, 0, 'message.updated.1', ${message(messageID, sessionID, "before")})`).pipe(Effect.orDie)
          yield* db.run(sql`INSERT INTO event (id, aggregate_id, seq, type, data) VALUES ('evt_m2', ${sessionID}, 1, 'message.updated.1', ${message(messageID, sessionID, "after")})`).pipe(Effect.orDie)
          yield* db.run(sql`INSERT INTO event (id, aggregate_id, seq, type, data) VALUES ('evt_p1', ${sessionID}, 2, 'message.part.updated.1', ${part(partID, messageID, sessionID, "one")})`).pipe(Effect.orDie)
          yield* db.run(sql`INSERT INTO event (id, aggregate_id, seq, type, data) VALUES ('evt_p2', ${sessionID}, 3, 'message.part.updated.1', ${part(partID, messageID, sessionID, "two")})`).pipe(Effect.orDie)
          yield* db.run(sql`INSERT INTO event (id, aggregate_id, seq, type, data) VALUES ('evt_p3', ${sessionID}, 4, 'message.part.updated.1', ${part(partID, messageID, sessionID, "three")})`).pipe(Effect.orDie)

          const result = yield* runSemanticPrunePass(db, { limit: 16, now })
          expect(result.compacted).toBe(3)
          expect(result.projectionMismatches).toBe(0)
          expect(result.payloadBytesReclaimed).toBeGreaterThan(0)

          const rows = yield* db.all<{ seq: number; type: string }>(sql`SELECT seq, type FROM event WHERE aggregate_id = ${sessionID} ORDER BY seq`).pipe(Effect.orDie)
          expect(rows.map((row) => [row.seq, row.type])).toEqual([
            [1, "message.updated.1"],
            [4, "message.part.updated.1"],
          ])
          const compaction = yield* loadCompaction(db, sessionID)
          expect(compaction?.count).toBe(3)
          expect(isCompactedSequence(compaction?.bitmap, 0)).toBe(true)
          expect(isCompactedSequence(compaction?.bitmap, 2)).toBe(true)
          expect(isCompactedSequence(compaction?.bitmap, 3)).toBe(true)
          expect(isCompactedSequence(compaction?.bitmap, 1)).toBe(false)
        }).pipe(Effect.provide(sqliteLayer({ filename: path }))),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("keeps semantic drain mode active after a mismatch-only aggregate advances the cursor", async () => {
    const { dir, path } = tempDb()
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* makeDatabase
          yield* db.run("PRAGMA journal_mode=WAL").pipe(Effect.orDie)
          yield* db.run("PRAGMA foreign_keys=ON").pipe(Effect.orDie)
          yield* DatabaseMigration.apply(db)
          yield* ensureChunkDB(db)

          const now = Date.now()
          yield* db.run(sql`
            INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
            VALUES ('global', '/tmp', '[]', ${now}, ${now})
          `).pipe(Effect.orDie)

          for (const suffix of ["a", "b"] as const) {
            const sessionID = `ses_drain_${suffix}`
            const messageID = `msg_drain_${suffix}`
            yield* db.run(sql`
              INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
              VALUES (${sessionID}, 'global', ${suffix}, '/tmp', ${suffix}, 'test', 1, 1)
            `).pipe(Effect.orDie)
            yield* db.run(sql`
              INSERT INTO event_sequence (aggregate_id, seq, owner_id)
              VALUES (${sessionID}, 1, NULL)
            `).pipe(Effect.orDie)
            const projectedAgent = suffix === "a" ? "stale" : "after"
            yield* db.run(sql`
              INSERT INTO message (id, session_id, time_created, time_updated, data)
              VALUES (
                ${messageID},
                ${sessionID},
                1,
                1,
                ${JSON.stringify({
                  role: "user",
                  time: { created: 1 },
                  agent: projectedAgent,
                  model: { providerID: "provider", modelID: "model" },
                })}
              )
            `).pipe(Effect.orDie)
            yield* db.run(sql`
              INSERT INTO event (id, aggregate_id, seq, type, data)
              VALUES
                (${`evt_drain_${suffix}_old`}, ${sessionID}, 0, 'message.updated.1', ${message(messageID, sessionID, "before")}),
                (${`evt_drain_${suffix}_new`}, ${sessionID}, 1, 'message.updated.1', ${message(messageID, sessionID, "after")})
            `).pipe(Effect.orDie)
          }

          // Aggregate A is deliberately fail-closed: its latest event does not
          // match the materialized projection. The semantic cursor must advance
          // past A so it cannot starve later sessions.
          const first = yield* runSemanticPrunePass(db, { limit: 16, now })
          expect(first.aggregateID).toBe("ses_drain_a")
          expect(first.compacted).toBe(0)
          expect(first.projectionMismatches).toBe(1)

          // This is the critical scheduler boundary: hasMore MUST stay true
          // because aggregate B still has provable work. Before this regression,
          // the outer sealer fell through to its 10-minute maintenance sleep here.
          expect(first.hasMore).toBe(true)

          const next = yield* runSemanticPrunePass(db, { limit: 16, now })
          expect(next.aggregateID).toBe("ses_drain_b")
          expect(next.compacted).toBe(1)
        }).pipe(Effect.provide(sqliteLayer({ filename: path }))),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("fails closed on projection mismatch", async () => {
    const { dir, path } = tempDb()
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* makeDatabase
          yield* DatabaseMigration.apply(db)
          yield* ensureChunkDB(db)
          const sessionID = "ses_mismatch"
          const messageID = "msg_mismatch"
          yield* db.run(sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('global', '/tmp', '[]', 1, 1)`).pipe(Effect.orDie)
          yield* db.run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (${sessionID}, 'global', 's', '/tmp', 's', 'test', 1, 1)`).pipe(Effect.orDie)
          yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq, owner_id) VALUES (${sessionID}, 1, NULL)`).pipe(Effect.orDie)
          yield* db.run(sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (${messageID}, ${sessionID}, 1, 1, ${JSON.stringify({ agent: "stale" })})`).pipe(Effect.orDie)
          yield* db.run(sql`INSERT INTO event (id, aggregate_id, seq, type, data) VALUES ('evt_x1', ${sessionID}, 0, 'message.updated.1', ${message(messageID, sessionID, "before")})`).pipe(Effect.orDie)
          yield* db.run(sql`INSERT INTO event (id, aggregate_id, seq, type, data) VALUES ('evt_x2', ${sessionID}, 1, 'message.updated.1', ${message(messageID, sessionID, "after")})`).pipe(Effect.orDie)
          const result = yield* runSemanticPrunePass(db, { limit: 16, now: Date.now() })
          expect(result.compacted).toBe(0)
          expect(result.projectionMismatches).toBe(1)
        }).pipe(Effect.provide(sqliteLayer({ filename: path }))),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("migrates legacy physical checkpoint rows into the epoch-4 aggregate bitmap idempotently", async () => {
    const { dir, path } = tempDb()
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* makeDatabase
          yield* DatabaseMigration.apply(db)
          yield* ensureChunkDB(db)
          const sessionID = "ses_legacy_checkpoint"
          yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq, owner_id) VALUES (${sessionID}, 5, NULL)`).pipe(Effect.orDie)
          yield* db.run(sql`
            INSERT INTO event (id, aggregate_id, seq, type, data)
            VALUES (
              'evt_legacy_checkpoint',
              ${sessionID},
              3,
              ${SemanticPrune.checkpointType},
              ${JSON.stringify({
                aggregateID: sessionID,
                supersededType: "message.updated.1",
                supersededBy: "evt_legacy_replacement",
              })}
            )
          `).pipe(Effect.orDie)

          const first = yield* runSemanticPrunePass(db, { limit: 8, now: Date.now() })
          expect(first.checkpointRowsMigrated).toBe(1)
          expect(
            (yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM event WHERE id = 'evt_legacy_checkpoint'`).pipe(Effect.orDie))
              ?.count,
          ).toBe(0)
          const compacted = yield* loadCompaction(db, sessionID)
          expect(compacted?.count).toBe(1)
          expect(isCompactedSequence(compacted?.bitmap, 3)).toBe(true)

          const second = yield* runSemanticPrunePass(db, { limit: 8, now: Date.now() })
          expect(second.checkpointRowsMigrated).toBe(0)
          expect((yield* loadCompaction(db, sessionID))?.count).toBe(1)
        }).pipe(Effect.provide(sqliteLayer({ filename: path }))),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a marker-containing pruned log rebuilds message, part, and usage projections byte-equivalent", async () => {
    const { dir, path } = tempDb()
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* makeDatabase
          yield* DatabaseMigration.apply(db)
          yield* ensureChunkDB(db)

          const sessionID = "ses_semantic_replay"
          const messageID = "msg_semantic_replay"
          const partID = "prt_semantic_replay"
          yield* db.run(sql`
            INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
            VALUES ('global', '/tmp', '[]', 1, 1)
          `).pipe(Effect.orDie)
          yield* db.run(sql`
            INSERT INTO session (
              id, project_id, slug, directory, title, version, time_created, time_updated,
              cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write
            ) VALUES (${sessionID}, 'global', 's', '/tmp', 's', 'test', 1, 1, 0, 0, 0, 0, 0, 0)
          `).pipe(Effect.orDie)

          const database = Layer.succeed(Database.Service, { db, filename: path })
          const layer = AppNodeBuilder.build(
            LayerNode.group([EventV2.node, SessionProjector.node]),
            [[Database.node, database]],
          )

          yield* Effect.gen(function* () {
            const events = yield* EventV2.Service
            const original: EventV2.SerializedEvent[] = [
              {
                id: EventV2.ID.make("evt_semantic_replay_m1"),
                aggregateID: sessionID,
                seq: 0,
                type: EventV2.versionedType(SessionV1.Event.MessageUpdated.type, 1),
                data: {
                  sessionID,
                  info: {
                    id: messageID,
                    sessionID,
                    role: "user",
                    time: { created: 1 },
                    agent: "before",
                    model: { providerID: "provider", modelID: "model" },
                  },
                },
              },
              {
                id: EventV2.ID.make("evt_semantic_replay_m2"),
                aggregateID: sessionID,
                seq: 1,
                type: EventV2.versionedType(SessionV1.Event.MessageUpdated.type, 1),
                data: {
                  sessionID,
                  info: {
                    id: messageID,
                    sessionID,
                    role: "user",
                    time: { created: 1 },
                    agent: "after",
                    model: { providerID: "provider", modelID: "model" },
                  },
                },
              },
              {
                id: EventV2.ID.make("evt_semantic_replay_p1"),
                aggregateID: sessionID,
                seq: 2,
                type: EventV2.versionedType(SessionV1.Event.PartUpdated.type, 1),
                data: {
                  sessionID,
                  time: 1,
                  part: {
                    id: partID,
                    sessionID,
                    messageID,
                    type: "step-finish",
                    reason: "stop",
                    cost: 10,
                    tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
                  },
                },
              },
              {
                id: EventV2.ID.make("evt_semantic_replay_p2"),
                aggregateID: sessionID,
                seq: 3,
                type: EventV2.versionedType(SessionV1.Event.PartUpdated.type, 1),
                data: {
                  sessionID,
                  time: 2,
                  part: {
                    id: partID,
                    sessionID,
                    messageID,
                    type: "step-finish",
                    reason: "stop",
                    cost: 20,
                    tokens: { input: 10, output: 20, reasoning: 30, cache: { read: 40, write: 50 } },
                  },
                },
              },
            ] as EventV2.SerializedEvent[]

            yield* events.replayAll(original)
            const pruned = yield* runSemanticPrunePass(db, { limit: 32, now: 2 * 60 * 60 * 1000 })
            expect(pruned.compacted).toBe(2)

            const expected = yield* db.get<{
              messageData: string
              partData: string
              cost: number
              input: number
              output: number
              reasoning: number
              cacheRead: number
              cacheWrite: number
            }>(sql`
              SELECT
                CAST((SELECT data FROM message WHERE id = ${messageID}) AS TEXT) AS messageData,
                CAST((SELECT data FROM part WHERE id = ${partID}) AS TEXT) AS partData,
                cost,
                tokens_input AS input,
                tokens_output AS output,
                tokens_reasoning AS reasoning,
                tokens_cache_read AS cacheRead,
                tokens_cache_write AS cacheWrite
              FROM session WHERE id = ${sessionID}
            `).pipe(Effect.orDie)

            const stored = yield* db
              .select()
              .from(EventTable)
              .where(eq(EventTable.aggregate_id, sessionID))
              .orderBy(asc(EventTable.seq))
              .all()
              .pipe(Effect.orDie)
            const hydrated = yield* EventV2.rehydrateEvents(db, sessionID, stored)
            const compaction = yield* loadCompaction(db, sessionID)
            const replayLog = inflateCompactedHistory({
              aggregateID: sessionID,
              rows: hydrated,
              bitmap: compaction?.bitmap,
              through: 3,
            })
            expect(replayLog.map((row) => row.type)).toEqual([
              SemanticPrune.checkpointType,
              "message.updated.1",
              SemanticPrune.checkpointType,
              "message.part.updated.1",
            ])

            // Destroy every derived message/part/usage projection and durable
            // ownership row, then rebuild from the SEMANTICALLY COMPACTED log.
            // This is stronger than comparing marker schemas: it proves that the
            // real legacy projector reaches the same final state and accounting.
            yield* db.run(sql`DELETE FROM part WHERE session_id = ${sessionID}`).pipe(Effect.orDie)
            yield* db.run(sql`DELETE FROM message WHERE session_id = ${sessionID}`).pipe(Effect.orDie)
            yield* db.run(sql`DELETE FROM event WHERE aggregate_id = ${sessionID}`).pipe(Effect.orDie)
            yield* db.run(sql`DELETE FROM event_sequence WHERE aggregate_id = ${sessionID}`).pipe(Effect.orDie)
            yield* db.run(sql`
              UPDATE session
              SET cost = 0,
                  tokens_input = 0,
                  tokens_output = 0,
                  tokens_reasoning = 0,
                  tokens_cache_read = 0,
                  tokens_cache_write = 0
              WHERE id = ${sessionID}
            `).pipe(Effect.orDie)

            yield* events.replayAll(
              replayLog.map((row) => ({
                id: row.id,
                aggregateID: row.aggregate_id,
                seq: row.seq,
                type: row.type,
                data: row.data,
              })),
            )

            const rebuilt = yield* db.get<typeof expected>(sql`
              SELECT
                CAST((SELECT data FROM message WHERE id = ${messageID}) AS TEXT) AS messageData,
                CAST((SELECT data FROM part WHERE id = ${partID}) AS TEXT) AS partData,
                cost,
                tokens_input AS input,
                tokens_output AS output,
                tokens_reasoning AS reasoning,
                tokens_cache_read AS cacheRead,
                tokens_cache_write AS cacheWrite
              FROM session WHERE id = ${sessionID}
            `).pipe(Effect.orDie)
            expect(rebuilt).toEqual(expected)
            const replayStored = yield* db
              .select()
              .from(EventTable)
              .where(eq(EventTable.aggregate_id, sessionID))
              .orderBy(asc(EventTable.seq))
              .all()
              .pipe(Effect.orDie)
            expect(replayStored.map((row) => row.seq)).toEqual([1, 3])
            const replayCompaction = yield* loadCompaction(db, sessionID)
            expect(replayCompaction?.count).toBe(2)
            expect(isCompactedSequence(replayCompaction?.bitmap, 0)).toBe(true)
            expect(isCompactedSequence(replayCompaction?.bitmap, 2)).toBe(true)
          }).pipe(Effect.provide(layer))
        }).pipe(Effect.provide(sqliteLayer({ filename: path }))),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("backfills a historical $cdbRef, compacts it, decrements refs, and garbage-collects the canonical value", async () => {
    const { dir, path } = tempDb()
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* makeDatabase
          yield* DatabaseMigration.apply(db)
          yield* ensureChunkDB(db)
          const sessionID = "ses_ref_prune"
          const messageID = "msg_ref_prune"
          const now = Date.now()
          const before = message(messageID, sessionID, "before")
          const after = message(messageID, sessionID, "after")
          const raw = new TextEncoder().encode(before)
          const sha = createHash("sha256").update(raw).digest("hex")
          const valueID = `${sessionID}:0`
          const ref = JSON.stringify({ $cdbRef: valueID })

          yield* db.run(sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('global', '/tmp', '[]', ${now}, ${now})`).pipe(Effect.orDie)
          yield* db.run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (${sessionID}, 'global', 's', '/tmp', 's', 'test', 1, 1)`).pipe(Effect.orDie)
          yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq, owner_id) VALUES (${sessionID}, 1, NULL)`).pipe(Effect.orDie)
          yield* db.run(sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (${messageID}, ${sessionID}, 1, 1, ${JSON.stringify({ role: "user", time: { created: 1 }, agent: "after", model: { providerID: "provider", modelID: "model" } })})`).pipe(Effect.orDie)
          yield* db.run(sql`
            INSERT INTO event_value (aggregate_id, value_id, sha256, raw_len, bytes, refs, time_promoted)
            VALUES (${sessionID}, ${valueID}, ${sha}, ${raw.byteLength}, ${raw}, 1, ${now})
          `).pipe(Effect.orDie)
          yield* db.run(sql`INSERT INTO event (id, aggregate_id, seq, type, data) VALUES ('evt_ref_old', ${sessionID}, 0, 'message.updated.1', ${ref})`).pipe(Effect.orDie)
          yield* db.run(sql`INSERT INTO event (id, aggregate_id, seq, type, data) VALUES ('evt_ref_latest', ${sessionID}, 1, 'message.updated.1', ${after})`).pipe(Effect.orDie)
          yield* db.run(sql`
            INSERT INTO ocdb_seal (table_name, row_id, column_name, raw_bytes, stored_bytes, codec, frame_version, time_sealed, reseal_needed)
            VALUES ('event', 'evt_ref_old', 'data', ${raw.byteLength}, ${Buffer.byteLength(ref)}, 1, 3, ${now}, 0)
          `).pipe(Effect.orDie)

          const result = yield* runSemanticPrunePass(db, { limit: 16, now })
          expect(result.compacted).toBe(1)
          expect(result.canonicalValuesDeleted).toBe(1)
          expect(result.canonicalBytesReclaimed).toBe(raw.byteLength)
          const old = yield* db.get<{ type: string }>(sql`SELECT type FROM event WHERE id = 'evt_ref_old'`).pipe(Effect.orDie)
          expect(old).toBeUndefined()
          const compacted = yield* loadCompaction(db, sessionID)
          expect(compacted?.count).toBe(1)
          expect(isCompactedSequence(compacted?.bitmap, 0)).toBe(true)
          const values = yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM event_value WHERE aggregate_id = ${sessionID}`).pipe(Effect.orDie)
          expect(values?.count).toBe(0)
          const semantic = yield* db.get<{ count: number }>(sql`
            SELECT count(*) AS count
            FROM event_semantic s
            JOIN semantic_aggregate a ON a.aggregate_key = s.aggregate_key
            WHERE a.aggregate_id = ${sessionID} AND s.seq = 0
          `).pipe(Effect.orDie)
          expect(semantic?.count).toBe(0)
        }).pipe(Effect.provide(sqliteLayer({ filename: path }))),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("backfills v5 dependencies and preserves only the transitive live closure", async () => {
    const { dir, path } = tempDb()
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* makeDatabase
          yield* DatabaseMigration.apply(db)
          yield* ensureChunkDB(db)
          const aggregateID = "ses_delta_gc"
          yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq, owner_id) VALUES (${aggregateID}, 0, NULL)`).pipe(Effect.orDie)

          const baseRaw = new TextEncoder().encode(JSON.stringify({ aggregateID, value: "a".repeat(4096) }))
          const childRaw = new TextEncoder().encode(JSON.stringify({ aggregateID, value: "a".repeat(4095) + "b" }))
          const baseID = `${aggregateID}:base`
          const childID = `${aggregateID}:child`
          const childFrame = compressDeltaRef(childRaw, baseRaw, baseID, 1, 1)
          yield* db.run(sql`
            INSERT INTO event_value (aggregate_id, value_id, sha256, raw_len, bytes, refs, time_promoted)
            VALUES
              (${aggregateID}, ${baseID}, ${createHash("sha256").update(baseRaw).digest("hex")}, ${baseRaw.byteLength}, ${baseRaw}, 0, 1),
              (${aggregateID}, ${childID}, ${createHash("sha256").update(childRaw).digest("hex")}, ${childRaw.byteLength}, ${childFrame}, 1, 1)
          `).pipe(Effect.orDie)

          const pass = yield* runSemanticPrunePass(db, { limit: 8, now: Date.now() })
          expect(pass.dependencyComplete).toBe(true)
          expect(pass.dependencyBackfilled).toBe(1)
          const edge = yield* db.get<{ base: string }>(sql`
            SELECT base_value_id AS base
            FROM event_value_dependency
            WHERE aggregate_id = ${aggregateID} AND value_id = ${childID}
          `).pipe(Effect.orDie)
          expect(edge?.base).toBe(baseID)

          const live = yield* SemanticPrune.gcCanonicalValues(db, aggregateID)
          expect(live.values).toBe(0)
          expect(
            (yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM event_value WHERE aggregate_id = ${aggregateID}`).pipe(Effect.orDie))
              ?.count,
          ).toBe(2)

          yield* db.run(sql`UPDATE event_value SET refs = 0 WHERE aggregate_id = ${aggregateID} AND value_id = ${childID}`).pipe(Effect.orDie)
          const dead = yield* SemanticPrune.gcCanonicalValues(db, aggregateID)
          expect(dead.values).toBe(2)
          expect(dead.bytes).toBe(baseRaw.byteLength + childFrame.byteLength)
          expect(
            (yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM event_value WHERE aggregate_id = ${aggregateID}`).pipe(Effect.orDie))
              ?.count,
          ).toBe(0)
          expect(
            (yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM event_value_dependency WHERE aggregate_id = ${aggregateID}`).pipe(Effect.orDie))
              ?.count,
          ).toBe(0)
        }).pipe(Effect.provide(sqliteLayer({ filename: path }))),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("quarantines canonical GC when a v5 dependency cannot be proven", async () => {
    const { dir, path } = tempDb()
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* makeDatabase
          yield* DatabaseMigration.apply(db)
          yield* ensureChunkDB(db)
          const aggregateID = "ses_delta_quarantine"
          yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq, owner_id) VALUES (${aggregateID}, 0, NULL)`).pipe(Effect.orDie)

          const missingBase = `${aggregateID}:missing`
          const childID = `${aggregateID}:child`
          const syntheticBase = new TextEncoder().encode(JSON.stringify({ aggregateID, text: "x".repeat(4096) }))
          const childRaw = new TextEncoder().encode(JSON.stringify({ aggregateID, text: "x".repeat(4095) + "y" }))
          const childFrame = compressDeltaRef(childRaw, syntheticBase, missingBase, 1, 1)
          yield* db.run(sql`
            INSERT INTO event_value (aggregate_id, value_id, sha256, raw_len, bytes, refs, time_promoted)
            VALUES (
              ${aggregateID},
              ${childID},
              ${createHash("sha256").update(childRaw).digest("hex")},
              ${childRaw.byteLength},
              ${childFrame},
              0,
              1
            )
          `).pipe(Effect.orDie)

          // Dependency backfill cannot create an edge because the declared base
          // does not exist. GC must therefore preserve the zero-ref child rather
          // than guessing that it is unreachable.
          const pass = yield* runSemanticPrunePass(db, { limit: 8, now: Date.now() })
          expect(pass.dependencyComplete).toBe(true)
          expect(pass.dependencyBackfilled).toBe(0)
          const gc = yield* SemanticPrune.gcCanonicalValues(db, aggregateID)
          expect(gc).toEqual({ values: 0, bytes: 0 })
          expect(
            (yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM event_value WHERE aggregate_id = ${aggregateID}`).pipe(Effect.orDie))
              ?.count,
          ).toBe(1)
        }).pipe(Effect.provide(sqliteLayer({ filename: path }))),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
