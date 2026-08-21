import type { Argv } from "yargs"
import { spawn } from "child_process"
import { Database } from "@opencode-ai/core/database/database"
import { withBackfillDb } from "@opencode-ai/core/database/database"
import { decompressFrame, OCDBFrameError, restoreText, decodeStored } from "@opencode-ai/core/database/json-codec"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { CliError, effectCmd } from "../effect-cmd"

/**
 * Epoch-2 dedup reference encoding (owned by schema-v2): a promoted event's
 * `data` is the JSON `{"$cdbRef": "<value_id>"}`; the actual payload bytes live
 * once in `event_value` keyed by (aggregate_id, value_id). These helpers let the
 * CLI read that shape without depending on the sealer's internals.
 */
const CDB_REF = "$cdbRef"

/** Parse a `$cdbRef` value_id out of an event.data TEXT cell, or null if absent. */
function parseCdbRef(data: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (parsed && typeof parsed === "object" && CDB_REF in parsed) {
    const ref = (parsed as Record<string, unknown>)[CDB_REF]
    if (typeof ref === "string") return ref
  }
  return null
}

/** Composite key for the `event_value` (aggregate_id, value_id) primary shape. */
function valueKey(aggregateId: string, valueId: string): string {
  return `${aggregateId}\\u0000${valueId}`
}

const encoder = new TextEncoder()

const QueryCommand = effectCmd({
  command: "$0 [query]",
  describe: "open an interactive sqlite3 shell or run a query",
  instance: false,
  builder: (yargs: Argv) => {
    return yargs
      .positional("query", {
        type: "string",
        describe: "SQL query to execute",
      })
      .option("format", {
        type: "string",
        choices: ["json", "tsv"],
        default: "tsv",
        describe: "Output format",
      })
  },
  handler: Effect.fn("Cli.db.query")(function* (args: { query?: string; format: string }) {
    const query = args.query as string | undefined
    if (query) {
      const { db } = yield* Database.Service
      const result = yield* db.all<Record<string, unknown>>(sql.raw(query)).pipe(Effect.orDie)
      if (args.format === "json") console.log(JSON.stringify(result, null, 2))
      else if (result.length > 0) {
        const keys = Object.keys(result[0])
        console.log(keys.join("\t"))
        for (const row of result) console.log(keys.map((key) => row[key]).join("\t"))
      }
      return
    }
    const child = spawn("sqlite3", [Database.path()], {
      stdio: "inherit",
    })
    yield* Effect.promise(() => new Promise((resolve) => child.on("close", resolve)))
  }),
})

const PathCommand = effectCmd({
  command: "path",
  describe: "print the database path",
  instance: false,
  handler: Effect.fn("Cli.db.path")(function* () {
    console.log(Database.path())
  }),
})

/**
 * Verify and repair ChunkDB framed rows. Read-only by default (audit); repair
 * and reverse-export rewrite rows but never delete the database or silently
 * drop a corrupt frame (it is moved to `ocdb_quarantine` instead).
 */
const RestoreCommand = effectCmd({
  command: "restore",
  describe: "verify and repair ChunkDB framed rows",
  instance: false,
  builder: (yargs: Argv) => {
    return yargs
      .option("db", {
        type: "string",
        demandOption: true,
        describe: "path to the ChunkDB sqlite file",
      })
      .option("mode", {
        type: "string",
        choices: ["audit", "repair", "reverse-export"] as const,
        default: "audit",
        describe: "restore mode: audit (default), repair, or reverse-export",
      })
      .option("backup", {
        type: "string",
        describe: "path to a backup db to copy original TEXT from (repair mode)",
      })
  },
  handler: Effect.fn("Cli.db.restore")(function* (args: { db: string; mode: string; backup?: string }) {
    const result = yield* withBackfillDb(args.db, (db) =>
      Effect.gen(function* () {
        const rows = yield* db.all<{ id: string; aggregate_id: string; data: Uint8Array }>(
          "SELECT id, aggregate_id, data FROM event WHERE typeof(data)='blob'",
        )

        if (args.mode === "audit") {
          let framed = 0
          const errors: Record<string, number> = {}
          for (const row of rows) {
            try {
              decompressFrame(row.data)
              framed++
            } catch (e) {
              const reason = e instanceof OCDBFrameError ? e.reason : String(e)
              errors[reason] = (errors[reason] ?? 0) + 1
            }
          }
          const scanned = rows.length
          const ok = Object.keys(errors).length === 0
          return { kind: "audit" as const, scanned, framed, errors, ok }
        }

        if (args.mode === "reverse-export") {
          // Epoch-1 path: framed BLOB rows -> plain TEXT.
          let reverted = 0
          let failed = 0
          for (const row of rows) {
            try {
              const text = restoreText(row.data)
              yield* db.run(sql`UPDATE event SET data = ${text} WHERE id = ${row.id}`)
              reverted++
            } catch {
              failed++
            }
          }

          // Epoch-2 path: $cdbRef TEXT rows -> full payload TEXT. Look each ref
          // up in event_value, decode (decompress if needed), and splice the
          // original payload back so the DB is self-contained plain TEXT again.
          let dedupReverted = 0
          let dedupFailed = 0
          const valueTable = yield* db.get<{ name: string }>(
            sql`SELECT name FROM sqlite_master WHERE type='table' AND name='event_value'`,
          )
          if (valueTable) {
            const valueRows = yield* db.all<{ aggregate_id: string; value_id: string; bytes: Uint8Array }>(
              "SELECT aggregate_id, value_id, bytes FROM event_value",
            )
            const valueMap = new Map<string, Uint8Array>()
            for (const v of valueRows) valueMap.set(valueKey(v.aggregate_id, v.value_id), v.bytes)

            const refRows = yield* db.all<{ id: string; aggregate_id: string; data: string }>(
              "SELECT id, aggregate_id, data FROM event WHERE typeof(data)='text' AND data LIKE '%$cdbRef%'",
            )
            for (const e of refRows) {
              const ref = parseCdbRef(e.data)
              if (!ref) continue
              const bytes = valueMap.get(valueKey(e.aggregate_id, ref))
              if (!bytes) {
                dedupFailed++
                continue
              }
              try {
                const text = decodeStored(bytes)
                yield* db.run(sql`UPDATE event SET data = ${text} WHERE id = ${e.id}`)
                dedupReverted++
              } catch {
                dedupFailed++
              }
            }
          }

          // Downgrade safety net: a plain-TEXT DB must be openable by the OLD
          // binary, which refuses user_version > 1. Reset the epoch gate so the
          // reverted file is accepted as a legacy (epoch-1) database.
          yield* db.run(`PRAGMA user_version = 1`).pipe(Effect.orDie)
          yield* db
            .run(
              sql`INSERT INTO ocdb_meta(key, value) VALUES ('framing_epoch', '1')
                ON CONFLICT(key) DO UPDATE SET value = '1'`,
            )
            .pipe(Effect.orDie)

          return {
            kind: "reverse-export" as const,
            reverted,
            failed,
            dedupReverted,
            dedupFailed,
            total: rows.length,
          }
        }

        // repair mode
        const repairedIds: string[] = []
        const quarantinedIds: string[] = []
        const backup = args.backup

        const quarantine = (id: string, data: Uint8Array, reason: string) =>
          Effect.gen(function* () {
            yield* db.run(sql`CREATE TABLE IF NOT EXISTS ocdb_quarantine (
              id TEXT PRIMARY KEY,
              data BLOB,
              reason TEXT,
              time_quarantined INTEGER
            )`)
            yield* db.run(sql`INSERT INTO ocdb_quarantine (id, data, reason, time_quarantined)
              VALUES (${id}, ${data}, ${reason}, ${Date.now()})
              ON CONFLICT (id) DO UPDATE SET
                data = excluded.data,
                reason = excluded.reason,
                time_quarantined = excluded.time_quarantined`)
          })

        if (backup) {
          yield* withBackfillDb(backup, (backupDb) =>
            Effect.gen(function* () {
              for (const row of rows) {
                try {
                  decompressFrame(row.data)
                  continue
                } catch (e) {
                  const reason = e instanceof OCDBFrameError ? e.reason : String(e)
                  const original = yield* backupDb.get<{ data: Uint8Array | string }>(
                    sql`SELECT data FROM event WHERE id = ${row.id}`,
                  )
                  if (original) {
                    yield* db.run(sql`UPDATE event SET data = ${original.data} WHERE id = ${row.id}`)
                    repairedIds.push(row.id)
                  } else {
                    yield* quarantine(row.id, row.data, reason)
                    quarantinedIds.push(row.id)
                  }
                }
              }
            }),
          )
        } else {
          for (const row of rows) {
            try {
              decompressFrame(row.data)
              continue
            } catch (e) {
              const reason = e instanceof OCDBFrameError ? e.reason : String(e)
              try {
                const text = restoreText(row.data)
                yield* db.run(sql`UPDATE event SET data = ${text} WHERE id = ${row.id}`)
                repairedIds.push(row.id)
              } catch {
                yield* quarantine(row.id, row.data, reason)
                quarantinedIds.push(row.id)
              }
            }
          }
        }

        // Epoch-2 path: quarantine dangling $cdbRef rows — refs whose value_id
        // does not resolve to an event_value row. Resolvable refs are valid and
        // left untouched; only dangling refs are quarantined, matching the
        // "quarantine, never silently drop" contract used for corrupt frames.
        const valueTable = yield* db.get<{ name: string }>(
          sql`SELECT name FROM sqlite_master WHERE type='table' AND name='event_value'`,
        )
        if (valueTable) {
          const valueRows = yield* db.all<{ aggregate_id: string; value_id: string; bytes: Uint8Array }>(
            "SELECT aggregate_id, value_id, bytes FROM event_value",
          )
          const valueMap = new Map<string, Uint8Array>()
          for (const v of valueRows) valueMap.set(valueKey(v.aggregate_id, v.value_id), v.bytes)

          const refRows = yield* db.all<{ id: string; aggregate_id: string; data: string }>(
            "SELECT id, aggregate_id, data FROM event WHERE typeof(data)='text'",
          )
          for (const e of refRows) {
            const ref = parseCdbRef(e.data)
            if (!ref) continue
            if (valueMap.has(valueKey(e.aggregate_id, ref))) continue
            yield* quarantine(e.id, encoder.encode(e.data), `dangling ${CDB_REF}: ${ref}`)
            quarantinedIds.push(e.id)
          }
        }

        return {
          kind: "repair" as const,
          repaired: repairedIds.length,
          quarantined: quarantinedIds.length,
          backupUsed: Boolean(backup),
          repairedIds,
          quarantinedIds,
        }
      }),
    ).pipe(Effect.mapError((e) => new CliError({ message: `ChunkDB restore failed: ${String(e)}` })))

    if (result.kind === "audit") {
      console.log(
        JSON.stringify(
          { scanned: result.scanned, framed: result.framed, errors: result.errors, ok: result.ok },
          null,
          2,
        ),
      )
    } else if (result.kind === "reverse-export") {
      console.log(
        JSON.stringify(
          {
            mode: "reverse-export",
            reverted: result.reverted,
            failed: result.failed,
            dedupReverted: result.dedupReverted,
            dedupFailed: result.dedupFailed,
            total: result.total,
            gateReset: "user_version=1, framing_epoch=1 (downgrade safety net)",
          },
          null,
          2,
        ),
      )
    } else {
      console.log(
        JSON.stringify(
          {
            mode: "repair",
            repaired: result.repaired,
            quarantined: result.quarantined,
            backupUsed: result.backupUsed,
            repairedIds: result.repairedIds,
            quarantinedIds: result.quarantinedIds,
          },
          null,
          2,
        ),
      )
    }
  }),
})

/**
 * Audit ChunkDB framing coverage and integrity: what fraction of the `event`
 * table is framed, how many framed rows fail a full CRC check, and how many
 * bytes the sealer has saved per `ocdb_seal`.
 */
const CheckCommand = effectCmd({
  command: "check",
  describe: "audit ChunkDB framing coverage and integrity",
  instance: false,
  builder: (yargs: Argv) => {
    return yargs.option("db", {
      type: "string",
      demandOption: true,
      describe: "path to the ChunkDB sqlite file",
    })
  },
  handler: Effect.fn("Cli.db.check")(function* (args: { db: string }) {
    const report = yield* withBackfillDb(args.db, (db) =>
      Effect.gen(function* () {
        const totalRow = yield* db.get<{ count: number }>(sql`SELECT count(*) as count FROM event`)
        const total = totalRow?.count ?? 0

        const framedRow = yield* db.get<{ count: number }>(
          sql`SELECT count(*) as count FROM event WHERE typeof(data)='blob'`,
        )
        const framed = framedRow?.count ?? 0

        const rows = yield* db.all<{ id: string; data: Uint8Array }>(
          "SELECT id, data FROM event WHERE typeof(data)='blob'",
        )
        const frameErrors: Record<string, number> = {}
        for (const row of rows) {
          try {
            decompressFrame(row.data)
          } catch (e) {
            const reason = e instanceof OCDBFrameError ? e.reason : String(e)
            frameErrors[reason] = (frameErrors[reason] ?? 0) + 1
          }
        }

        const sealExists = yield* db.get<{ name: string }>(
          sql`SELECT name FROM sqlite_master WHERE type='table' AND name='ocdb_seal'`,
        )
        let raw = 0
        let stored = 0
        if (sealExists) {
          const seal = yield* db.get<{ raw: number | null; stored: number | null }>(
            sql`SELECT sum(raw_bytes) as raw, sum(stored_bytes) as stored FROM ocdb_seal`,
          )
          raw = seal?.raw ?? 0
          stored = seal?.stored ?? 0
        }
        const bytesSaved = raw - stored

        const coveragePct = total > 0 ? (framed / total) * 100 : 0
        const errorCount = Object.values(frameErrors).reduce((a, b) => a + b, 0)

        // --- Epoch-2 dedup reporting ---
        // event_value holds each distinct large/cold payload once, keyed by
        // (aggregate_id, value_id); a deduped event.data is the JSON
        // {"$cdbRef": "<value_id>"}. Report the dedup ratio (bytes saved by
        // storing one copy instead of one per ref), ref integrity (every ref
        // resolves), and a rehydration round-trip sanity count.
        const valueTable = yield* db.get<{ name: string }>(
          sql`SELECT name FROM sqlite_master WHERE type='table' AND name='event_value'`,
        )
        let dedup: {
          distinct_values: number
          sum_bytes: number
          original_raw_len: number
          bytes_saved_by_dedup: number
          dedup_pct: number
          refs_total: number
          resolved_refs: number
          dangling_refs: number
          rehydration_ok: number
          rehydration_checked: number
        } | null = null
        let dangling = 0
        if (valueTable) {
          const valueRows = yield* db.all<{ aggregate_id: string; value_id: string; raw_len: number; bytes: Uint8Array }>(
            "SELECT aggregate_id, value_id, raw_len, bytes FROM event_value",
          )
          const valueMap = new Map<string, Uint8Array>()
          const rawLenMap = new Map<string, number>()
          let sumBytes = 0
          for (const v of valueRows) {
            const key = valueKey(v.aggregate_id, v.value_id)
            valueMap.set(key, v.bytes)
            rawLenMap.set(key, v.raw_len)
            sumBytes += v.bytes.byteLength
          }

          const refRows = yield* db.all<{ id: string; aggregate_id: string; data: string }>(
            "SELECT id, aggregate_id, data FROM event WHERE typeof(data)='text' AND data LIKE '%$cdbRef%'",
          )
          const refCountByValue = new Map<string, number>()
          let resolved = 0
          for (const e of refRows) {
            const ref = parseCdbRef(e.data)
            if (!ref) continue
            const key = valueKey(e.aggregate_id, ref)
            refCountByValue.set(key, (refCountByValue.get(key) ?? 0) + 1)
            if (valueMap.has(key)) resolved++
            else dangling++
          }

          // Decode each distinct referenced value once to confirm it round-trips
          // (decode + JSON.parse). The original raw length comes from the
          // event_value.raw_len column (no need to re-decode for the ratio).
          const roundTripByValue = new Map<string, boolean>()
          let originalRawLen = 0
          for (const [key, count] of refCountByValue) {
            const bytes = valueMap.get(key)
            if (!bytes) continue
            originalRawLen += (rawLenMap.get(key) ?? 0) * count
            let ok = false
            try {
              const text = decodeStored(bytes)
              JSON.parse(text)
              ok = true
            } catch {
              ok = false
            }
            roundTripByValue.set(key, ok)
          }
          let rehydrateOk = 0
          for (const [key, count] of refCountByValue) {
            if (roundTripByValue.get(key)) rehydrateOk += count
          }

          const refsTotal = resolved + dangling
          const bytesSavedByDedup = originalRawLen - sumBytes
          dedup = {
            distinct_values: valueMap.size,
            sum_bytes: sumBytes,
            original_raw_len: originalRawLen,
            bytes_saved_by_dedup: bytesSavedByDedup,
            dedup_pct: originalRawLen > 0 ? Math.round((1 - sumBytes / originalRawLen) * 10000) / 100 : 0,
            refs_total: refsTotal,
            resolved_refs: resolved,
            dangling_refs: dangling,
            rehydration_ok: rehydrateOk,
            rehydration_checked: refsTotal,
          }
        }

        // --- Epoch gate (schema-v2 owns the gate; we surface it) ---
        // A dedup-shaped DB must carry user_version=2 / framing_epoch='2' so the
        // OLD binary (which refuses user_version > 1) cannot open a shape it
        // cannot understand. If a DB claims dedup but the gate is < 2, that is a
        // consistency warning.
        const uvRow = yield* db.get<{ user_version: number }>(sql`PRAGMA user_version`)
        const userVersion = uvRow?.user_version ?? 0
        const metaExists = yield* db.get<{ name: string }>(
          sql`SELECT name FROM sqlite_master WHERE type='table' AND name='ocdb_meta'`,
        )
        let framingEpoch: string | null = null
        if (metaExists) {
          const fe = yield* db.get<{ value: string | null }>(
            sql`SELECT value FROM ocdb_meta WHERE key='framing_epoch'`,
          )
          framingEpoch = fe?.value ?? null
        }
        const dedupShaped = (dedup?.distinct_values ?? 0) > 0 || framingEpoch === "2"
        let gateWarning: string | null = null
        if (dedupShaped && userVersion < 2) {
          gateWarning = `DB claims dedup (framing_epoch=${framingEpoch ?? "unset"}, event_value rows=${dedup?.distinct_values ?? 0}) but user_version=${userVersion} (<2). Old binary would refuse; new binary expects user_version=2.`
        }

        let verdict: "empty" | "ok" | "corrupt" | "inconsistent" =
          total === 0 ? "empty" : errorCount === 0 && dangling === 0 ? "ok" : "corrupt"
        if (verdict === "ok" && gateWarning) verdict = "inconsistent"

        return {
          coverage_pct: Math.round(coveragePct * 100) / 100,
          bytes_saved: bytesSaved,
          framed_rows: framed,
          frame_errors: frameErrors,
          dedup,
          dangling_refs: dangling,
          gate: {
            user_version: userVersion,
            framing_epoch: framingEpoch,
            dedup_shaped: dedupShaped,
            warning: gateWarning,
          },
          verdict,
        }
      }),
    ).pipe(Effect.mapError((e) => new CliError({ message: `ChunkDB check failed: ${String(e)}` })))

    console.log(JSON.stringify(report, null, 2))
  }),
})

export const DbCommand = effectCmd({
  command: "db",
  describe: "database tools",
  instance: false,
  builder: (yargs: Argv) => {
    return yargs
      .command(QueryCommand)
      .command(PathCommand)
      .command(RestoreCommand)
      .command(CheckCommand)
      .demandCommand()
  },
  handler: Effect.fn("Cli.db")(function* () {}),
})
