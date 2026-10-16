import { beforeEach, describe, expect } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { RuntimeOwner } from "@opencode-ai/core/runtime-owner"
import { RuntimeOwnerTable } from "@opencode-ai/core/runtime-owner.sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import { SessionExecutionOwnerTable } from "@opencode-ai/core/session/execution-owner.sql"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const sessionID = SessionSchema.ID.make("ses_execution_recovery_test")
const oldOwnerID = "runtime-owner:dead-old" as RuntimeOwner.ID
const recoveryOwnerID = "runtime-owner:recovery-current" as RuntimeOwner.ID
const foreignRecoveryOwnerID = "runtime-owner:recovery-foreign" as RuntimeOwner.ID

let proof: RuntimeOwner.LocalDeathProof = "alive-or-unknown"
let recoveryProof: RuntimeOwner.LocalDeathProof = "alive-or-unknown"
let retains = 0
let releases = 0
const deathProofCalls = new Map<RuntimeOwner.ID, number>()

const snapshots = new Map<RuntimeOwner.ID, RuntimeOwner.Snapshot>()
const activationRegistryKey = Symbol.for("openfork.session-execution-owner.activations.v1")
type ActivationRegistry = {
  activations: Map<string, { sessionID: string; ownerID: RuntimeOwner.ID; generation: number }>
  acquisitions: Map<string, Set<string>>
}

function activationRegistry() {
  return (globalThis as unknown as Record<symbol, unknown>)[activationRegistryKey] as ActivationRegistry | undefined
}

const fakeRuntime = RuntimeOwner.Service.of({
    id: recoveryOwnerID,
    pid: 222,
    startedAt: 200,
    retain: Effect.sync(() => {
      retains++
      let released = false
      return {
        release: Effect.sync(() => {
          if (released) return
          released = true
          releases++
        }),
      }
    }),
    snapshot: (id) => Effect.succeed(snapshots.get(id)),
    proveLocalDeath: (id) =>
      Effect.sync(() => {
        deathProofCalls.set(id, (deathProofCalls.get(id) ?? 0) + 1)
        return id === foreignRecoveryOwnerID ? recoveryProof : proof
      }),
  })
const fakeRuntimeLayer = Layer.succeed(RuntimeOwner.Service, fakeRuntime)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, SessionExecutionOwner.node]),
    [
      [Database.node, Database.layerFromPath(":memory:")],
      [RuntimeOwner.node, fakeRuntimeLayer],
    ],
  ),
)

beforeEach(() => {
  proof = "alive-or-unknown"
  recoveryProof = "alive-or-unknown"
  retains = 0
  releases = 0
  deathProofCalls.clear()
  snapshots.clear()
  activationRegistry()?.activations.clear()
  activationRegistry()?.acquisitions.clear()
  snapshots.set(oldOwnerID, {
    id: oldOwnerID,
    pid: 111,
    startedAt: 100,
    heartbeatAt: 1,
    controlEpoch: 0,
  })
  snapshots.set(recoveryOwnerID, {
    id: recoveryOwnerID,
    pid: 222,
    startedAt: 200,
    heartbeatAt: 200,
    controlEpoch: 0,
  })
  snapshots.set(foreignRecoveryOwnerID, {
    id: foreignRecoveryOwnerID,
    pid: 333,
    startedAt: 300,
    heartbeatAt: 300,
    controlEpoch: 0,
  })
})

const setup = Effect.gen(function* () {
  const { db, readDb } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "execution-recovery",
      directory: "/project",
      title: "execution recovery",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(RuntimeOwnerTable)
    .values([
      {
        id: oldOwnerID,
        pid: 111,
        started_at: 100,
        heartbeat_at: 1,
        control_epoch: 0,
      },
      {
        id: recoveryOwnerID,
        pid: 222,
        started_at: 200,
        heartbeat_at: 200,
        control_epoch: 0,
      },
      {
        id: foreignRecoveryOwnerID,
        pid: 333,
        started_at: 300,
        heartbeat_at: 300,
        control_epoch: 0,
      },
    ])
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionExecutionOwnerTable)
    .values({
      session_id: sessionID,
      generation: 7,
      owner_id: oldOwnerID,
      acquired_at: 100,
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  return { db, readDb, owner: yield* SessionExecutionOwner.Service }
})

const reconcileAtStartup = (db: Effect.Success<typeof setup>["db"], readDb: Effect.Success<typeof setup>["readDb"]) =>
  SessionExecutionOwner.reconcileDeadOwnersAtStartup(db, readDb, fakeRuntime)

const row = (db: Effect.Success<typeof setup>["db"]) =>
  db
    .select()
    .from(SessionExecutionOwnerTable)
    .where(eq(SessionExecutionOwnerTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)

describe("SessionExecutionOwner recovery", () => {
  it.effect("startup refuses to release a dead generation with an unsealed current assistant step", () =>
    Effect.gen(function* () {
      const state = yield* setup
      proof = "dead"
      yield* state.db.run(sql`INSERT INTO session_message
        (id, session_id, type, seq, time_created, time_updated, data)
        VALUES ('msg_startup_pending_current', ${sessionID}, 'assistant', 1, 150, 150, '{}')`)

      expect(yield* reconcileAtStartup(state.db, state.readDb)).toBe(0)
      expect(yield* row(state.db)).toMatchObject({ owner_id: oldOwnerID, generation: 7, acquired_at: 100 })
      expect([...(yield* state.owner.listWorking())]).toEqual([[sessionID, { type: "interrupted" }]])
    }),
  )

  it.effect("startup refuses to release a dead generation with an unsealed V1 assistant turn", () =>
    Effect.gen(function* () {
      const state = yield* setup
      proof = "dead"
      yield* state.db.run(sql`INSERT INTO message
        (id, session_id, time_created, time_updated, data)
        VALUES ('msg_startup_pending_v1', ${sessionID}, 150, 150, '{"role":"assistant"}')`)

      expect(yield* reconcileAtStartup(state.db, state.readDb)).toBe(0)
      expect(yield* row(state.db)).toMatchObject({ owner_id: oldOwnerID, generation: 7, acquired_at: 100 })
      expect([...(yield* state.owner.listWorking())]).toEqual([[sessionID, { type: "interrupted" }]])
    }),
  )

  it.effect("startup never assumes timestamps alone prove the generation was transcript-empty", () =>
    Effect.gen(function* () {
      const state = yield* setup
      proof = "dead"
      // A producer may commit an assistant before obtaining the execution
      // lease. Even created_at before acquired_at cannot prove safety.
      yield* state.db.run(sql`INSERT INTO message
        (id, session_id, time_created, time_updated, data)
        VALUES ('msg_admitted_before_owner', ${sessionID}, 50, 50, '{"role":"assistant"}')`)
      expect(yield* reconcileAtStartup(state.db, state.readDb)).toBe(0)
      expect(yield* row(state.db)).toMatchObject({ owner_id: oldOwnerID, generation: 7 })
    }),
  )

  it.effect("startup clears a transcript-empty stale proven-dead lease without changing generation", () =>
    Effect.gen(function* () {
      const state = yield* setup
      proof = "dead"

      expect(yield* reconcileAtStartup(state.db, state.readDb)).toBe(1)
      expect(yield* row(state.db)).toMatchObject({
        owner_id: null,
        acquired_at: null,
        generation: 7,
        recovery_owner_id: null,
      })
      expect(yield* state.db.select().from(RuntimeOwnerTable).where(eq(RuntimeOwnerTable.id, oldOwnerID)).get()).toBe(
        undefined,
      )
      const working = yield* state.owner.listWorking()
      expect([...working]).toEqual([])
    }),
  )

  it.effect("startup garbage collection treats recovery_owner_id as a strong runtime-owner reference", () =>
    Effect.gen(function* () {
      const state = yield* setup
      const now = Date.now()
      snapshots.set(oldOwnerID, { ...snapshots.get(oldOwnerID)!, heartbeatAt: now })
      yield* state.db
        .update(RuntimeOwnerTable)
        .set({ heartbeat_at: now })
        .where(eq(RuntimeOwnerTable.id, oldOwnerID))
        .run()
        .pipe(Effect.orDie)
      yield* state.db
        .update(SessionExecutionOwnerTable)
        .set({ recovery_owner_id: foreignRecoveryOwnerID, recovery_started_at: 150 })
        .where(eq(SessionExecutionOwnerTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
      recoveryProof = "dead"

      expect(yield* reconcileAtStartup(state.db, state.readDb)).toBe(0)
      expect(yield* row(state.db)).toMatchObject({
        owner_id: oldOwnerID,
        recovery_owner_id: foreignRecoveryOwnerID,
      })
      expect(
        yield* state.db.select().from(RuntimeOwnerTable).where(eq(RuntimeOwnerTable.id, foreignRecoveryOwnerID)).get(),
      ).toBeDefined()
      expect(deathProofCalls.get(foreignRecoveryOwnerID) ?? 0).toBe(0)
    }),
  )

  it.effect("startup preserves a stale-but-live execution lease", () =>
    Effect.gen(function* () {
      const state = yield* setup
      proof = "alive-or-unknown"

      expect(yield* reconcileAtStartup(state.db, state.readDb)).toBe(0)
      expect(yield* row(state.db)).toMatchObject({ owner_id: oldOwnerID, generation: 7 })
      const working = yield* state.owner.listWorking()
      // Process-not-proven-dead is not proof of executing Session. Preserve
      // its generation fence but never project placebo busy to the UI.
      expect([...working]).toEqual([[sessionID, { type: "interrupted" }]])
    }),
  )

  it.effect("projects a proven-dead retained lease as interrupted rather than busy", () =>
    Effect.gen(function* () {
      const state = yield* setup
      proof = "dead"

      // This models a lease discovered after startup reconciliation, including
      // the effect-unknown case where the durable generation must remain fenced.
      const working = yield* state.owner.listWorking()
      expect([...working]).toEqual([[sessionID, { type: "interrupted" }]])
      const addressed = yield* state.owner.listWorkingForSessionIDs([sessionID])
      expect([...addressed]).toEqual([[sessionID, { type: "interrupted" }]])
      const empty = yield* state.owner.listWorkingForSessionIDs([])
      expect([...empty]).toEqual([])
      const byDirectory = yield* state.owner.listWorkingByDirectory("/project")
      expect([...byDirectory]).toEqual([[sessionID, { type: "interrupted" }]])
      expect(yield* row(state.db)).toMatchObject({ owner_id: oldOwnerID, generation: 7 })
    }),
  )

  it.effect("does not report a same-process lease as busy after its local activation vanished", () =>
    Effect.gen(function* () {
      const state = yield* setup
      proof = "alive-or-unknown"
      yield* state.db
        .update(SessionExecutionOwnerTable)
        .set({ owner_id: recoveryOwnerID })
        .where(eq(SessionExecutionOwnerTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)

      const working = yield* state.owner.listWorking()
      expect([...working]).toEqual([[sessionID, { type: "interrupted" }]])
    }),
  )

  it.effect("uses exact process-shared activation for a same-PID foreign module owner", () =>
    Effect.gen(function* () {
      const state = yield* setup
      const startedAt = Math.trunc(Date.now() - process.uptime() * 1_000)
      const owner = {
        id: oldOwnerID,
        pid: process.pid,
        startedAt,
        heartbeatAt: Date.now(),
        controlEpoch: 0,
      }
      snapshots.set(oldOwnerID, owner)
      yield* state.db
        .update(RuntimeOwnerTable)
        .set({ pid: owner.pid, started_at: owner.startedAt, heartbeat_at: owner.heartbeatAt })
        .where(eq(RuntimeOwnerTable.id, oldOwnerID))
        .run()
        .pipe(Effect.orDie)

      const registry = activationRegistry()
      if (!registry) return yield* Effect.die("expected process activation registry")
      registry.activations.set(sessionID, { sessionID, ownerID: oldOwnerID, generation: 7 })
      expect([...(yield* state.owner.listWorking())]).toEqual([[sessionID, { type: "busy" }]])
      expect(yield* state.owner.tryClaimRecovery(sessionID, { verifyDeathNow: true })).toMatchObject({
        state: "blocked",
        proof: "alive-or-unknown",
      })

      registry.activations.delete(sessionID)
      expect([...(yield* state.owner.listWorking())]).toEqual([[sessionID, { type: "interrupted" }]])
      expect(yield* state.owner.tryClaimRecovery(sessionID, { verifyDeathNow: true })).toMatchObject({
        state: "claimed",
        token: { ownerID: oldOwnerID, generation: 7 },
      })
    }),
  )

  it.effect("lets explicit recovery claim a same-process orphan after its activation vanished", () =>
    Effect.gen(function* () {
      const state = yield* setup
      yield* state.db
        .update(SessionExecutionOwnerTable)
        .set({ owner_id: recoveryOwnerID })
        .where(eq(SessionExecutionOwnerTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)

      const claim = yield* state.owner.tryClaimRecovery(sessionID, { verifyDeathNow: true })
      expect(claim.state).toBe("claimed")
      if (claim.state !== "claimed") return
      expect(claim.token).toMatchObject({ sessionID, ownerID: recoveryOwnerID, generation: 7 })
      expect(yield* state.owner.completeRecovery(claim.token)).toBe("released")
      expect(yield* row(state.db)).toMatchObject({ owner_id: null, generation: 7 })
    }),
  )

  it.effect("does not let explicit recovery claim a same-process generation with a live activation", () =>
    Effect.gen(function* () {
      const state = yield* setup
      yield* state.db
        .update(SessionExecutionOwnerTable)
        .set({ owner_id: null })
        .where(eq(SessionExecutionOwnerTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
      const acquired = yield* state.owner.tryAcquireLocal(sessionID)
      expect(acquired.state).toBe("acquired")
      if (acquired.state !== "acquired") return

      expect(yield* state.owner.tryClaimRecovery(sessionID, { verifyDeathNow: true })).toMatchObject({
        state: "blocked",
        proof: "alive-or-unknown",
      })
      yield* state.owner.release(acquired.token)
    }),
  )

  it.effect("startup preserves a fresh lease even when death probing reports dead", () =>
    Effect.gen(function* () {
      const state = yield* setup
      proof = "dead"
      snapshots.set(oldOwnerID, { ...snapshots.get(oldOwnerID)!, heartbeatAt: Date.now() })

      expect(yield* reconcileAtStartup(state.db, state.readDb)).toBe(0)
      expect(yield* row(state.db)).toMatchObject({ owner_id: oldOwnerID, generation: 7 })
    }),
  )

  it.effect("startup preserves stale leases with non-local or otherwise uncertain identity", () =>
    Effect.gen(function* () {
      const state = yield* setup
      proof = "not-local-or-unknown"

      expect(yield* reconcileAtStartup(state.db, state.readDb)).toBe(0)
      expect(yield* row(state.db)).toMatchObject({ owner_id: oldOwnerID, generation: 7 })
    }),
  )

  it.effect("a stale heartbeat with a PID that is still present (including PID reuse) is never stolen", () =>
    Effect.gen(function* () {
      const state = yield* setup
      // process.kill(pid, 0) can only establish that some process occupies the
      // number; it cannot prove that it is the original owner. Treat that as
      // alive/unknown even when the durable heartbeat is stale.
      proof = "alive-or-unknown"

      expect(yield* state.owner.tryClaimRecovery(sessionID)).toMatchObject({
        state: "blocked",
        proof: "alive-or-unknown",
      })
      expect(yield* row(state.db)).toMatchObject({ owner_id: oldOwnerID, recovery_owner_id: null })
    }),
  )

  it.effect("a fresh heartbeat is not reclaimed even if a death probe reports dead", () =>
    Effect.gen(function* () {
      const state = yield* setup
      proof = "dead"
      snapshots.set(oldOwnerID, { ...snapshots.get(oldOwnerID)!, heartbeatAt: Date.now() })

      expect(yield* state.owner.tryClaimRecovery(sessionID)).toMatchObject({ state: "blocked" })
      expect(yield* row(state.db)).toMatchObject({ owner_id: oldOwnerID, recovery_owner_id: null })
    }),
  )

  it.effect("startup requires stale-and-dead proof for a recovery owner too", () =>
    Effect.gen(function* () {
      const state = yield* setup
      yield* state.db
        .update(SessionExecutionOwnerTable)
        .set({ recovery_owner_id: foreignRecoveryOwnerID, recovery_started_at: 150 })
        .where(eq(SessionExecutionOwnerTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
      proof = "dead"
      recoveryProof = "alive-or-unknown"

      expect(yield* reconcileAtStartup(state.db, state.readDb)).toBe(0)
      expect(yield* row(state.db)).toMatchObject({
        owner_id: oldOwnerID,
        generation: 7,
        recovery_owner_id: foreignRecoveryOwnerID,
      })
    }),
  )

  it.effect("startup clears a lease only after both execution and recovery owners are proven dead", () =>
    Effect.gen(function* () {
      const state = yield* setup
      yield* state.db
        .update(SessionExecutionOwnerTable)
        .set({ recovery_owner_id: foreignRecoveryOwnerID, recovery_started_at: 150 })
        .where(eq(SessionExecutionOwnerTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
      proof = "dead"
      recoveryProof = "dead"

      expect(yield* reconcileAtStartup(state.db, state.readDb)).toBe(1)
      expect(yield* row(state.db)).toMatchObject({
        owner_id: null,
        generation: 7,
        recovery_owner_id: null,
        recovery_started_at: null,
      })
      const working = yield* state.owner.listWorking()
      expect([...working]).toEqual([])
    }),
  )

  it.effect("startup keyset pagination reclaims every lease beyond the first 128-row page", () =>
    Effect.gen(function* () {
      const state = yield* setup
      const batch = Array.from({ length: 257 }, (_, index) =>
        SessionSchema.ID.make(`ses_startup_batch_${String(index).padStart(3, "0")}`),
      )
      const garbageOwners = Array.from(
        { length: 257 },
        (_, index) => `runtime-owner:startup-gc-${String(index).padStart(3, "0")}` as RuntimeOwner.ID,
      )
      for (const id of garbageOwners) {
        snapshots.set(id, { id, pid: 900, startedAt: 1, heartbeatAt: 1, controlEpoch: 0 })
      }
      yield* state.db
        .insert(SessionTable)
        .values(
          batch.map((id, index) => ({
            id,
            project_id: Project.ID.global,
            slug: `startup-batch-${index}`,
            directory: "/project",
            title: `startup batch ${index}`,
            version: "test",
          })),
        )
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* state.db
        .insert(RuntimeOwnerTable)
        .values(
          garbageOwners.map((id) => ({
            id,
            pid: 900,
            started_at: 1,
            heartbeat_at: 1,
            control_epoch: 0,
          })),
        )
        .run()
        .pipe(Effect.orDie)
      yield* state.db
        .insert(SessionExecutionOwnerTable)
        .values(batch.map((id) => ({ session_id: id, generation: 4, owner_id: oldOwnerID, acquired_at: 100 })))
        .run()
        .pipe(Effect.orDie)
      proof = "dead"

      expect(yield* reconcileAtStartup(state.db, state.readDb)).toBe(batch.length + 1)
      const working = yield* state.owner.listWorking()
      expect([...working]).toEqual([])
      const remainingOwners = yield* state.db.select({ id: RuntimeOwnerTable.id }).from(RuntimeOwnerTable).all()
      expect(remainingOwners.some((owner) => garbageOwners.includes(owner.id as RuntimeOwner.ID))).toBe(false)
      expect(yield* state.db.select().from(RuntimeOwnerTable).where(eq(RuntimeOwnerTable.id, oldOwnerID)).get()).toBe(
        undefined,
      )
    }),
  )

  it.effect("heartbeat staleness alone cannot claim recovery", () =>
    Effect.gen(function* () {
      const state = yield* setup
      proof = "alive-or-unknown"

      expect(yield* state.owner.tryClaimRecovery(sessionID)).toMatchObject({
        state: "blocked",
        proof: "alive-or-unknown",
        snapshot: {
          sessionID,
          generation: 7,
          ownerID: oldOwnerID,
          runtime: { heartbeatAt: 1 },
        },
      })
      expect(yield* row(state.db)).toMatchObject({
        owner_id: oldOwnerID,
        generation: 7,
        recovery_owner_id: null,
      })
      expect(retains).toBe(1)
      expect(releases).toBe(1)
    }),
  )

  it.effect("unknown/non-local owners remain blocked and unmodified", () =>
    Effect.gen(function* () {
      const state = yield* setup
      proof = "not-local-or-unknown"

      expect(yield* state.owner.tryClaimRecovery(sessionID)).toMatchObject({
        state: "blocked",
        proof: "not-local-or-unknown",
      })
      expect(yield* row(state.db)).toMatchObject({
        owner_id: oldOwnerID,
        generation: 7,
        recovery_owner_id: null,
      })
    }),
  )

  it.effect("proven death CAS-claims recovery without clearing execution authority", () =>
    Effect.gen(function* () {
      const state = yield* setup
      proof = "dead"

      const claimed = yield* state.owner.tryClaimRecovery(sessionID)
      expect(claimed).toMatchObject({
        state: "claimed",
        token: {
          sessionID,
          ownerID: oldOwnerID,
          generation: 7,
          recoveryOwnerID,
        },
        snapshot: {
          sessionID,
          generation: 7,
          ownerID: oldOwnerID,
          recoveryOwnerID,
        },
      })
      expect(yield* row(state.db)).toMatchObject({
        owner_id: oldOwnerID,
        generation: 7,
        recovery_owner_id: recoveryOwnerID,
      })

      expect(yield* state.owner.tryAcquire(sessionID)).toMatchObject({
        state: "busy",
        snapshot: {
          generation: 7,
          ownerID: oldOwnerID,
          recoveryOwnerID,
        },
      })

      expect(yield* state.owner.tryClaimRecovery(sessionID)).toMatchObject({
        state: "claimed",
        token: claimed.state === "claimed" ? claimed.token : {},
      })
      expect(retains - releases).toBe(1)
    }),
  )

  it.effect("a foreign recovery claim cannot be stolen even with proven owner death", () =>
    Effect.gen(function* () {
      const state = yield* setup
      proof = "dead"
      yield* state.db
        .update(SessionExecutionOwnerTable)
        .set({ recovery_owner_id: foreignRecoveryOwnerID, recovery_started_at: 150 })
        .where(eq(SessionExecutionOwnerTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)

      expect(yield* state.owner.tryClaimRecovery(sessionID)).toMatchObject({
        state: "busy",
        snapshot: {
          ownerID: oldOwnerID,
          generation: 7,
          recoveryOwnerID: foreignRecoveryOwnerID,
        },
      })
      expect(yield* row(state.db)).toMatchObject({
        owner_id: oldOwnerID,
        generation: 7,
        recovery_owner_id: foreignRecoveryOwnerID,
      })
    }),
  )

  it.effect("a proven-dead recovery owner can be replaced without clearing execution authority", () =>
    Effect.gen(function* () {
      const state = yield* setup
      proof = "dead"
      recoveryProof = "dead"
      yield* state.db
        .update(SessionExecutionOwnerTable)
        .set({ recovery_owner_id: foreignRecoveryOwnerID, recovery_started_at: 150 })
        .where(eq(SessionExecutionOwnerTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)

      const claimed = yield* state.owner.tryClaimRecovery(sessionID)
      expect(claimed).toMatchObject({
        state: "claimed",
        token: {
          sessionID,
          ownerID: oldOwnerID,
          generation: 7,
          recoveryOwnerID,
        },
        snapshot: {
          ownerID: oldOwnerID,
          generation: 7,
          recoveryOwnerID,
        },
      })
      expect(yield* row(state.db)).toMatchObject({
        owner_id: oldOwnerID,
        generation: 7,
        recovery_owner_id: recoveryOwnerID,
      })
    }),
  )

  it.effect("abandon clears only the exact recovery claim and never the old owner", () =>
    Effect.gen(function* () {
      const state = yield* setup
      proof = "dead"
      const claimed = yield* state.owner.tryClaimRecovery(sessionID)
      if (claimed.state !== "claimed") return yield* Effect.die("expected recovery claim")

      expect(yield* state.owner.abandonRecovery(claimed.token)).toBe("released")
      expect(yield* row(state.db)).toMatchObject({
        owner_id: oldOwnerID,
        generation: 7,
        recovery_owner_id: null,
        recovery_started_at: null,
      })
      expect(retains).toBe(releases)
    }),
  )

  it.effect("stale recovery tokens cannot clear a newer recovery claim", () =>
    Effect.gen(function* () {
      const state = yield* setup
      proof = "dead"
      const claimed = yield* state.owner.tryClaimRecovery(sessionID)
      if (claimed.state !== "claimed") return yield* Effect.die("expected recovery claim")

      yield* state.db
        .update(SessionExecutionOwnerTable)
        .set({ recovery_owner_id: foreignRecoveryOwnerID, recovery_started_at: 999 })
        .where(eq(SessionExecutionOwnerTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)

      expect(yield* state.owner.abandonRecovery(claimed.token)).toBe("stale")
      expect(yield* row(state.db)).toMatchObject({
        owner_id: oldOwnerID,
        generation: 7,
        recovery_owner_id: foreignRecoveryOwnerID,
        recovery_started_at: 999,
      })
    }),
  )
})
