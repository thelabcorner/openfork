import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "@opencode-ai/core/database/database"
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
import { SessionExecutionOwnerTable } from "@opencode-ai/core/session/execution-owner.sql"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const nodes = () =>
  LayerNode.group([Database.node, RuntimeOwner.node, SessionExecutionOwner.node, DirectoryMaintenanceGuard.node])

const makeLayer = (database: ReturnType<typeof Database.layerFromPath>) =>
  AppNodeBuilder.build(nodes(), [[Database.node, database]])

const it = testEffect(makeLayer(Database.layerFromPath(":memory:")))

const currentRuntimeID = "runtime-owner:g2-current" as RuntimeOwner.ID
const foreignOwnerID = "runtime-owner:g2-foreign" as RuntimeOwner.ID
const deadOwnerID = "runtime-owner:g2-dead" as RuntimeOwner.ID

interface Counters {
  retains: number
  releases: number
}

const countingRuntimeLayer = (counters: Counters) =>
  Layer.succeed(
    RuntimeOwner.Service,
    RuntimeOwner.Service.of({
      id: currentRuntimeID,
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
      snapshot: (id) => Effect.succeed({ id, pid: 999_001, startedAt: 1, heartbeatAt: 1, controlEpoch: 0 }),
      proveLocalDeath: () => Effect.succeed("alive-or-unknown" as const),
    }),
  )

const countingLayer = (counters: Counters) =>
  AppNodeBuilder.build(nodes(), [
    [Database.node, Database.layerFromPath(":memory:")],
    [RuntimeOwner.node, countingRuntimeLayer(counters)],
  ])

interface Workspace {
  readonly root: string
  readonly dir: (name: string) => string
}

const withWorkspace = <A, E, R>(body: (workspace: Workspace) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "openfork-execution-maintenance-")))
    yield* Effect.addFinalizer(() => Effect.promise(() => rm(root, { recursive: true, force: true })))
    return yield* body({ root, dir: (name) => join(root, name) })
  })

const physicalKey = (path: string): DirectoryMaintenanceGuard.DirectoryKey => {
  const key = DirectoryMaintenanceGuard.existingDirectoryKey(path, process.platform)
  if (key === undefined) throw new Error(`expected a physical directory key for ${path}`)
  return key
}

const makeDirs = (...paths: string[]) =>
  Effect.promise(() => Promise.all(paths.map((path) => mkdir(path, { recursive: true }))))

const aliasTo = (target: string, alias: string) =>
  Effect.promise(() => symlink(target, alias, process.platform === "win32" ? "junction" : "dir"))

const requireGuardToken = (result: DirectoryMaintenanceGuard.AcquireResult): DirectoryMaintenanceGuard.Token => {
  if (result.state !== "acquired") throw new Error(`expected guard acquisition, got ${result.state}`)
  return result.token
}

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
          title: "execution maintenance",
          version: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
    }),
  )

const seedOwners = (...ids: RuntimeOwner.ID[]) =>
  Database.Service.use(({ db }) =>
    db
      .insert(RuntimeOwnerTable)
      .values(ids.map((id, index) => ({ id, pid: 700_000 + index, started_at: 1, heartbeat_at: 1, control_epoch: 0 })))
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie),
  )

const seedGuard = (input: {
  readonly directory: DirectoryMaintenanceGuard.DirectoryKey
  readonly guardId: string
  readonly ownerID: RuntimeOwner.ID
  readonly acquisitionId: string
  readonly generation: number
  readonly state: "active" | "released" | "reconcile_required"
}) =>
  Database.Service.use(({ db }) =>
    db
      .insert(DirectoryMaintenanceGuardTable)
      .values({
        directory: input.directory,
        guard_id: input.guardId,
        owner_id: input.ownerID,
        acquisition_id: input.acquisitionId,
        generation: input.generation,
        state: input.state,
        acquired_at: 10,
        released_at: input.state === "released" ? 11 : null,
        updated_at: 11,
      })
      .run()
      .pipe(Effect.orDie),
  )

const seedExecutionOwner = (input: {
  readonly sessionID: SessionSchema.ID
  readonly ownerID: RuntimeOwner.ID
  readonly generation: number
}) =>
  Database.Service.use(({ db }) =>
    db
      .insert(SessionExecutionOwnerTable)
      .values({
        session_id: input.sessionID,
        generation: input.generation,
        owner_id: input.ownerID,
        acquired_at: 10,
      })
      .run()
      .pipe(Effect.orDie),
  )

const guardRows = () =>
  Database.Service.use(({ db }) => db.select().from(DirectoryMaintenanceGuardTable).all().pipe(Effect.orDie))

const executionOwnerRows = (sessionID: SessionSchema.ID) =>
  Database.Service.use(({ db }) =>
    db
      .select()
      .from(SessionExecutionOwnerTable)
      .where(eq(SessionExecutionOwnerTable.session_id, sessionID))
      .all()
      .pipe(Effect.orDie),
  )

describe("SessionExecutionOwner / DirectoryMaintenanceGuard admission fence", () => {
  it.effect("guard wins: an alias of the guarded directory blocks tryAcquire with exact evidence and no owner", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const alpha = ws.dir("alpha")
        const bravo = ws.dir("bravo")
        const alias = ws.dir("alpha-alias")
        yield* makeDirs(alpha, bravo)
        yield* aliasTo(alpha, alias)
        const sessionID = SessionSchema.ID.make("ses_g2_guard_wins")
        yield* seedProjectAndSession(sessionID, alias)
        const guards = yield* DirectoryMaintenanceGuard.Service
        const owner = yield* SessionExecutionOwner.Service
        const guard = requireGuardToken(yield* guards.acquire({ guardId: "guard-g2-wins", directories: [alpha, bravo] }))

        expect(yield* owner.tryAcquire(sessionID)).toEqual({
          state: "maintenance-blocked",
          reason: "guard-active",
          sessionID,
          directory: alias,
          directoryKey: physicalKey(alpha),
          guards: [
            {
              directory: physicalKey(alpha),
              guardId: "guard-g2-wins",
              ownerID: guard.ownerID,
              acquisitionId: guard.acquisitionId,
              generation: guard.generation,
              state: "active",
            },
          ],
        })
        expect(yield* executionOwnerRows(sessionID)).toHaveLength(0)
        expect(yield* owner.snapshot(sessionID)).toEqual({ sessionID, generation: 0 })
      }),
    ),
  )

  it.effect("reconcile-required guard blocks tryAcquire with reconcile evidence and no owner", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const alpha = ws.dir("alpha")
        yield* makeDirs(alpha)
        const sessionID = SessionSchema.ID.make("ses_g2_reconcile")
        yield* seedProjectAndSession(sessionID, alpha)
        yield* seedOwners(deadOwnerID)
        yield* seedGuard({
          directory: physicalKey(alpha),
          guardId: "guard-g2-reconcile",
          ownerID: deadOwnerID,
          acquisitionId: "directory-maintenance:g2-reconcile",
          generation: 3,
          state: "reconcile_required",
        })
        const owner = yield* SessionExecutionOwner.Service

        expect(yield* owner.tryAcquire(sessionID)).toEqual({
          state: "maintenance-blocked",
          reason: "guard-reconcile-required",
          sessionID,
          directory: alpha,
          directoryKey: physicalKey(alpha),
          guards: [
            {
              directory: physicalKey(alpha),
              guardId: "guard-g2-reconcile",
              ownerID: deadOwnerID,
              acquisitionId: "directory-maintenance:g2-reconcile" as DirectoryMaintenanceGuard.AcquisitionID,
              generation: 3,
              state: "reconcile_required",
            },
          ],
        })
        expect(yield* executionOwnerRows(sessionID)).toHaveLength(0)
      }),
    ),
  )

  it.effect("release-vs-start: releasing the blocking guard admits the next tryAcquire", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const alpha = ws.dir("alpha")
        const bravo = ws.dir("bravo")
        yield* makeDirs(alpha, bravo)
        const sessionID = SessionSchema.ID.make("ses_g2_release")
        yield* seedProjectAndSession(sessionID, alpha)
        const guards = yield* DirectoryMaintenanceGuard.Service
        const owner = yield* SessionExecutionOwner.Service
        const guard = requireGuardToken(
          yield* guards.acquire({ guardId: "guard-g2-release", directories: [alpha, bravo] }),
        )

        expect((yield* owner.tryAcquire(sessionID)).state).toBe("maintenance-blocked")
        expect(yield* executionOwnerRows(sessionID)).toHaveLength(0)

        expect(yield* guards.release(guard)).toBe("released")
        const acquired = yield* owner.tryAcquire(sessionID)
        expect(acquired.state).toBe("acquired")
        if (acquired.state !== "acquired") return
        expect(acquired.token.generation).toBe(1)
        expect(yield* owner.release(acquired.token)).toBe("released")
        expect(yield* owner.snapshot(sessionID)).toEqual({ sessionID, generation: 1 })
      }),
    ),
  )

  it.effect("session wins: an active execution blocks guard acquisition with executing evidence and no guard rows", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const alpha = ws.dir("alpha")
        const bravo = ws.dir("bravo")
        yield* makeDirs(alpha, bravo)
        const sessionID = SessionSchema.ID.make("ses_g2_session_wins")
        yield* seedProjectAndSession(sessionID, alpha)
        const guards = yield* DirectoryMaintenanceGuard.Service
        const owner = yield* SessionExecutionOwner.Service
        const execution = yield* owner.tryAcquire(sessionID)
        if (execution.state !== "acquired") return yield* Effect.die("expected execution acquisition")

        expect(yield* guards.acquire({ guardId: "guard-g2-session-wins", directories: [alpha, bravo] })).toEqual({
          state: "blocked",
          blocked: [],
          activityLeases: [],
          executing: [
            {
              sessionID,
              ownerID: execution.token.ownerID,
              generation: execution.token.generation,
              persistedDirectory: alpha,
              directory: physicalKey(alpha),
            },
          ],
        })
        expect(yield* guardRows()).toHaveLength(0)

        expect(yield* owner.release(execution.token)).toBe("released")
        const retry = requireGuardToken(
          yield* guards.acquire({ guardId: "guard-g2-session-wins", directories: [alpha, bravo] }),
        )
        expect(yield* guards.release(retry)).toBe("released")
      }),
    ),
  )

  test("concurrent first-writer race across two database graphs yields exactly one authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "openfork-execution-maintenance-race-"))
    const databasePath = join(root, "openfork.db")
    const alpha = join(root, "alpha")
    const bravo = join(root, "bravo")
    const sessionID = SessionSchema.ID.make("ses_g2_race")
    const graph = () => makeLayer(Database.layerFromPath(databasePath))
    try {
      await Promise.all([alpha, bravo].map((directory) => mkdir(directory)))
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* seedProjectAndSession(sessionID, alpha)
          }).pipe(Effect.provide(graph())),
        ),
      )

      const ownerAttempt = Effect.gen(function* () {
        const owner = yield* SessionExecutionOwner.Service
        return yield* owner.tryAcquire(sessionID)
      }).pipe(Effect.scoped, Effect.provide(graph()))
      const guardAttempt = Effect.gen(function* () {
        const guards = yield* DirectoryMaintenanceGuard.Service
        return yield* guards.acquire({ guardId: "guard-g2-race", directories: [alpha, bravo] })
      }).pipe(Effect.scoped, Effect.provide(graph()))

      const [ownerResult, guardResult] = await Effect.runPromise(
        Effect.all([ownerAttempt, guardAttempt], { concurrency: "unbounded" }),
      )

      const alphaKey = physicalKey(alpha)
      const bravoKey = physicalKey(bravo)

      if (ownerResult.state === "acquired") {
        expect(guardResult).toEqual({
          state: "blocked",
          blocked: [],
          activityLeases: [],
          executing: [
            {
              sessionID,
              ownerID: ownerResult.token.ownerID,
              generation: ownerResult.token.generation,
              persistedDirectory: alpha,
              directory: alphaKey,
            },
          ],
        })
      } else {
        if (ownerResult.state !== "maintenance-blocked")
          throw new Error(`expected exactly one authority winner, owner attempt was ${ownerResult.state}`)
        expect(ownerResult.reason).toBe("guard-active")
        expect(guardResult.state).toBe("acquired")
      }

      const persisted = await Effect.runPromise(
        Effect.gen(function* () {
          const { readDb } = yield* Database.Service
          return {
            guards: yield* readDb.select().from(DirectoryMaintenanceGuardTable).all().pipe(Effect.orDie),
            owners: yield* readDb.select().from(SessionExecutionOwnerTable).all().pipe(Effect.orDie),
          }
        }).pipe(Effect.scoped, Effect.provide(graph())),
      )
      const activeGuards = persisted.guards.filter(
        (row) => row.state !== "released" && (row.directory === alphaKey || row.directory === bravoKey),
      )
      const heldOwners = persisted.owners.filter((row) => row.session_id === sessionID && row.owner_id !== null)
      expect(activeGuards.length === 0 || heldOwners.length === 0).toBe(true)
      if (ownerResult.state === "acquired") expect(activeGuards).toHaveLength(0)
      if (guardResult.state === "acquired") expect(heldOwners).toHaveLength(0)

      if (ownerResult.state === "acquired") {
        const token = ownerResult.token
        const retried = await Effect.runPromise(
          Effect.gen(function* () {
            const owner = yield* SessionExecutionOwner.Service
            const guards = yield* DirectoryMaintenanceGuard.Service
            expect(yield* owner.release(token)).toBe("released")
            return yield* guards.acquire({ guardId: "guard-g2-race-retry", directories: [alpha, bravo] })
          }).pipe(Effect.scoped, Effect.provide(graph())),
        )
        expect(retried.state).toBe("acquired")
      } else {
        if (guardResult.state !== "acquired") throw new Error("expected a guard winner")
        const token = guardResult.token
        const retried = await Effect.runPromise(
          Effect.gen(function* () {
            const guards = yield* DirectoryMaintenanceGuard.Service
            const owner = yield* SessionExecutionOwner.Service
            expect(yield* guards.release(token)).toBe("released")
            return yield* owner.tryAcquire(sessionID)
          }).pipe(Effect.scoped, Effect.provide(graph())),
        )
        expect(retried.state).toBe("acquired")
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.effect("physical alias identity collapses alias, case, and separator spellings in both directions", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const alpha = ws.dir("alpha")
        const bravo = ws.dir("bravo")
        const alias = ws.dir("alpha-alias")
        yield* makeDirs(alpha, bravo)
        yield* aliasTo(alpha, alias)
        const aliasSpelling = process.platform === "win32" ? alias.replaceAll("\\", "/").toUpperCase() : alias
        const sessionID = SessionSchema.ID.make("ses_g2_alias")
        yield* seedProjectAndSession(sessionID, aliasSpelling)
        const storedDirectory = yield* Database.Service.use(({ db }) =>
          db
            .select({ directory: SessionTable.directory })
            .from(SessionTable)
            .where(eq(SessionTable.id, sessionID))
            .get()
            .pipe(Effect.orDie),
        )
        if (!storedDirectory) return yield* Effect.die("expected a stored session directory")
        expect(DirectoryMaintenanceGuard.existingDirectoryKey(storedDirectory.directory, process.platform)).toBe(
          physicalKey(alpha),
        )
        const guards = yield* DirectoryMaintenanceGuard.Service
        const owner = yield* SessionExecutionOwner.Service
        const guard = requireGuardToken(yield* guards.acquire({ guardId: "guard-g2-alias", directories: [alpha, bravo] }))

        const blocked = yield* owner.tryAcquire(sessionID)
        expect(blocked).toMatchObject({
          state: "maintenance-blocked",
          reason: "guard-active",
          directoryKey: physicalKey(alpha),
          guards: [{ directory: physicalKey(alpha), guardId: "guard-g2-alias", state: "active" }],
        })
        if (blocked.state !== "maintenance-blocked") return yield* Effect.die("expected a guard-active block")
        expect(DirectoryMaintenanceGuard.existingDirectoryKey(blocked.directory ?? "", process.platform)).toBe(
          physicalKey(alpha),
        )
        expect(yield* executionOwnerRows(sessionID)).toHaveLength(0)

        expect(yield* guards.release(guard)).toBe("released")
        const execution = yield* owner.tryAcquire(sessionID)
        expect(execution.state).toBe("acquired")
        if (execution.state !== "acquired") return

        expect(yield* guards.acquire({ guardId: "guard-g2-alias-reverse", directories: [alpha, bravo] })).toEqual({
          state: "blocked",
          blocked: [],
          activityLeases: [],
          executing: [
            {
              sessionID,
              ownerID: execution.token.ownerID,
              generation: execution.token.generation,
              persistedDirectory: storedDirectory.directory,
              directory: physicalKey(alpha),
            },
          ],
        })
        expect(yield* owner.release(execution.token)).toBe("released")
        const retry = requireGuardToken(
          yield* guards.acquire({ guardId: "guard-g2-alias-retry", directories: [alpha, bravo] }),
        )
        expect(yield* guards.release(retry)).toBe("released")
      }),
    ),
  )

  it.effect("fail-closed: an unresolvable session directory blocks under any held guard", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const alpha = ws.dir("alpha")
        const bravo = ws.dir("bravo")
        const missing = ws.dir("missing")
        yield* makeDirs(alpha, bravo)
        const sessionID = SessionSchema.ID.make("ses_g2_unresolvable_session")
        yield* seedProjectAndSession(sessionID, missing)
        const guards = yield* DirectoryMaintenanceGuard.Service
        const owner = yield* SessionExecutionOwner.Service
        requireGuardToken(yield* guards.acquire({ guardId: "guard-g2-unresolvable", directories: [alpha, bravo] }))

        expect(yield* owner.tryAcquire(sessionID)).toEqual({
          state: "maintenance-blocked",
          reason: "directory-unresolvable",
          sessionID,
          directory: missing,
          directoryKey: null,
          guards: [],
        })
        expect(yield* executionOwnerRows(sessionID)).toHaveLength(0)
      }),
    ),
  )

  it.effect("fail-closed: an unresolvable active execution blocks guard acquisition", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const alpha = ws.dir("alpha")
        const bravo = ws.dir("bravo")
        const missing = ws.dir("missing")
        yield* makeDirs(alpha, bravo)
        const sessionID = SessionSchema.ID.make("ses_g2_unresolvable_execution")
        yield* seedProjectAndSession(sessionID, missing)
        yield* seedOwners(foreignOwnerID)
        yield* seedExecutionOwner({ sessionID, ownerID: foreignOwnerID, generation: 5 })
        const guards = yield* DirectoryMaintenanceGuard.Service

        expect(yield* guards.acquire({ guardId: "guard-g2-unresolvable-exec", directories: [alpha, bravo] })).toEqual({
          state: "blocked",
          blocked: [],
          activityLeases: [],
          executing: [
            {
              sessionID,
              ownerID: foreignOwnerID,
              generation: 5,
              persistedDirectory: missing,
              directory: null,
            },
          ],
        })
        expect(yield* guardRows()).toHaveLength(0)
      }),
    ),
  )

  it.effect("an unrelated held guard does not falsely block a resolvable session", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const alpha = ws.dir("alpha")
        const bravo = ws.dir("bravo")
        const charlie = ws.dir("charlie")
        yield* makeDirs(alpha, bravo, charlie)
        const sessionID = SessionSchema.ID.make("ses_g2_unrelated")
        yield* seedProjectAndSession(sessionID, charlie)
        const guards = yield* DirectoryMaintenanceGuard.Service
        const owner = yield* SessionExecutionOwner.Service
        const guard = requireGuardToken(
          yield* guards.acquire({ guardId: "guard-g2-unrelated", directories: [alpha, bravo] }),
        )

        const acquired = yield* owner.tryAcquire(sessionID)
        expect(acquired.state).toBe("acquired")
        if (acquired.state !== "acquired") return
        expect(acquired.token.generation).toBe(1)
        expect((yield* guardRows()).every((row) => row.state === "active")).toBe(true)
        expect(yield* owner.release(acquired.token)).toBe("released")
        expect(yield* guards.release(guard)).toBe("released")
      }),
    ),
  )

  test("repeated maintenance-blocked attempts leak neither durable owner state nor retention", async () => {
    const root = await mkdtemp(join(tmpdir(), "openfork-execution-maintenance-retention-"))
    const alpha = join(root, "alpha")
    const bravo = join(root, "bravo")
    const sessionID = SessionSchema.ID.make("ses_g2_retention")
    const counters: Counters = { retains: 0, releases: 0 }
    try {
      await Promise.all([alpha, bravo].map((directory) => mkdir(directory)))
      const outcome = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* seedProjectAndSession(sessionID, alpha)
            yield* seedOwners(currentRuntimeID)
            const guards = yield* DirectoryMaintenanceGuard.Service
            const owner = yield* SessionExecutionOwner.Service
            const guard = requireGuardToken(
              yield* guards.acquire({ guardId: "guard-g2-retention", directories: [alpha, bravo] }),
            )

            const blocked: Array<SessionExecutionOwner.AcquireResult> = []
            for (let attempt = 0; attempt < 5; attempt++) blocked.push(yield* owner.tryAcquire(sessionID))
            const owners = yield* executionOwnerRows(sessionID)
            const afterBlocked = { ...counters }

            expect(yield* guards.release(guard)).toBe("released")
            const admitted = yield* owner.tryAcquire(sessionID)
            if (admitted.state !== "acquired") return yield* Effect.die("expected admission after guard release")
            expect(yield* owner.release(admitted.token)).toBe("released")
            return { blocked, owners, afterBlocked, admitted, final: { ...counters } }
          }).pipe(Effect.provide(countingLayer(counters))),
        ),
      )

      expect(outcome.blocked.map((result) => result.state)).toEqual(Array(5).fill("maintenance-blocked"))
      expect(
        outcome.blocked.every((result) => result.state === "maintenance-blocked" && result.reason === "guard-active"),
      ).toBe(true)
      expect(outcome.owners).toHaveLength(0)
      expect(outcome.afterBlocked).toEqual({ retains: 6, releases: 5 })
      expect(outcome.admitted.token.generation).toBe(1)
      expect(outcome.final).toEqual({ retains: 7, releases: 7 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
