import { beforeEach, describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
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

const snapshots = new Map<RuntimeOwner.ID, RuntimeOwner.Snapshot>()

const fakeRuntimeLayer = Layer.succeed(
  RuntimeOwner.Service,
  RuntimeOwner.Service.of({
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
      Effect.succeed(id === foreignRecoveryOwnerID ? recoveryProof : proof),
  }),
)

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
  snapshots.clear()
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
  const { db } = yield* Database.Service
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
  return { db, owner: yield* SessionExecutionOwner.Service }
})

const row = (db: Effect.Success<typeof setup>["db"]) =>
  db
    .select()
    .from(SessionExecutionOwnerTable)
    .where(eq(SessionExecutionOwnerTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)

describe("SessionExecutionOwner recovery", () => {
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
