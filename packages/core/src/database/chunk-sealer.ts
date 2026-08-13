import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { compressText } from "./json-codec"

/**
 * Fork-owned cold-row sealer for the OpenCode ChunkDB prototype (t6 slice:
 * event.data only). Runs OUTSIDE any projector/event transaction and never on
 * the hot path: hot writes go through the identity toDriver in json-codec.ts,
 * so this job is the ONLY frame producer.
 *
 * Eligibility (per row (aggregate_id, seq)):
 *   seq <= event_sequence.seq                    (settled frontier — event_sequence
 *                                                holds the max durable seq per aggregate;
 *                                                session_context_epoch is unpopulated in
 *                                                the real fork DB, so it is NOT the frontier)
 *   AND event_sequence.owner_id IS NULL         (not claimed/running)
 *   AND session.time_updated <= cooling cutoff  (dormant — event has no timestamp)
 *   AND typeof(event.data) = 'text'             (idempotent: skip framed)
 *   AND length(event.data) >= 4096              (code units; see threshold note)
 *
 * Each batch = one short transaction (UPDATE + journal UPSERT) sharing the
 * Semaphore(1) client; yields between batches so interactive reads interleave.
 */

const COOLING_MS = 48 * 60 * 60 * 1000
const BATCH_SIZE = 128
const MAX_ROWS_PER_PASS = 5_000

export interface Interface {
  readonly runPass: () => Effect.Effect<{ sealed: number; bytes: number }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/fork/ChunkSealer") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    yield* db
      .run(
        `CREATE TABLE IF NOT EXISTS ocdb_seal (
          table_name TEXT NOT NULL,
          row_id TEXT NOT NULL,
          raw_bytes INTEGER NOT NULL,
          stored_bytes INTEGER NOT NULL,
          time_sealed INTEGER NOT NULL,
          PRIMARY KEY (table_name, row_id)
        )`,
      )
      .pipe(Effect.orDie)

    // Partial expression index on the sealer's candidate filter — lets the
    // eligibility SELECT seek directly to text rows >=4KiB instead of scanning
    // all 1.37M event rows per batch. Measured on the real DB: eligibility
    // batch 8.9s -> 0.13s (68x). Same fork-adjacent pattern as
    // idx_message_provider_id in session/usage.ts — no schema change, and it
    // is inert for stock reads (only the sealer's WHERE uses it).
    yield* db
      .run(
        `CREATE INDEX IF NOT EXISTS idx_event_seal_candidates
         ON event (aggregate_id, seq)
         WHERE typeof(data) = 'text' AND length(data) >= 4096`,
      )
      .pipe(Effect.orDie)

    const runPass = Effect.fn("ChunkSealer.runPass")(function* () {
      const cutoff = Date.now() - COOLING_MS
      let sealed = 0
      let bytes = 0

      for (;;) {
        // Eligibility SELECT is OUTSIDE the transaction; each row's UPDATE +
        // journal UPSERT run in ONE short transaction (crash-consistent).
        const candidates = yield* db
          .all<{ id: string; data: string }>(
            `SELECT e.id, e.data
             FROM event e
             JOIN event_sequence es ON es.aggregate_id = e.aggregate_id
             LEFT JOIN session se ON se.id = e.aggregate_id
             WHERE e.seq <= es.seq
               AND es.owner_id IS NULL
               AND (se.time_updated IS NULL OR se.time_updated <= ${cutoff})
               AND typeof(e.data) = 'text'
               AND length(e.data) >= 4096
             ORDER BY e.aggregate_id, e.seq
             LIMIT ${BATCH_SIZE}`,
          )
          .pipe(Effect.orDie)

        if (candidates.length === 0) break
        for (const candidate of candidates) {
          const frame = compressText(candidate.data)
          if (typeof frame === "string") continue
          yield* db
            .run(
              `BEGIN IMMEDIATE;
               UPDATE event SET data = ? WHERE id = ?;
               INSERT INTO ocdb_seal (table_name, row_id, raw_bytes, stored_bytes, time_sealed)
               VALUES ('event', ?, ?, ?, ?)
               ON CONFLICT (table_name, row_id) DO UPDATE SET
                 raw_bytes = excluded.raw_bytes,
                 stored_bytes = excluded.stored_bytes,
                 time_sealed = excluded.time_sealed;
               COMMIT;`,
              [frame, candidate.id, candidate.id, candidate.data.length, frame.byteLength, Date.now()],
            )
            .pipe(Effect.orDie)
          sealed += 1
          bytes += candidate.data.length
        }
        yield* Effect.yieldNow()
        if (sealed >= MAX_ROWS_PER_PASS) break
      }

      return { sealed, bytes }
    })

    return Service.of({ runPass })
  }),
)

export const node = Layer.effect(Service, layer)
export const defaultLayer = layer
