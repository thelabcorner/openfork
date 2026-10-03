import { describe, expect, test } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { DirectoryActivityLease } from "@opencode-ai/core/directory-activity-lease"
import { DirectoryActivityLeaseTable } from "@opencode-ai/core/directory-activity-lease.sql"
import { DirectoryMaintenanceGuard } from "@opencode-ai/core/directory-maintenance-guard"
import { DirectoryMaintenanceGuardTable } from "@opencode-ai/core/directory-maintenance-guard.sql"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { RuntimeOwner } from "@opencode-ai/core/runtime-owner"
import { RuntimeOwnerTable } from "@opencode-ai/core/runtime-owner.sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const nodes = () =>
  LayerNode.group([
    Database.node,
    RuntimeOwner.node,
    SessionExecutionOwner.node,
    DirectoryMaintenanceGuard.node,
    DirectoryActivityLease.node,
  ])

const layer = AppNodeBuilder.build(nodes(), [[Database.node, Database.layerFromPath(":memory:")]])
const it = testEffect(layer)

const currentRuntimeID = "runtime-owner:lease-current" as RuntimeOwner.ID
const deadOwnerID = "runtime-owner:lease-dead" as RuntimeOwner.ID
const liveOwnerID = "runtime-owner:lease-live" as RuntimeOwner.ID
const unknownOwnerID = "runtime-owner:lease-unknown" as RuntimeOwner.ID
const foreignOwnerID = "runtime-owner:lease-foreign" as RuntimeOwner.ID

const fakeRuntimeLayer = Layer.succeed(
  RuntimeOwner.Service,
  RuntimeOwner.Service.of({
    id: currentRuntimeID,
    pid: 999_001,
    startedAt: 1,
    retain: Effect.succeed({ release: Effect.void }),
    snapshot: (id) => Effect.succeed({ id, pid: 999_001, startedAt: 1, heartbeatAt: 1, controlEpoch: 0 }),
    proveLocalDeath: (id) =>
      Effect.succeed(
        id === deadOwnerID
          ? ("dead" as const)
          : id === liveOwnerID
            ? ("alive-or-unknown" as const)
            : ("not-local-or-unknown" as const),
      ),
  }),
)

const recoveryIt = testEffect(
  AppNodeBuilder.build(nodes(), [
    [Database.node, Database.layerFromPath(":memory:")],
    [RuntimeOwner.node, fakeRuntimeLayer],
  ]),
)

interface Counters {
  retains: number
  releases: number
}

const countingRuntimeLayer = (id: RuntimeOwner.ID, counters: Counters) =>
  Layer.succeed(
    RuntimeOwner.Service,
    RuntimeOwner.Service.of({
      id,
      pid: 999_001,
      startedAt: 1,
      retain: Effect.sync(() => {
        counters.retains += 1
        let released = false
        return {
          release: Effect.sync(() => {
            if (released) return
            released = true
            counters.releases += 1
          }),
        } satisfies RuntimeOwner.Retention
      }),
      snapshot: (ownerID) => Effect.succeed({ id: ownerID, pid: 999_001, startedAt: 1, heartbeatAt: 1, controlEpoch: 0 }),
      proveLocalDeath: () => Effect.succeed("alive-or-unknown" as const),
    }),
  )

const countingLayer = (id: RuntimeOwner.ID, counters: Counters) =>
  AppNodeBuilder.build(nodes(), [
    [Database.node, Database.layerFromPath(":memory:")],
    [RuntimeOwner.node, countingRuntimeLayer(id, counters)],
  ])

const NAMES = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"] as const

type DirectoryKey = DirectoryMaintenanceGuard.DirectoryKey
type LeaseToken = DirectoryActivityLease.Token

const physicalKey = (path: string): DirectoryKey => {
  const key = DirectoryMaintenanceGuard.existingDirectoryKey(path, process.platform)
  if (key === undefined) throw new Error(`expected an existing physical directory key for ${path}`)
  return key
}

const leaseID = (value: string): DirectoryActivityLease.LeaseID => {
  if (value.length === 0) throw new Error("expected a non-empty lease id")
  return value as DirectoryActivityLease.LeaseID
}

interface Workspace {
  readonly root: string
  readonly dir: (name: string) => string
  readonly key: (path: string) => DirectoryKey
}

const withWorkspace = <A, E, R>(body: (workspace: Workspace) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "openfork-directory-lease-")))
    yield* Effect.addFinalizer(() => Effect.promise(() => rm(root, { recursive: true, force: true })))
    const dir = (name: string) => join(root, name)
    yield* Effect.promise(() => Promise.all(NAMES.map((name) => mkdir(dir(name), { recursive: true }))))
    return yield* body({ root, dir, key: physicalKey })
  })

const aliasTo = (target: string, alias: string) =>
  Effect.promise(() => symlink(target, alias, process.platform === "win32" ? "junction" : "dir"))

const seedOwners = (...ids: RuntimeOwner.ID[]) =>
  Database.Service.use(({ db }) =>
    db
      .insert(RuntimeOwnerTable)
      .values(ids.map((id, index) => ({ id, pid: 500_000 + index, started_at: 1, heartbeat_at: 1, control_epoch: 0 })))
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie),
  )

const seedLease = (input: {
  readonly directory: string
  readonly kind: string
  readonly ownerID: RuntimeOwner.ID
  readonly leaseId: string
  readonly generation?: number
  readonly state?: "active" | "released" | "reconcile_required"
}) =>
  Database.Service.use(({ db }) =>
    db
      .insert(DirectoryActivityLeaseTable)
      .values({
        lease_id: input.leaseId,
        directory: input.directory,
        kind: input.kind,
        owner_id: input.ownerID,
        generation: input.generation ?? 1,
        state: input.state ?? "active",
        acquired_at: 10,
        released_at: input.state === "released" ? 11 : null,
        updated_at: 11,
      })
      .run()
      .pipe(Effect.orDie),
  )

const seedGuard = (input: {
  readonly directory: string
  readonly guardId: string
  readonly ownerID: RuntimeOwner.ID
  readonly acquisitionId?: string
  readonly generation?: number
  readonly state?: "active" | "released" | "reconcile_required"
}) =>
  Database.Service.use(({ db }) =>
    db
      .insert(DirectoryMaintenanceGuardTable)
      .values({
        directory: input.directory,
        guard_id: input.guardId,
        owner_id: input.ownerID,
        acquisition_id: input.acquisitionId ?? `directory-maintenance:seed-${input.guardId}`,
        generation: input.generation ?? 1,
        state: input.state ?? "active",
        acquired_at: 10,
        released_at: input.state === "released" ? 11 : null,
        updated_at: 11,
      })
      .run()
      .pipe(Effect.orDie),
  )

const leaseRows = () =>
  Database.Service.use(({ db }) => db.select().from(DirectoryActivityLeaseTable).all().pipe(Effect.orDie))

const leaseRow = (id: string) =>
  Database.Service.use(({ db }) =>
    db
      .select()
      .from(DirectoryActivityLeaseTable)
      .where(eq(DirectoryActivityLeaseTable.lease_id, id))
      .get()
      .pipe(Effect.orDie),
  )

const guardRows = () =>
  Database.Service.use(({ db }) => db.select().from(DirectoryMaintenanceGuardTable).all().pipe(Effect.orDie))

const acquireLease = (directory: string, kind: string) =>
  DirectoryActivityLease.Service.use((lease) => lease.acquire({ directory, kind }))

const requireLease = (result: DirectoryActivityLease.AcquireResult): LeaseToken => {
  if (result.state !== "acquired") throw new Error(`expected lease acquisition, got ${result.state}`)
  return result.token
}

const acquireGuard = (guardId: string, directories: readonly string[]) =>
  DirectoryMaintenanceGuard.Service.use((guard) => guard.acquire({ guardId, directories }))

const releaseLeaseToken = (token: LeaseToken) => DirectoryActivityLease.Service.use((lease) => lease.release(token))

const releaseGuardToken = (token: DirectoryMaintenanceGuard.Token) =>
  DirectoryMaintenanceGuard.Service.use((guard) => guard.release(token))

const seedProjectAndSession = (sessionID: SessionSchema.ID, directory: string) =>
  Database.Service.use(({ db }) =>
    Effect.gen(function* () {
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
          slug: sessionID,
          directory,
          title: "activity lease fence",
          version: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
    }),
  )

describe("DirectoryActivityLease acquisition", () => {
  it.effect("resolves only existing physical directories and rejects non-canonical kinds", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const leases = yield* DirectoryActivityLease.Service

        const missing = yield* leases.acquire({ directory: ws.dir("missing"), kind: "writer" }).pipe(Effect.flip)
        expect(missing).toBeInstanceOf(DirectoryActivityLease.InvalidDirectoryError)
        const relative = yield* leases.acquire({ directory: "relative/path", kind: "writer" }).pipe(Effect.flip)
        expect(relative).toBeInstanceOf(DirectoryActivityLease.InvalidDirectoryError)
        const padded = yield* leases.acquire({ directory: ws.dir("alpha"), kind: " bad" }).pipe(Effect.flip)
        expect(padded).toBeInstanceOf(DirectoryActivityLease.InvalidKindError)
        const oversized = yield* leases
          .acquire({
            directory: ws.dir("alpha"),
            kind: "k".repeat(DirectoryActivityLease.MAX_CANONICAL_LEASE_KIND_LENGTH + 1),
          })
          .pipe(Effect.flip)
        expect(oversized).toBeInstanceOf(DirectoryActivityLease.InvalidKindError)
        expect(yield* leaseRows()).toHaveLength(0)
      }),
    ),
  )

  it.effect("collapses a physical alias spelling onto the same directory key", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const alias = ws.dir("alpha-alias")
        yield* aliasTo(ws.dir("alpha"), alias)
        const spelling = process.platform === "win32" ? alias.replaceAll("\\", "/").toUpperCase() : alias
        const leases = yield* DirectoryActivityLease.Service
        const acquired = requireLease(yield* leases.acquire({ directory: spelling, kind: "alias-writer" }))
        expect(acquired.directory).toBe(ws.key(ws.dir("alpha")))

        const blocked = yield* acquireGuard("guard-alias", [ws.dir("alpha"), ws.dir("bravo")])
        expect(blocked.state).toBe("blocked")
        if (blocked.state !== "blocked") return yield* Effect.die("expected blocked")
        expect(blocked.activityLeases).toEqual([
          {
            directory: ws.key(ws.dir("alpha")),
            leaseId: acquired.leaseId,
            kind: "alias-writer",
            ownerID: acquired.ownerID,
            generation: acquired.generation,
            state: "active",
          },
        ])
        expect(yield* releaseLeaseToken(acquired)).toBe("released")
      }),
    ),
  )

  it.effect("several shared leases coexist on one directory with distinct generations", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const first = requireLease(yield* acquireLease(ws.dir("alpha"), "writer-one"))
        const second = requireLease(yield* acquireLease(ws.dir("alpha"), "writer-two"))
        expect(first.generation).toBe(1)
        expect(second.generation).toBe(2)
        expect(second.leaseId).not.toBe(first.leaseId)
        const leases = yield* DirectoryActivityLease.Service
        expect(yield* leases.assertHealthy(first)).toEqual({ state: "healthy" })
        expect(yield* leases.assertHealthy(second)).toEqual({ state: "healthy" })
        expect(yield* releaseLeaseToken(first)).toBe("released")
        expect(yield* releaseLeaseToken(second)).toBe("released")
        expect((yield* leaseRows()).every((row) => row.state === "released")).toBe(true)
      }),
    ),
  )

  it.effect("an active maintenance guard blocks a lease with guard evidence and no lease row", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const held = yield* acquireGuard("guard-holds-alpha", [ws.dir("alpha"), ws.dir("bravo")])
        if (held.state !== "acquired") return yield* Effect.die("expected guard acquisition")

        const blocked = yield* acquireLease(ws.dir("alpha"), "writer-under-guard")
        expect(blocked).toEqual({
          state: "blocked",
          blocked: {
            directory: ws.key(ws.dir("alpha")),
            guardId: "guard-holds-alpha",
            ownerID: held.token.ownerID,
            acquisitionId: held.token.acquisitionId,
            generation: held.token.generation,
            state: "active",
          },
        })
        expect(yield* leaseRows()).toHaveLength(0)

        expect(yield* releaseGuardToken(held.token)).toBe("released")
        const after = requireLease(yield* acquireLease(ws.dir("alpha"), "writer-under-guard"))
        expect(yield* releaseLeaseToken(after)).toBe("released")
      }),
    ),
  )

  it.effect("leases never block unrelated maintenance and guards never block unrelated leases", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const lease = requireLease(yield* acquireLease(ws.dir("alpha"), "unrelated-writer"))
        const guard = yield* acquireGuard("guard-unrelated", [ws.dir("bravo"), ws.dir("charlie")])
        expect(guard.state).toBe("acquired")
        if (guard.state !== "acquired") return yield* Effect.die("expected guard acquisition")

        // bravo is inside the guard; delta is unrelated to both authorities.
        const blocked = yield* acquireLease(ws.dir("bravo"), "blocked-writer")
        expect(blocked.state).toBe("blocked")
        const unrelated = requireLease(yield* acquireLease(ws.dir("delta"), "unrelated-writer-two"))
        expect(unrelated.directory).toBe(ws.key(ws.dir("delta")))

        expect(yield* releaseGuardToken(guard.token)).toBe("released")
        const after = requireLease(yield* acquireLease(ws.dir("bravo"), "blocked-writer"))
        expect(yield* releaseLeaseToken(after)).toBe("released")
        expect(yield* releaseLeaseToken(unrelated)).toBe("released")
        expect(yield* releaseLeaseToken(lease)).toBe("released")
      }),
    ),
  )
})

describe("DirectoryMaintenanceGuard activity-lease blocking", () => {
  it.effect("reports an active lease in the distinct activityLeases collection with no guard rows", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const lease = requireLease(yield* acquireLease(ws.dir("alpha"), "shared-writer"))

        const blocked = yield* acquireGuard("guard-lease-blocked", [ws.dir("alpha"), ws.dir("bravo")])
        expect(blocked).toEqual({
          state: "blocked",
          blocked: [],
          activityLeases: [
            {
              directory: ws.key(ws.dir("alpha")),
              leaseId: lease.leaseId,
              kind: "shared-writer",
              ownerID: lease.ownerID,
              generation: lease.generation,
              state: "active",
            },
          ],
          executing: [],
        })
        expect(yield* guardRows()).toHaveLength(0)

        expect(yield* releaseLeaseToken(lease)).toBe("released")
        const after = yield* acquireGuard("guard-lease-blocked", [ws.dir("alpha"), ws.dir("bravo")])
        expect(after.state).toBe("acquired")
        if (after.state === "acquired") expect(yield* releaseGuardToken(after.token)).toBe("released")
      }),
    ),
  )

  it.effect("waits for every coexisting lease before acquiring maintenance", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const first = requireLease(yield* acquireLease(ws.dir("alpha"), "writer-one"))
        const second = requireLease(yield* acquireLease(ws.dir("alpha"), "writer-two"))

        const both = yield* acquireGuard("guard-waits", [ws.dir("alpha"), ws.dir("bravo")])
        expect(both.state).toBe("blocked")
        if (both.state !== "blocked") return yield* Effect.die("expected blocked")
        expect(both.blocked).toEqual([])
        expect(both.activityLeases?.map((entry) => entry.leaseId).sort()).toEqual([first.leaseId, second.leaseId].sort())
        expect(both.activityLeases?.map((entry) => entry.state)).toEqual(["active", "active"])

        expect(yield* releaseLeaseToken(first)).toBe("released")
        const remaining = yield* acquireGuard("guard-waits", [ws.dir("alpha"), ws.dir("bravo")])
        expect(remaining.state).toBe("blocked")
        if (remaining.state !== "blocked") return yield* Effect.die("expected blocked")
        expect(remaining.activityLeases).toEqual([
          {
            directory: ws.key(ws.dir("alpha")),
            leaseId: second.leaseId,
            kind: "writer-two",
            ownerID: second.ownerID,
            generation: second.generation,
            state: "active",
          },
        ])
        expect(yield* guardRows()).toHaveLength(0)

        expect(yield* releaseLeaseToken(second)).toBe("released")
        const after = yield* acquireGuard("guard-waits", [ws.dir("alpha"), ws.dir("bravo")])
        expect(after.state).toBe("acquired")
        if (after.state === "acquired") expect(yield* releaseGuardToken(after.token)).toBe("released")
      }),
    ),
  )

  it.effect("keeps session-execution and activity-lease blockers distinct and simultaneous", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const alpha = ws.dir("alpha")
        const bravo = ws.dir("bravo")
        const sessionID = SessionSchema.ID.make("ses_lease_fence_mixed")
        yield* seedProjectAndSession(sessionID, alpha)
        const owner = yield* SessionExecutionOwner.Service
        const execution = yield* owner.tryAcquire(sessionID)
        if (execution.state !== "acquired") return yield* Effect.die("expected execution acquisition")
        const lease = requireLease(yield* acquireLease(alpha, "session-writer"))

        const blocked = yield* acquireGuard("guard-mixed-blockers", [alpha, bravo])
        expect(blocked.state).toBe("blocked")
        if (blocked.state !== "blocked") return yield* Effect.die("expected blocked")
        // Distinct collections: neither is collapsed into the other.
        expect(blocked.blocked).toEqual([])
        expect(blocked.activityLeases).toHaveLength(1)
        expect(blocked.activityLeases?.[0]).toMatchObject({
          directory: physicalKey(alpha),
          leaseId: lease.leaseId,
          kind: "session-writer",
          state: "active",
        })
        expect(blocked.executing).toHaveLength(1)
        expect(blocked.executing[0]).toMatchObject({
          sessionID,
          ownerID: execution.token.ownerID,
          generation: execution.token.generation,
          persistedDirectory: alpha,
          directory: physicalKey(alpha),
        })
        expect(yield* guardRows()).toHaveLength(0)

        expect(yield* releaseLeaseToken(lease)).toBe("released")
        expect(yield* owner.release(execution.token)).toBe("released")
        const after = yield* acquireGuard("guard-mixed-blockers", [alpha, bravo])
        expect(after.state).toBe("acquired")
        if (after.state === "acquired") expect(yield* releaseGuardToken(after.token)).toBe("released")
      }),
    ),
  )
})

describe("DirectoryActivityLease release integrity", () => {
  it.effect("release is an exact CAS and a stale handle can never release a newer lease", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const leases = yield* DirectoryActivityLease.Service
        const alpha = ws.dir("alpha")
        const first = requireLease(yield* leases.acquire({ directory: alpha, kind: "writer-one" }))
        expect(yield* leases.release(first)).toBe("released")
        expect(yield* leases.release(first)).toBe("stale")

        const second = requireLease(yield* leases.acquire({ directory: alpha, kind: "writer-two" }))
        expect(second.generation).toBe(first.generation + 1)
        // The stale handle names an older, released lease: it can never touch
        // the newer one.
        expect(yield* leases.release(first)).toBe("stale")
        expect(yield* leases.assertHealthy(second)).toEqual({ state: "healthy" })

        expect(yield* leases.release({ ...second, generation: second.generation + 1 })).toBe("stale")
        expect(yield* leases.release({ ...second, kind: "writer-forged" })).toBe("stale")
        expect(yield* leases.release({ ...second, directory: ws.key(ws.dir("bravo")) })).toBe("stale")
        expect(yield* leases.release({ ...second, ownerID: foreignOwnerID })).toBe("stale")
        expect(yield* leases.release({ ...second, leaseId: leaseID("directory-activity:forged") })).toBe("stale")
        expect(yield* leases.release({ ...second, kind: "bad kind" })).toBe("stale")
        expect(yield* leaseRow(second.leaseId)).toMatchObject({
          state: "active",
          kind: "writer-two",
          generation: second.generation,
        })

        expect(yield* leases.release(second)).toBe("released")
        expect(yield* leases.assertHealthy(second)).toEqual({
          state: "unhealthy",
          issues: [{ directory: ws.key(alpha), reason: "released" }],
        })
      }),
    ),
  )

  it.effect("withLease wraps a writer lifetime and always releases through the exact CAS", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const leases = yield* DirectoryActivityLease.Service
        const value = yield* leases.withLease(ws.dir("alpha"), "lifetime-writer", (token) =>
          Effect.sync(() => token.leaseId.length),
        )
        expect(value).toBeGreaterThan(0)
        expect(yield* leaseRows()).toHaveLength(1)
        expect((yield* leaseRows())[0]).toMatchObject({ state: "released", kind: "lifetime-writer" })

        const defect = yield* leases.withLease(ws.dir("alpha"), "lifetime-writer", () => Effect.die("boom")).pipe(Effect.exit)
        expect(Exit.isFailure(defect)).toBe(true)
        expect((yield* leaseRows()).every((row) => row.state === "released")).toBe(true)

        const held = yield* acquireGuard("guard-with-lease", [ws.dir("alpha"), ws.dir("bravo")])
        if (held.state !== "acquired") return yield* Effect.die("expected guard acquisition")
        const refused = yield* leases.withLease(ws.dir("alpha"), "lifetime-writer", () => Effect.void).pipe(Effect.flip)
        if (!(refused instanceof DirectoryActivityLease.BlockedError)) return yield* Effect.die("expected BlockedError")
        expect(refused.guardId).toBe("guard-with-lease")
        expect(refused.directory).toBe(ws.key(ws.dir("alpha")))
        expect(yield* leaseRows()).toHaveLength(2)
        expect(yield* releaseGuardToken(held.token)).toBe("released")
      }),
    ),
  )
})

describe("DirectoryActivityLease durable authority triggers", () => {
  const rawUpdate = (id: string, values: Partial<typeof DirectoryActivityLeaseTable.$inferInsert>) =>
    Database.Service.use(({ db }) =>
      db.update(DirectoryActivityLeaseTable).set(values).where(eq(DirectoryActivityLeaseTable.lease_id, id)).run().pipe(Effect.exit),
    )

  it.effect("rejects raw deletion and replacement of lease rows", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const lease = requireLease(yield* acquireLease(ws.dir("alpha"), "trigger-writer"))
        const { db } = yield* Database.Service

        const deletion = yield* db
          .delete(DirectoryActivityLeaseTable)
          .where(eq(DirectoryActivityLeaseTable.lease_id, lease.leaseId))
          .run()
          .pipe(Effect.exit)
        expect(Exit.isFailure(deletion)).toBe(true)
        if (Exit.isFailure(deletion)) {
          expect(Cause.pretty(deletion.cause)).toContain("directory_activity_lease rows are never deletable")
        }

        // WITH recursive_triggers OFF, REPLACE deletes the conflicting row
        // without firing the DELETE trigger, so the BEFORE INSERT guard is the
        // only defense that can see this rewrite.
        const replacement = yield* db
          .run(
            sql`INSERT OR REPLACE INTO directory_activity_lease (lease_id, directory, kind, owner_id, generation, state, acquired_at, released_at, updated_at) VALUES (${lease.leaseId}, ${lease.directory}, 'forged', ${lease.ownerID}, 1, 'active', 1, NULL, 1)`,
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(replacement)).toBe(true)
        if (Exit.isFailure(replacement)) {
          expect(Cause.pretty(replacement.cause)).toContain("directory_activity_lease rows are never replaceable")
        }
        expect(yield* leaseRow(lease.leaseId)).toMatchObject({ kind: "trigger-writer", state: "active" })
      }),
    ),
  )

  it.effect("rejects raw identity mutation and terminal resurrection", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const lease = requireLease(yield* acquireLease(ws.dir("alpha"), "trigger-identity"))
        const generation = lease.generation

        // Same-state writes may only refresh updated_at.
        expect(Exit.isFailure(yield* rawUpdate(lease.leaseId, { kind: "forged" }))).toBe(true)
        expect(Exit.isFailure(yield* rawUpdate(lease.leaseId, { owner_id: foreignOwnerID }))).toBe(true)
        expect(Exit.isFailure(yield* rawUpdate(lease.leaseId, { generation: generation + 1 }))).toBe(true)
        expect(Exit.isFailure(yield* rawUpdate(lease.leaseId, { acquired_at: 1 }))).toBe(true)
        // active -> released may not smuggle identity changes or omit released_at.
        expect(Exit.isFailure(yield* rawUpdate(lease.leaseId, { state: "released" }))).toBe(true)
        expect(
          Exit.isFailure(yield* rawUpdate(lease.leaseId, { state: "released", released_at: 1, kind: "forged" })),
        ).toBe(true)
        // active -> reconcile_required may not carry a released_at.
        expect(Exit.isFailure(yield* rawUpdate(lease.leaseId, { state: "reconcile_required", released_at: 1 }))).toBe(true)
        expect(Exit.isSuccess(yield* rawUpdate(lease.leaseId, { updated_at: 99 }))).toBe(true)

        expect(yield* leaseRow(lease.leaseId)).toMatchObject({
          kind: "trigger-identity",
          owner_id: lease.ownerID,
          generation,
          state: "active",
          released_at: null,
        })

        expect(yield* releaseLeaseToken(lease)).toBe("released")
        // A released lease_id is terminal: no raw resurrection.
        expect(
          Exit.isFailure(yield* rawUpdate(lease.leaseId, { state: "active", released_at: null })),
        ).toBe(true)
        expect(yield* leaseRow(lease.leaseId)).toMatchObject({ state: "released" })
      }),
    ),
  )
})

describe("DirectoryActivityLease reconciliation", () => {
  recoveryIt.effect("reconciles each dead lease separately and never releases", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const leases = yield* DirectoryActivityLease.Service
        yield* seedOwners(deadOwnerID, liveOwnerID, unknownOwnerID, currentRuntimeID)
        yield* seedLease({ directory: ws.key(ws.dir("alpha")), kind: "dead-writer-a", ownerID: deadOwnerID, leaseId: "lease-dead-a" })
        yield* seedLease({ directory: ws.key(ws.dir("alpha")), kind: "dead-writer-b", ownerID: deadOwnerID, leaseId: "lease-dead-b" })
        yield* seedLease({ directory: ws.key(ws.dir("bravo")), kind: "live-writer", ownerID: liveOwnerID, leaseId: "lease-live" })
        yield* seedLease({ directory: ws.key(ws.dir("charlie")), kind: "unknown-writer", ownerID: unknownOwnerID, leaseId: "lease-unknown" })

        const report = yield* leases.reconcile()
        const byLease = <T extends { readonly leaseId: string }>(rows: readonly T[]) =>
          [...rows].sort((left, right) => (left.leaseId < right.leaseId ? -1 : 1))
        expect(byLease(report.reconciled)).toEqual([
          {
            leaseId: leaseID("lease-dead-a"),
            kind: "dead-writer-a",
            ownerID: deadOwnerID,
            directory: ws.key(ws.dir("alpha")),
          },
          {
            leaseId: leaseID("lease-dead-b"),
            kind: "dead-writer-b",
            ownerID: deadOwnerID,
            directory: ws.key(ws.dir("alpha")),
          },
        ])
        expect(byLease(report.blocked)).toEqual([
          {
            leaseId: leaseID("lease-live"),
            kind: "live-writer",
            ownerID: liveOwnerID,
            proof: "alive-or-unknown",
            directory: ws.key(ws.dir("bravo")),
          },
          {
            leaseId: leaseID("lease-unknown"),
            kind: "unknown-writer",
            ownerID: unknownOwnerID,
            proof: "not-local-or-unknown",
            directory: ws.key(ws.dir("charlie")),
          },
        ])
        expect(yield* leaseRow("lease-dead-a")).toMatchObject({ state: "reconcile_required", released_at: null })
        expect(yield* leaseRow("lease-live")).toMatchObject({ state: "active" })
        expect(yield* leaseRow("lease-unknown")).toMatchObject({ state: "active" })
        expect((yield* leaseRows()).some((row) => row.state === "released")).toBe(false)

        // reconcile_required leases keep blocking exclusive maintenance with
        // their own distinct evidence.
        const blocked = yield* acquireGuard("guard-reconcile", [ws.dir("alpha"), ws.dir("delta")])
        expect(blocked.state).toBe("blocked")
        if (blocked.state !== "blocked") return yield* Effect.die("expected blocked")
        expect(blocked.blocked).toEqual([])
        expect(blocked.activityLeases?.map((entry) => entry.state)).toEqual([
          "reconcile_required",
          "reconcile_required",
        ])

        // Shared leases remain shared: a fresh writer may still acquire.
        const fresh = requireLease(yield* acquireLease(ws.dir("alpha"), "fresh-writer"))
        expect(yield* releaseLeaseToken(fresh)).toBe("released")

        const deadToken = {
          leaseId: leaseID("lease-dead-a"),
          kind: "dead-writer-a",
          ownerID: deadOwnerID,
          generation: 1,
          directory: ws.key(ws.dir("alpha")),
        } satisfies LeaseToken
        expect(yield* leases.resolveReconcileRequired({ ...deadToken, generation: 2 })).toEqual({ state: "stale" })
        expect(
          yield* leases.resolveReconcileRequired({ ...deadToken, leaseId: leaseID("lease-dead-b") }),
        ).toEqual({ state: "stale" })
        expect(yield* leases.resolveReconcileRequired(deadToken)).toEqual({ state: "resolved" })
        // Resolution is single-shot: a terminal resolved lease is stale.
        expect(yield* leases.resolveReconcileRequired(deadToken)).toEqual({ state: "stale" })
        expect(yield* leases.assertHealthy(deadToken)).toEqual({
          state: "unhealthy",
          issues: [{ directory: ws.key(ws.dir("alpha")), reason: "released" }],
        })

        const liveToken = {
          leaseId: leaseID("lease-live"),
          kind: "live-writer",
          ownerID: liveOwnerID,
          generation: 1,
          directory: ws.key(ws.dir("bravo")),
        } satisfies LeaseToken
        expect(yield* leases.resolveReconcileRequired(liveToken)).toEqual({
          state: "blocked",
          proof: "alive-or-unknown",
        })
        const unknownToken = {
          leaseId: leaseID("lease-unknown"),
          kind: "unknown-writer",
          ownerID: unknownOwnerID,
          generation: 1,
          directory: ws.key(ws.dir("charlie")),
        } satisfies LeaseToken
        expect(yield* leases.resolveReconcileRequired(unknownToken)).toEqual({
          state: "blocked",
          proof: "not-local-or-unknown",
        })
        expect(yield* leaseRow("lease-live")).toMatchObject({ state: "active" })
        expect(yield* leaseRow("lease-unknown")).toMatchObject({ state: "active" })
      }),
    ),
  )

  it.effect("never treats a stale heartbeat as death proof for a live local owner", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const runtime = yield* RuntimeOwner.Service
        const leases = yield* DirectoryActivityLease.Service
        const { db } = yield* Database.Service
        const acquired = requireLease(yield* acquireLease(ws.dir("alpha"), "stale-heartbeat"))
        yield* db
          .update(RuntimeOwnerTable)
          .set({ heartbeat_at: 1 })
          .where(eq(RuntimeOwnerTable.id, runtime.id))
          .run()
          .pipe(Effect.orDie)

        const report = yield* leases.reconcile()
        expect(report.reconciled).toEqual([])
        expect(report.blocked).toEqual([
          {
            leaseId: acquired.leaseId,
            kind: "stale-heartbeat",
            ownerID: runtime.id,
            proof: "alive-or-unknown",
            directory: ws.key(ws.dir("alpha")),
          },
        ])
        expect(yield* leaseRow(acquired.leaseId)).toMatchObject({ state: "active" })
        expect(yield* leases.release(acquired)).toBe("released")
      }),
    ),
  )
})

describe("DirectoryActivityLease retention accounting", () => {
  test("releases retention exactly once on a guard-blocked acquisition", async () => {
    const root = await mkdtemp(join(tmpdir(), "openfork-directory-lease-retention-"))
    try {
      const alpha = join(root, "alpha")
      const bravo = join(root, "bravo")
      await Promise.all([alpha, bravo].map((directory) => mkdir(directory)))
      const counters: Counters = { retains: 0, releases: 0 }
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* seedOwners(foreignOwnerID)
            yield* seedGuard({ directory: physicalKey(alpha), guardId: "guard-retention", ownerID: foreignOwnerID })
            return yield* acquireLease(alpha, "retention-writer")
          }).pipe(Effect.provide(countingLayer(currentRuntimeID, counters))),
        ),
      )
      expect(result.state).toBe("blocked")
      expect(counters).toEqual({ retains: 1, releases: 1 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("releases retention when an acquire is interrupted before durable ownership is published", async () => {
    const root = await mkdtemp(join(tmpdir(), "openfork-directory-lease-retention-"))
    try {
      const alpha = join(root, "alpha")
      await mkdir(alpha)
      const counters: Counters = { retains: 0, releases: 0 }
      const persisted = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { db } = yield* Database.Service
            const started = yield* Deferred.make<void>()
            // Hold the writer reservation so the acquire suspends on the
            // IMMEDIATE boundary and can be interrupted before it publishes.
            const holder = yield* db
              .transaction(() => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)), {
                behavior: "immediate",
              })
              .pipe(Effect.forkChild)
            yield* Deferred.await(started)
            const acquire = yield* acquireLease(alpha, "interrupted-writer").pipe(Effect.forkChild)
            for (let attempt = 0; attempt < 100 && counters.retains === 0; attempt++) yield* Effect.yieldNow
            expect(counters.retains).toBe(1)

            const interrupting = yield* Fiber.interrupt(acquire).pipe(Effect.forkChild)
            yield* Effect.yieldNow
            yield* Fiber.interrupt(holder)
            yield* Fiber.join(interrupting)
            return yield* leaseRows()
          }).pipe(Effect.provide(countingLayer(currentRuntimeID, counters))),
        ),
      )
      expect(counters).toEqual({ retains: 1, releases: 1 })
      expect(persisted).toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("drops a terminal retention exactly once when the durable lease is already released", async () => {
    const root = await mkdtemp(join(tmpdir(), "openfork-directory-lease-retention-"))
    try {
      const alpha = join(root, "alpha")
      await mkdir(alpha)
      const counters: Counters = { retains: 0, releases: 0 }
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* seedOwners(currentRuntimeID)
            const leases = yield* DirectoryActivityLease.Service
            const acquired = requireLease(yield* leases.acquire({ directory: alpha, kind: "terminal-writer" }))
            const { db } = yield* Database.Service
            yield* db
              .update(DirectoryActivityLeaseTable)
              .set({ state: "released", released_at: Date.now(), updated_at: Date.now() })
              .where(eq(DirectoryActivityLeaseTable.lease_id, acquired.leaseId))
              .run()
              .pipe(Effect.orDie)
            const unhealthy = yield* leases.assertHealthy(acquired)
            expect(unhealthy.state).toBe("unhealthy")
            expect(counters).toEqual({ retains: 1, releases: 1 })
            expect(yield* leases.release(acquired)).toBe("stale")
            expect(counters).toEqual({ retains: 1, releases: 1 })
            expect(yield* leases.release(acquired)).toBe("stale")
            expect(counters).toEqual({ retains: 1, releases: 1 })
          }).pipe(Effect.provide(countingLayer(currentRuntimeID, counters))),
        ),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("DirectoryActivityLease concurrency", () => {
  type LeaseAttempt = DirectoryActivityLease.AcquireResult
  type GuardAttempt = DirectoryMaintenanceGuard.AcquireResult

  test("two file-backed graphs race lease against guard with never simultaneous authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "openfork-directory-lease-race-"))
    const databasePath = join(root, "openfork.db")
    const alpha = join(root, "alpha")
    const bravo = join(root, "bravo")
    let alphaKey: DirectoryKey
    let bravoKey: DirectoryKey
    const makeLayer = () =>
      AppNodeBuilder.build(nodes(), [[Database.node, Database.layerFromPath(databasePath)]])

    const leaseAttempt = (): Promise<LeaseAttempt> =>
      Effect.runPromise(
        Effect.gen(function* () {
          const leases = yield* DirectoryActivityLease.Service
          return yield* leases.acquire({ directory: alpha, kind: "race-writer" })
        }).pipe(Effect.scoped, Effect.provide(makeLayer())),
      )
    const guardAttempt = (): Promise<GuardAttempt> =>
      Effect.runPromise(
        Effect.gen(function* () {
          const guards = yield* DirectoryMaintenanceGuard.Service
          return yield* guards.acquire({ guardId: "guard-lease-race", directories: [alpha, bravo] })
        }).pipe(Effect.scoped, Effect.provide(makeLayer())),
      )
    const readAuthority = () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { readDb } = yield* Database.Service
          const guards = yield* readDb.select().from(DirectoryMaintenanceGuardTable).all().pipe(Effect.orDie)
          const leases = yield* readDb.select().from(DirectoryActivityLeaseTable).all().pipe(Effect.orDie)
          return {
            activeGuards: guards.filter(
              (row) => row.state !== "released" && (row.directory === alphaKey || row.directory === bravoKey),
            ),
            activeLeases: leases.filter((row) => row.state !== "released" && row.directory === alphaKey),
          }
        }).pipe(Effect.scoped, Effect.provide(makeLayer())),
      )
    const releaseLeaseOnDisk = (token: LeaseToken) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const leases = yield* DirectoryActivityLease.Service
          return yield* leases.release(token)
        }).pipe(Effect.scoped, Effect.provide(makeLayer())),
      )
    const releaseGuardOnDisk = (token: DirectoryMaintenanceGuard.Token) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const guards = yield* DirectoryMaintenanceGuard.Service
          return yield* guards.release(token)
        }).pipe(Effect.scoped, Effect.provide(makeLayer())),
      )

    const runBoth = async (guardFirst: boolean): Promise<readonly [LeaseAttempt, GuardAttempt]> => {
      if (guardFirst) {
        const [guard, lease] = await Promise.all([guardAttempt(), leaseAttempt()])
        return [lease, guard] as const
      }
      return Promise.all([leaseAttempt(), guardAttempt()])
    }

    try {
      await Promise.all([alpha, bravo].map((directory) => mkdir(directory)))
      alphaKey = physicalKey(alpha)
      bravoKey = physicalKey(bravo)
      const seen = { lease: false, guard: false }
      const MAX_ITERATIONS = 10
      for (let iteration = 0; iteration < MAX_ITERATIONS && !(seen.lease && seen.guard); iteration++) {
        const [leaseResult, guardResult] = await runBoth(iteration % 2 === 1)

        const leaseWon = leaseResult.state === "acquired"
        const guardWon = guardResult.state === "acquired"
        // Exactly one authority commits per round.
        expect(leaseWon === guardWon).toBe(false)

        if (leaseWon) {
          seen.lease = true
          expect(guardResult.state).toBe("blocked")
          if (guardResult.state === "blocked") {
            expect(guardResult.blocked).toEqual([])
            expect(guardResult.activityLeases).toEqual([
              {
                directory: alphaKey,
                leaseId: leaseResult.token.leaseId,
                kind: "race-writer",
                ownerID: leaseResult.token.ownerID,
                generation: leaseResult.token.generation,
                state: "active",
              },
            ])
          }
        } else {
          seen.guard = true
          if (guardResult.state !== "acquired") throw new Error("expected exactly one authority winner")
          expect(leaseResult).toEqual({
            state: "blocked",
            blocked: {
              directory: alphaKey,
              guardId: "guard-lease-race",
              ownerID: guardResult.token.ownerID,
              acquisitionId: guardResult.token.acquisitionId,
              generation: guardResult.token.generation,
              state: "active",
            },
          })
        }

        const authority = await readAuthority()
        // Never simultaneous authority over the shared directory.
        expect(authority.activeGuards.length === 0 || authority.activeLeases.length === 0).toBe(true)
        if (leaseWon) {
          expect(authority.activeLeases).toHaveLength(1)
          expect(authority.activeGuards).toHaveLength(0)
        } else {
          expect(authority.activeGuards).toHaveLength(2)
          expect(authority.activeLeases).toHaveLength(0)
        }

        if (leaseWon) {
          if (leaseResult.state !== "acquired") throw new Error("unreachable")
          expect(await releaseLeaseOnDisk(leaseResult.token)).toBe("released")
        } else {
          if (guardResult.state !== "acquired") throw new Error("unreachable")
          expect(await releaseGuardOnDisk(guardResult.token)).toBe("released")
        }
      }
      // Both winner classes were exercised, so both reverse paths are proven:
      // a guard winner later becomes blocked by an active lease and vice versa.
      expect(seen).toEqual({ lease: true, guard: true })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("two file-backed graphs racing leases on one directory both acquire as shared writers", async () => {
    const root = await mkdtemp(join(tmpdir(), "openfork-directory-lease-race-"))
    const databasePath = join(root, "openfork.db")
    const alpha = join(root, "alpha")
    const makeLayer = () =>
      AppNodeBuilder.build(nodes(), [[Database.node, Database.layerFromPath(databasePath)]])
    const attempt = () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const leases = yield* DirectoryActivityLease.Service
          return yield* leases.acquire({ directory: alpha, kind: "shared-racer" })
        }).pipe(Effect.scoped, Effect.provide(makeLayer())),
      )

    try {
      await mkdir(alpha)
      const [first, second] = await Promise.all([attempt(), attempt()])
      for (const result of [first, second]) {
        if (result.state !== "acquired") throw new Error("expected both shared leases to acquire")
      }
      if (first.state !== "acquired" || second.state !== "acquired") return
      expect(first.token.leaseId).not.toBe(second.token.leaseId)
      expect(new Set([first.token.generation, second.token.generation]).size).toBe(2)

      const persisted = await Effect.runPromise(
        Effect.gen(function* () {
          const { readDb } = yield* Database.Service
          return yield* readDb.select().from(DirectoryActivityLeaseTable).all().pipe(Effect.orDie)
        }).pipe(Effect.scoped, Effect.provide(makeLayer())),
      )
      expect(persisted).toHaveLength(2)
      expect(persisted.every((row) => row.state === "active" && row.directory === physicalKey(alpha))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
