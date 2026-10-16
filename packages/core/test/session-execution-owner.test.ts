import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { RuntimeOwner } from "@opencode-ai/core/runtime-owner"
import { RuntimeOwnerTable } from "@opencode-ai/core/runtime-owner.sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import { SessionExecutionOwnerTable } from "@opencode-ai/core/session/execution-owner.sql"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionInputTable, SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const layer = AppNodeBuilder.build(
  LayerNode.group([Database.node, RuntimeOwner.node, SessionExecutionOwner.node]),
)
const it = testEffect(layer)
const sessionID = SessionSchema.ID.make("ses_execution_owner_test")

const recoveryRuntimeID = "runtime-owner:recovery-current" as RuntimeOwner.ID
const deadExecutionOwnerID = "runtime-owner:execution-dead" as RuntimeOwner.ID
const liveExecutionOwnerID = "runtime-owner:execution-live" as RuntimeOwner.ID
const deadRecoveryOwnerID = "runtime-owner:recovery-dead" as RuntimeOwner.ID
const liveRecoveryOwnerID = "runtime-owner:recovery-live" as RuntimeOwner.ID

const fakeRuntimeLayer = Layer.succeed(
  RuntimeOwner.Service,
  RuntimeOwner.Service.of({
    id: recoveryRuntimeID,
    pid: 999_001,
    startedAt: 1,
    retain: Effect.succeed({ release: Effect.void }),
    snapshot: (id) =>
      Effect.succeed({
        id,
        pid:
          id === deadExecutionOwnerID || id === deadRecoveryOwnerID
            ? 999_101
            : id === liveExecutionOwnerID || id === liveRecoveryOwnerID
              ? 999_102
              : 999_001,
        startedAt: 1,
        heartbeatAt: 1,
        controlEpoch: 0,
      }),
    proveLocalDeath: (id) =>
      Effect.succeed(
        id === deadExecutionOwnerID || id === deadRecoveryOwnerID
          ? ("dead" as const)
          : id === liveExecutionOwnerID || id === liveRecoveryOwnerID || id === recoveryRuntimeID
            ? ("alive-or-unknown" as const)
            : ("not-local-or-unknown" as const),
      ),
  }),
)

const recoveryIt = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, RuntimeOwner.node, SessionExecutionOwner.node]),
    [[RuntimeOwner.node, fakeRuntimeLayer]],
  ),
)

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
      slug: "execution-owner",
      directory: "/project",
      title: "execution owner",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

const addPendingInput = (id: string, admittedSeq: number) =>
  Database.Service.use(({ db }) =>
    db
      .insert(SessionInputTable)
      .values({
        id: SessionMessage.ID.make(id),
        session_id: sessionID,
        prompt: Prompt.make({ text: "pending" }),
        delivery: "queue",
        admitted_seq: admittedSeq,
      })
      .run()
      .pipe(Effect.orDie),
  )

const setupRecovery = (
  ownerID: RuntimeOwner.ID,
  recoveryOwnerID?: RuntimeOwner.ID,
) =>
  Effect.gen(function* () {
    yield* setup
    const { db } = yield* Database.Service
    const runtimeIDs = [
      recoveryRuntimeID,
      deadExecutionOwnerID,
      liveExecutionOwnerID,
      deadRecoveryOwnerID,
      liveRecoveryOwnerID,
    ]
    yield* db
      .insert(RuntimeOwnerTable)
      .values(
        runtimeIDs.map((id, index) => ({
          id,
          pid: 999_000 + index,
          started_at: 1,
          heartbeat_at: 1,
          control_epoch: 0,
        })),
      )
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionExecutionOwnerTable)
      .values({
        session_id: sessionID,
        generation: 7,
        owner_id: ownerID,
        acquired_at: 10,
        recovery_owner_id: recoveryOwnerID ?? null,
        recovery_started_at: recoveryOwnerID ? 11 : null,
      })
      .onConflictDoUpdate({
        target: SessionExecutionOwnerTable.session_id,
        set: {
          generation: 7,
          owner_id: ownerID,
          acquired_at: 10,
          interrupt_generation: null,
          interrupt_reason: null,
          interrupt_requested_at: null,
          recovery_owner_id: recoveryOwnerID ?? null,
          recovery_started_at: recoveryOwnerID ? 11 : null,
        },
      })
      .run()
      .pipe(Effect.orDie)
  })

describe("SessionExecutionOwner", () => {
  it.effect("returns exact batched owner and heartbeat snapshots without loading any Session instance", () =>
    Effect.gen(function* () {
      yield* setup
      const owner = yield* SessionExecutionOwner.Service
      const acquired = yield* owner.tryAcquireLocal(sessionID)
      if (acquired.state !== "acquired") return yield* Effect.die("owner acquisition expected")
      const other = SessionSchema.ID.make("ses_execution_owner_missing")
      const result = yield* owner.snapshotMany([sessionID, other, sessionID])
      expect(result.size).toBe(2)
      expect(result.get(sessionID)).toEqual(yield* owner.snapshot(sessionID))
      expect(result.get(other)).toEqual({ sessionID: other, generation: 0 })
      expect(result.get(sessionID)?.runtime?.pid).toBe(process.pid)
      expect(yield* owner.snapshotMany([])).toEqual(new Map())
      expect(yield* owner.release(acquired.token)).toBe("released")
      expect((yield* owner.snapshotMany([sessionID])).get(sessionID)).toEqual(yield* owner.snapshot(sessionID))
    }),
  )
  it.effect("pages hundreds of addressed Sessions without fabricated owners or missing IDs", () =>
    Effect.gen(function* () {
      yield* setup
      const owner = yield* SessionExecutionOwner.Service
      const ids = Array.from({ length: 805 }, (_, index) => SessionSchema.ID.make(`ses_owner_page_${index}`))
      const projected = yield* owner.snapshotMany([sessionID, ...ids, ids[0]!])
      expect(projected.size).toBe(806)
      expect(projected.get(sessionID)).toEqual(yield* owner.snapshot(sessionID))
      expect(projected.get(ids[0]!)).toEqual({ sessionID: ids[0]!, generation: 0 })
      expect(projected.get(ids.at(-1)!)).toEqual({ sessionID: ids.at(-1)!, generation: 0 })
    }),
  )

  it.effect("lists globally working sessions from durable ownership without location services", () =>
    Effect.gen(function* () {
      yield* setup
      const owner = yield* SessionExecutionOwner.Service

      let working = yield* owner.listWorking()
      expect([...working]).toEqual([])
      const acquired = yield* owner.tryAcquireLocal(sessionID)
      if (acquired.state !== "acquired") return yield* Effect.die("expected acquisition")
      working = yield* owner.listWorking()
      expect([...working]).toEqual([[sessionID, { type: "busy" }]])

      expect(yield* owner.release(acquired.token)).toBe("released")
      working = yield* owner.listWorking()
      expect([...working]).toEqual([])
    }),
  )

  it.effect("uses one process incarnation across multiple strong retains", () =>
    Effect.gen(function* () {
      const runtime = yield* RuntimeOwner.Service
      const { db } = yield* Database.Service
      const first = yield* runtime.retain
      const second = yield* runtime.retain

      expect(yield* db.select().from(RuntimeOwnerTable).all().pipe(Effect.orDie)).toHaveLength(1)
      expect(yield* runtime.snapshot(runtime.id)).toMatchObject({
        id: runtime.id,
        pid: process.pid,
        controlEpoch: 0,
      })

      yield* first.release
      expect(yield* runtime.snapshot(runtime.id)).toBeDefined()
      yield* second.release
      expect(yield* runtime.snapshot(runtime.id)).toBeDefined()
    }),
  )

  it.effect("acquires exactly one owner and advances generation only after release", () =>
    Effect.gen(function* () {
      yield* setup
      const owner = yield* SessionExecutionOwner.Service

      const first = yield* owner.tryAcquire(sessionID)
      expect(first.state).toBe("acquired")
      if (first.state !== "acquired") return
      expect(first.token.generation).toBe(1)

      const busy = yield* owner.tryAcquire(sessionID)
      expect(busy).toMatchObject({
        state: "busy",
        snapshot: { sessionID, generation: 1, ownerID: first.token.ownerID },
      })

      expect(yield* owner.releaseIfDrained(first.token)).toBe("released")
      const second = yield* owner.tryAcquire(sessionID)
      expect(second.state).toBe("acquired")
      if (second.state !== "acquired") return
      expect(second.token.generation).toBe(2)
      expect(yield* owner.releaseIfDrained(second.token)).toBe("released")
    }),
  )

  it.effect("does not steal a raw same-process owner whose activation vanished before tool hazard inspection", () =>
    Effect.gen(function* () {
      yield* setup
      const owner = yield* SessionExecutionOwner.Service
      const first = yield* owner.tryAcquire(sessionID)
      if (first.state !== "acquired") return yield* Effect.die("expected first acquisition")
      const processState = (globalThis as typeof globalThis & { [key: symbol]: unknown })[
        Symbol.for("openfork.session-execution-owner.activations.v1")
      ] as { activations: Map<string, unknown> } | undefined
      if (!processState) return yield* Effect.die("missing process activation registry")
      // Simulate an executor crash after durable acquisition. This does not
      // make external side effects safe to replay.
      processState.activations.delete(sessionID)
      expect([...(yield* owner.listWorking())]).toEqual([[sessionID, { type: "interrupted" }]])
      const attempted = yield* owner.tryAcquireLocal(sessionID)
      expect(attempted.state).toBe("busy")
      expect(yield* owner.snapshot(sessionID)).toMatchObject({
        ownerID: first.token.ownerID,
        generation: first.token.generation,
      })
      expect(yield* owner.release(first.token)).toBe("released")
    }),
  )

  it.effect("never lets a stale generation release a newer owner", () =>
    Effect.gen(function* () {
      yield* setup
      const owner = yield* SessionExecutionOwner.Service
      const first = yield* owner.tryAcquire(sessionID)
      if (first.state !== "acquired") return yield* Effect.die("expected first acquisition")
      expect(yield* owner.releaseIfDrained(first.token)).toBe("released")

      const second = yield* owner.tryAcquire(sessionID)
      if (second.state !== "acquired") return yield* Effect.die("expected second acquisition")
      expect(second.token.generation).toBe(first.token.generation + 1)

      expect(yield* owner.releaseIfDrained(first.token)).toBe("stale")
      expect(yield* owner.snapshot(sessionID)).toMatchObject({
        generation: second.token.generation,
        ownerID: second.token.ownerID,
      })
      expect(yield* owner.releaseIfDrained(second.token)).toBe("released")
    }),
  )

  it.effect("keeps ownership when input commits before release", () =>
    Effect.gen(function* () {
      yield* setup
      const owner = yield* SessionExecutionOwner.Service
      const acquired = yield* owner.tryAcquire(sessionID)
      if (acquired.state !== "acquired") return yield* Effect.die("expected acquisition")

      yield* addPendingInput("msg_admit_before_release", 1)
      expect(yield* owner.releaseIfDrained(acquired.token)).toBe("continue")
      expect(yield* owner.snapshot(sessionID)).toMatchObject({
        generation: acquired.token.generation,
        ownerID: acquired.token.ownerID,
      })

      yield* Database.Service.use(({ db }) =>
        db.delete(SessionInputTable).where(eq(SessionInputTable.session_id, sessionID)).run().pipe(Effect.orDie),
      )
      expect(yield* owner.releaseIfDrained(acquired.token)).toBe("released")
    }),
  )

  it.effect("allows the next generation when release commits before new input", () =>
    Effect.gen(function* () {
      yield* setup
      const owner = yield* SessionExecutionOwner.Service
      const first = yield* owner.tryAcquire(sessionID)
      if (first.state !== "acquired") return yield* Effect.die("expected acquisition")

      expect(yield* owner.releaseIfDrained(first.token)).toBe("released")
      yield* addPendingInput("msg_release_before_admit", 1)

      const second = yield* owner.tryAcquire(sessionID)
      expect(second.state).toBe("acquired")
      if (second.state !== "acquired") return
      expect(second.token.generation).toBe(first.token.generation + 1)
    }),
  )

  it.effect("exact release clears quiesced ownership without consuming pending durable input", () =>
    Effect.gen(function* () {
      yield* setup
      const owner = yield* SessionExecutionOwner.Service
      const { db } = yield* Database.Service
      const acquired = yield* owner.tryAcquire(sessionID)
      if (acquired.state !== "acquired") return yield* Effect.die("expected acquisition")
      yield* addPendingInput("msg_exact_release_pending", 1)

      expect(yield* owner.release(acquired.token)).toBe("released")
      expect(yield* owner.snapshot(sessionID)).not.toHaveProperty("ownerID")
      expect(
        yield* db
          .select({ id: SessionInputTable.id })
          .from(SessionInputTable)
          .where(eq(SessionInputTable.session_id, sessionID))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(1)

      const next = yield* owner.tryAcquire(sessionID)
      expect(next.state).toBe("acquired")
      if (next.state === "acquired") {
        expect(next.token.generation).toBe(acquired.token.generation + 1)
        expect(yield* owner.release(next.token)).toBe("released")
      }
    }),
  )

  it.effect("treats heartbeat staleness as suspect and never as free ownership", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const owner = yield* SessionExecutionOwner.Service
      const acquired = yield* owner.tryAcquire(sessionID)
      if (acquired.state !== "acquired") return yield* Effect.die("expected acquisition")

      yield* db
        .update(RuntimeOwnerTable)
        .set({ heartbeat_at: 1 })
        .where(eq(RuntimeOwnerTable.id, acquired.token.ownerID))
        .run()
        .pipe(Effect.orDie)

      expect(yield* owner.tryAcquire(sessionID)).toMatchObject({
        state: "busy",
        snapshot: {
          generation: acquired.token.generation,
          ownerID: acquired.token.ownerID,
          runtime: { heartbeatAt: 1 },
        },
      })
      expect(yield* owner.releaseIfDrained(acquired.token)).toBe("released")
    }),
  )

  it.effect("generation-fences interrupt requests without transferring ownership", () =>
    Effect.gen(function* () {
      yield* setup
      const runtime = yield* RuntimeOwner.Service
      const owner = yield* SessionExecutionOwner.Service
      const acquired = yield* owner.tryAcquire(sessionID)
      if (acquired.state !== "acquired") return yield* Effect.die("expected acquisition")
      const before = yield* runtime.snapshot(runtime.id)

      expect(yield* owner.requestInterrupt(sessionID, "operator", acquired.token.generation - 1)).toMatchObject({
        state: "stale",
        snapshot: { generation: acquired.token.generation, ownerID: acquired.token.ownerID },
      })
      expect((yield* runtime.snapshot(runtime.id))?.controlEpoch).toBe(before?.controlEpoch)

      expect(yield* owner.requestInterrupt(sessionID, "handoff")).toMatchObject({
        state: "requested",
        token: acquired.token,
        interruptGeneration: 1,
      })
      expect(yield* owner.requestInterrupt(sessionID, "operator")).toMatchObject({
        state: "requested",
        token: acquired.token,
        interruptGeneration: 2,
      })
      expect(yield* owner.snapshot(sessionID)).toMatchObject({
        generation: acquired.token.generation,
        ownerID: acquired.token.ownerID,
        interruptGeneration: 2,
        interruptReason: "operator",
      })
      expect((yield* runtime.snapshot(runtime.id))?.controlEpoch).toBe((before?.controlEpoch ?? 0) + 2)

      expect(yield* owner.releaseIfDrained(acquired.token)).toBe("released")
      expect(yield* owner.snapshot(sessionID)).not.toHaveProperty("interruptGeneration")
    }),
  )

  it.effect("does not claim a local death proof for a live or unknown owner", () =>
    Effect.gen(function* () {
      const runtime = yield* RuntimeOwner.Service
      const retention = yield* runtime.retain
      expect(yield* runtime.proveLocalDeath(runtime.id)).toBe("alive-or-unknown")
      expect(yield* runtime.proveLocalDeath(("runtime-owner:missing" as RuntimeOwner.ID))).toBe(
        "not-local-or-unknown",
      )
      yield* retention.release
    }),
  )

  it.effect("shares exact activation for raw and local acquisition without stealing a live generation", () =>
    Effect.gen(function* () {
      yield* setup
      const owner = yield* SessionExecutionOwner.Service

      const first = yield* owner.tryAcquireLocal(sessionID)
      expect(first.state).toBe("acquired")
      if (first.state !== "acquired") return
      expect(yield* owner.localActivation(sessionID)).toEqual(first.token)

      const joined = yield* owner.tryAcquireLocal(sessionID)
      expect(joined).toMatchObject({
        state: "busy",
        snapshot: { generation: first.token.generation, ownerID: first.token.ownerID },
      })

      expect(yield* owner.release(first.token)).toBe("released")
      expect(yield* owner.localActivation(sessionID)).toBeUndefined()

      const raw = yield* owner.tryAcquire(sessionID)
      if (raw.state !== "acquired") return yield* Effect.die("expected raw acquisition")
      expect(yield* owner.localActivation(sessionID)).toEqual(raw.token)
      // Raw acquisition is a legitimate executor generation, NOT an orphan.
      // The old local path released this live owner and re-admitted work.
      expect(yield* owner.tryAcquireLocal(sessionID)).toMatchObject({
        state: "busy",
        snapshot: { generation: raw.token.generation, ownerID: raw.token.ownerID },
      })
      expect(yield* owner.tryClaimRecovery(sessionID)).toMatchObject({
        state: "blocked",
        snapshot: { generation: raw.token.generation, ownerID: raw.token.ownerID },
      })
      expect(yield* owner.snapshot(sessionID)).toMatchObject({
        generation: raw.token.generation,
        ownerID: raw.token.ownerID,
      })
      expect(yield* owner.release(raw.token)).toBe("released")
      expect(yield* owner.localActivation(sessionID)).toBeUndefined()

      const next = yield* owner.tryAcquireLocal(sessionID)
      expect(next.state).toBe("acquired")
      if (next.state === "acquired") {
        expect(next.token.generation).toBe(raw.token.generation + 1)
        expect(yield* owner.release(next.token)).toBe("released")
      }
    }),
  )
})

describe("SessionExecutionOwner recovery fencing", () => {
  recoveryIt.effect("claims recovery only after proving the exact execution owner dead and keeps execution fenced", () =>
    Effect.gen(function* () {
      yield* setupRecovery(deadExecutionOwnerID)
      const owner = yield* SessionExecutionOwner.Service

      const claimed = yield* owner.tryClaimRecovery(sessionID)
      expect(claimed.state).toBe("claimed")
      if (claimed.state !== "claimed") return
      expect(claimed.token).toEqual({
        sessionID,
        ownerID: deadExecutionOwnerID,
        generation: 7,
        recoveryOwnerID: recoveryRuntimeID,
      })
      expect(claimed.snapshot).toMatchObject({
        ownerID: deadExecutionOwnerID,
        generation: 7,
        recoveryOwnerID: recoveryRuntimeID,
      })
      expect(yield* owner.tryAcquire(sessionID)).toMatchObject({
        state: "busy",
        snapshot: {
          ownerID: deadExecutionOwnerID,
          generation: 7,
          recoveryOwnerID: recoveryRuntimeID,
        },
      })

      const repeated = yield* owner.tryClaimRecovery(sessionID)
      expect(repeated).toMatchObject({ state: "claimed", token: claimed.token })
      expect(yield* owner.abandonRecovery(claimed.token)).toBe("released")
      expect(yield* owner.snapshot(sessionID)).toMatchObject({
        ownerID: deadExecutionOwnerID,
        generation: 7,
      })
      expect(yield* owner.snapshot(sessionID)).not.toHaveProperty("recoveryOwnerID")
    }),
  )

  recoveryIt.effect("refuses recovery for a live or unproven execution owner", () =>
    Effect.gen(function* () {
      yield* setupRecovery(liveExecutionOwnerID)
      const owner = yield* SessionExecutionOwner.Service

      expect(yield* owner.tryClaimRecovery(sessionID)).toMatchObject({
        state: "blocked",
        proof: "alive-or-unknown",
        snapshot: {
          ownerID: liveExecutionOwnerID,
          generation: 7,
        },
      })
      expect(yield* owner.snapshot(sessionID)).not.toHaveProperty("recoveryOwnerID")
    }),
  )

  recoveryIt.effect("does not overlap a live recovery owner", () =>
    Effect.gen(function* () {
      yield* setupRecovery(deadExecutionOwnerID, liveRecoveryOwnerID)
      const owner = yield* SessionExecutionOwner.Service

      expect(yield* owner.tryClaimRecovery(sessionID)).toMatchObject({
        state: "busy",
        snapshot: {
          ownerID: deadExecutionOwnerID,
          generation: 7,
          recoveryOwnerID: liveRecoveryOwnerID,
        },
      })
      expect(yield* owner.snapshot(sessionID)).toMatchObject({
        recoveryOwnerID: liveRecoveryOwnerID,
      })
    }),
  )

  recoveryIt.effect("ordinary release cannot erase an active recovery claim", () =>
    Effect.gen(function* () {
      yield* setupRecovery(deadExecutionOwnerID)
      const owner = yield* SessionExecutionOwner.Service

      const claimed = yield* owner.tryClaimRecovery(sessionID)
      if (claimed.state !== "claimed") return yield* Effect.die("expected recovery claim")
      const executionToken: SessionExecutionOwner.Token = {
        sessionID,
        ownerID: deadExecutionOwnerID,
        generation: 7,
      }

      expect(yield* owner.releaseIfDrained(executionToken)).toBe("stale")
      expect(yield* owner.release(executionToken)).toBe("stale")
      expect(yield* owner.snapshot(sessionID)).toMatchObject({
        ownerID: deadExecutionOwnerID,
        generation: 7,
        recoveryOwnerID: claimed.token.recoveryOwnerID,
      })
      expect(yield* owner.abandonRecovery(claimed.token)).toBe("released")
    }),
  )

  recoveryIt.effect("takes over a proven-dead recovery owner with exact CAS and fences stale abandon", () =>
    Effect.gen(function* () {
      yield* setupRecovery(deadExecutionOwnerID, deadRecoveryOwnerID)
      const owner = yield* SessionExecutionOwner.Service
      const stale = {
        sessionID,
        ownerID: deadExecutionOwnerID,
        generation: 7,
        recoveryOwnerID: deadRecoveryOwnerID,
      } satisfies SessionExecutionOwner.RecoveryToken

      const claimed = yield* owner.tryClaimRecovery(sessionID)
      expect(claimed.state).toBe("claimed")
      if (claimed.state !== "claimed") return
      expect(claimed.token).toEqual({
        sessionID,
        ownerID: deadExecutionOwnerID,
        generation: 7,
        recoveryOwnerID: recoveryRuntimeID,
      })
      expect(yield* owner.abandonRecovery(stale)).toBe("stale")
      expect(yield* owner.snapshot(sessionID)).toMatchObject({
        ownerID: deadExecutionOwnerID,
        generation: 7,
        recoveryOwnerID: recoveryRuntimeID,
      })
      expect(yield* owner.abandonRecovery(claimed.token)).toBe("released")
    }),
  )
})
