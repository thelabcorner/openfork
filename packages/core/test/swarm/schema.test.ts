import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import { DatabaseMigration } from "../../src/database/migration"
import runtimeSessionOwnership from "../../src/database/migration/20260919052438_runtime_session_ownership"
import swarmFoundation from "../../src/database/migration/20260919053140_swarm_foundation"
import swarmDispatchReady from "../../src/database/migration/20260919180119_swarm_dispatch_ready"
import swarmDeliveryDeadlines from "../../src/database/migration/20260919183345_swarm_delivery_deadlines"
import swarmRuntimeDeadlines from "../../src/database/migration/20260919204232_swarm_runtime_deadlines"
import swarmRetirementScan from "../../src/database/migration/20260919205014_swarm_retirement_scan"
import swarmRecoveryOwnerScan from "../../src/database/migration/20260919213551_swarm_recovery_owner_scan"
import swarmTaskRunResultSummary from "../../src/database/migration/20261003041000_swarm_task_run_result_summary"

const makeDb = EffectDrizzleSqlite.makeWithDefaults()
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped) as Effect.Effect<A, E>,
  )

describe("Swarm database foundation", () => {
  test("runtime ownership migration does not pre-create Swarm foundation tables", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)

        yield* DatabaseMigration.applyOnly(db, [runtimeSessionOwnership])

        expect(
          yield* db.all<{ name: string }>(
            sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'swarm%' ORDER BY name`,
          ),
        ).toEqual([])
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runtime_owner'`),
        ).toEqual({ name: "runtime_owner" })
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_execution_owner'`),
        ).toEqual({ name: "session_execution_owner" })
      }),
    )
  })

  test("repairs the empty Swarm tables leaked by the prior runtime ownership migration", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE project (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE workspace (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        yield* DatabaseMigration.applyOnly(db, [runtimeSessionOwnership])

        // Reproduce the distinctive partial schema produced by the bad
        // 20260919052438 migration that shipped in a local pre-release build.
        yield* db.run(sql`CREATE TABLE swarm_blackboard (swarm_id text NOT NULL, key text NOT NULL)`)
        yield* db.run(
          sql`CREATE TABLE swarm_message (
            id text PRIMARY KEY,
            swarm_id text NOT NULL,
            sender_member_id text NOT NULL,
            kind text NOT NULL,
            body text NOT NULL,
            priority integer DEFAULT 0 NOT NULL,
            time_created integer NOT NULL
          )`,
        )

        yield* DatabaseMigration.applyOnly(db, [swarmFoundation])

        const messageColumns = yield* db.all<{ name: string; type: string; dflt_value: string | null }>(
          sql`PRAGMA table_info(swarm_message)`,
        )
        expect(messageColumns.find((column) => column.name === "sender_session_id")?.type).toBe("TEXT")
        expect(messageColumns.find((column) => column.name === "sender_binding_generation")?.type).toBe("INTEGER")
        expect(messageColumns.find((column) => column.name === "priority")).toMatchObject({
          type: "TEXT",
          dflt_value: "'normal'",
        })
        expect(messageColumns.find((column) => column.name === "reply_expected")?.type).toBe("INTEGER")
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'swarm_deliverable'`),
        ).toEqual({ name: "swarm_deliverable" })
      }),
    )
  })

  test("never discards durable rows while repairing the leaked pre-release Swarm schema", async () => {
    await expect(
      run(
        Effect.gen(function* () {
          const db = yield* makeDb
          yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
          yield* DatabaseMigration.applyOnly(db, [runtimeSessionOwnership])
          yield* db.run(sql`CREATE TABLE swarm_blackboard (swarm_id text NOT NULL, key text NOT NULL)`)
          yield* db.run(
            sql`CREATE TABLE swarm_message (
              id text PRIMARY KEY,
              swarm_id text NOT NULL,
              sender_member_id text NOT NULL,
              kind text NOT NULL,
              body text NOT NULL,
              priority integer DEFAULT 0 NOT NULL,
              time_created integer NOT NULL
            )`,
          )
          yield* db.run(sql`INSERT INTO swarm_blackboard (swarm_id, key) VALUES ('swr_existing', 'keep')`)

          yield* DatabaseMigration.applyOnly(db, [swarmFoundation])
        }),
      ),
    ).rejects.toThrow("refusing to discard durable data")
  })

  test("result-summary migration adds a nullable/no-default column for historical runs", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        yield* db.run(sql`CREATE TABLE project (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE workspace (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        yield* DatabaseMigration.applyOnly(db, [swarmFoundation, swarmTaskRunResultSummary])

        const columns = yield* db.all<{
          name: string
          type: string
          notnull: number
          dflt_value: string | null
        }>(sql`PRAGMA table_info(swarm_task_run)`)
        expect(columns.find((column) => column.name === "result_summary")).toMatchObject({
          name: "result_summary",
          type: "TEXT",
          notnull: 0,
          dflt_value: null,
        })
      }),
    )
  })

  test("upgrade migration creates normalized tables, CHECK and hot-path indexes", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        yield* db.run(sql`CREATE TABLE project (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE workspace (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)

        yield* DatabaseMigration.applyOnly(db, [swarmFoundation])

        const tables = yield* db.all<{ name: string }>(
          sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'swarm%' ORDER BY name`,
        )
        expect(tables.map((row) => row.name)).toEqual([
          "swarm",
          "swarm_blackboard",
          "swarm_claim",
          "swarm_deliverable",
          "swarm_member",
          "swarm_message",
          "swarm_message_delivery",
          "swarm_task",
          "swarm_task_dependency",
          "swarm_task_lease",
          "swarm_task_run",
        ])

        const readyIndex = yield* db.get<{ sql: string }>(
          sql`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'swarm_task_ready_idx'`,
        )
        expect(readyIndex?.sql).toContain('"priority" DESC')

        const messageColumns = yield* db.all<{ name: string; type: string; dflt_value: string | null }>(
          sql`PRAGMA table_info(swarm_message)`,
        )
        expect(messageColumns.find((column) => column.name === "priority")).toMatchObject({
          type: "TEXT",
          dflt_value: "'normal'",
        })
        expect(messageColumns.find((column) => column.name === "reply_expected")).toMatchObject({
          type: "INTEGER",
        })

        const readyPlan = yield* db.all<{ detail: string }>(sql`
          EXPLAIN QUERY PLAN
          SELECT id
          FROM swarm_task
          WHERE swarm_id = 'swr_test' AND status = 'ready'
          ORDER BY priority DESC, ready_at, time_created, id
          LIMIT 64
        `)
        expect(readyPlan.map((row) => row.detail).join("\n")).toContain("swarm_task_ready_idx")

        const deliveryDuePlan = yield* db.all<{ detail: string }>(sql`
          EXPLAIN QUERY PLAN
          SELECT id
          FROM swarm_message_delivery
          WHERE state = 'pending' AND next_attempt_at <= 100
          ORDER BY next_attempt_at, id
          LIMIT 64
        `)
        expect(deliveryDuePlan.map((row) => row.detail).join("\n")).toContain("swarm_message_delivery_due_idx")

        const summaryPlan = yield* db.all<{ detail: string }>(sql`
          EXPLAIN QUERY PLAN
          SELECT count(*)
          FROM swarm_message_delivery AS delivery
          INNER JOIN swarm_member AS member ON delivery.recipient_member_id = member.id
          WHERE member.swarm_id = 'swr_test' AND delivery.state = 'pending'
        `)
        const summaryDetails = summaryPlan.map((row) => row.detail).join("\n")
        expect(summaryDetails).toContain("swarm_member_roster_idx")
        expect(summaryDetails).toContain("swarm_message_delivery_recipient_pending_idx")

        const navigationPlan = yield* db.all<{ detail: string }>(sql`
          EXPLAIN QUERY PLAN
          SELECT member.id, session.id
          FROM swarm_member AS member
          INNER JOIN session ON session.id = member.session_id
          WHERE member.swarm_id IN ('swr_test') AND member.session_id IS NOT NULL
          ORDER BY member.swarm_id, member.time_created, member.id
        `)
        const navigationDetails = navigationPlan.map((row) => row.detail).join("\n")
        expect(navigationDetails).toContain("swarm_member_bound_session_idx")

        yield* db.run(sql`INSERT INTO project (id) VALUES ('global')`)
        yield* db.run(
          sql`INSERT INTO swarm (id, project_id, directory, name, status, policy, revision, time_created, time_updated)
              VALUES ('swr_test', 'global', '/project', 'test', 'active', '{}', 0, 1, 1)`,
        )
        yield* db.run(
          sql`INSERT INTO swarm_task
              (id, swarm_id, title, status, priority, reservation_revision, lease_generation, semantic_retry_count, acceptance, metadata, time_created, time_updated)
              VALUES ('swt_a', 'swr_test', 'a', 'ready', 0, 0, 0, 0, '{"criteria":[]}', '{}', 1, 1)`,
        )
        const selfEdge = yield* db
          .run(
            sql`INSERT INTO swarm_task_dependency (task_id, depends_on_task_id, requirement)
                VALUES ('swt_a', 'swt_a', 'require_success')`,
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(selfEdge)).toBe(true)
      }),
    )
  })

  test("fresh bootstrap contains Swarm tables without replaying the upgrade migration", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)

        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'swarm_message_delivery'`),
        ).toEqual({ name: "swarm_message_delivery" })
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'swarm_deliverable'`),
        ).toEqual({ name: "swarm_deliverable" })
        expect(
          yield* db.get(sql`SELECT id FROM migration WHERE id = ${swarmFoundation.id}`),
        ).toEqual({ id: swarmFoundation.id })

        const dependencySql = yield* db.get<{ sql: string }>(
          sql`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'swarm_task_dependency'`,
        )
        expect(dependencySql?.sql).toContain("swarm_task_dependency_no_self_check")
      }),
    )
  })

  test("dispatch migration adds a global partial ready-work index used by the scheduler scan", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        yield* db.run(sql`CREATE TABLE project (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE workspace (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        yield* DatabaseMigration.applyOnly(db, [swarmFoundation, swarmDispatchReady])

        const index = yield* db.get<{ sql: string }>(
          sql`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'swarm_task_dispatch_ready_idx'`,
        )
        expect(index?.sql).toContain("WHERE \"swarm_task\".\"status\" = 'ready'")

        const plan = yield* db.all<{ detail: string }>(sql`
          EXPLAIN QUERY PLAN
          SELECT task.id
          FROM swarm_task AS task INDEXED BY swarm_task_dispatch_ready_idx
          INNER JOIN swarm AS owner_swarm ON owner_swarm.id = task.swarm_id
          WHERE task.status = 'ready'
            AND owner_swarm.status = 'active'
          ORDER BY task.priority DESC, task.ready_at, task.time_created, task.id
          LIMIT 16
        `)
        expect(plan.map((row) => row.detail).join("\n")).toContain("swarm_task_dispatch_ready_idx")
      }),
    )
  })

  test("delivery deadline migration gives expiry and mailbox scans indexed global paths", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        yield* db.run(sql`CREATE TABLE project (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE workspace (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        yield* DatabaseMigration.applyOnly(db, [swarmFoundation, swarmDispatchReady, swarmDeliveryDeadlines])

        const expiryPlan = yield* db.all<{ detail: string }>(sql`
          EXPLAIN QUERY PLAN
          SELECT delivery.id
          FROM swarm_message AS message INDEXED BY swarm_message_expiry_idx
          INNER JOIN swarm_message_delivery AS delivery ON delivery.message_id = message.id
          WHERE message.expires_at IS NOT NULL
            AND message.expires_at <= 100
            AND delivery.state IN ('pending', 'claimed')
          ORDER BY message.expires_at, delivery.id
          LIMIT 32
        `)
        expect(expiryPlan.map((row) => row.detail).join("\n")).toContain("swarm_message_expiry_idx")

        const pendingPlan = yield* db.all<{ detail: string }>(sql`
          EXPLAIN QUERY PLAN
          SELECT delivery.id
          FROM swarm_message_delivery AS delivery INDEXED BY swarm_message_delivery_due_idx
          INNER JOIN swarm_message AS message ON message.id = delivery.message_id
          INNER JOIN swarm_member AS member ON member.id = delivery.recipient_member_id
          WHERE delivery.state = 'pending'
            AND (delivery.next_attempt_at IS NULL OR delivery.next_attempt_at <= 100)
            AND (message.expires_at IS NULL OR message.expires_at > 100)
            AND member.lifecycle = 'active'
            AND member.session_id IS NOT NULL
          ORDER BY delivery.next_attempt_at, delivery.id
          LIMIT 32
        `)
        expect(pendingPlan.map((row) => row.detail).join("\n")).toContain("swarm_message_delivery_due_idx")

        const reclaimPlan = yield* db.all<{ detail: string }>(sql`
          EXPLAIN QUERY PLAN
          SELECT delivery.id
          FROM swarm_message_delivery AS delivery INDEXED BY swarm_message_delivery_claim_expiry_idx
          INNER JOIN swarm_message AS message ON message.id = delivery.message_id
          INNER JOIN swarm_member AS member ON member.id = delivery.recipient_member_id
          WHERE delivery.state = 'claimed'
            AND delivery.claim_expires_at <= 100
            AND (message.expires_at IS NULL OR message.expires_at > 100)
            AND member.lifecycle = 'active'
            AND member.session_id IS NOT NULL
          ORDER BY delivery.claim_expires_at, delivery.id
          LIMIT 32
        `)
        expect(reclaimPlan.map((row) => row.detail).join("\n")).toContain("swarm_message_delivery_claim_expiry_idx")
      }),
    )
  })

  test("runtime deadline migration gives renewal, hold, and reservation scans indexed paths", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        yield* db.run(sql`CREATE TABLE project (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE workspace (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        yield* DatabaseMigration.applyOnly(db, [
          swarmFoundation,
          swarmDispatchReady,
          swarmDeliveryDeadlines,
          swarmRuntimeDeadlines,
          swarmRetirementScan,
          swarmRecoveryOwnerScan,
        ])

        const renewalPlan = yield* db.all<{ detail: string }>(sql`
          EXPLAIN QUERY PLAN
          SELECT lease.task_id
          FROM swarm_task_lease AS lease INDEXED BY swarm_task_lease_process_due_idx
          WHERE lease.lease_owner_process = 'owner-a'
            AND lease.expires_at > 100
            AND lease.expires_at <= 200
          ORDER BY lease.expires_at, lease.task_id
          LIMIT 64
        `)
        expect(renewalPlan.map((row) => row.detail).join("\n")).toContain("swarm_task_lease_process_due_idx")

        const holdPlan = yield* db.all<{ detail: string }>(sql`
          EXPLAIN QUERY PLAN
          SELECT lease.task_id
          FROM swarm_task_lease AS lease INDEXED BY swarm_task_lease_hold_due_idx
          WHERE lease.state = 'human_hold'
            AND lease.hold_deadline IS NOT NULL
            AND lease.hold_deadline <= 200
          ORDER BY lease.hold_deadline, lease.task_id
          LIMIT 64
        `)
        expect(holdPlan.map((row) => row.detail).join("\n")).toContain("swarm_task_lease_hold_due_idx")

        const reservationPlan = yield* db.all<{ detail: string }>(sql`
          EXPLAIN QUERY PLAN
          SELECT task.id
          FROM swarm_task AS task INDEXED BY swarm_task_reservation_due_idx
          WHERE task.status = 'ready'
            AND task.reserved_until IS NOT NULL
            AND task.reserved_until > 100
          ORDER BY task.reserved_until, task.id
          LIMIT 1
        `)
        expect(reservationPlan.map((row) => row.detail).join("\n")).toContain("swarm_task_reservation_due_idx")

        const retirementPlan = yield* db.all<{ detail: string }>(sql`
          EXPLAIN QUERY PLAN
          SELECT lease.task_id
          FROM swarm_task_lease AS lease INDEXED BY swarm_task_lease_state_retire_idx
          WHERE lease.state = 'retiring'
          ORDER BY lease.retire_requested_at, lease.task_id
          LIMIT 64
        `)
        expect(retirementPlan.map((row) => row.detail).join("\n")).toContain("swarm_task_lease_state_retire_idx")

        const recoveryOwnerPlan = yield* db.all<{ detail: string }>(sql`
          EXPLAIN QUERY PLAN
          SELECT DISTINCT lease.lease_owner_process
          FROM swarm_task_lease AS lease INDEXED BY swarm_task_lease_state_owner_idx
          WHERE lease.state IN ('active', 'human_hold')
            AND lease.lease_owner_process <> 'owner-current'
          ORDER BY lease.lease_owner_process
          LIMIT 64
        `)
        expect(recoveryOwnerPlan.map((row) => row.detail).join("\n")).toContain("swarm_task_lease_state_owner_idx")
      }),
    )
  })
})
