import { describe, expect, test } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { DirectoryMaintenanceGuard } from "@opencode-ai/core/directory-maintenance-guard"
import { DirectoryMaintenanceGuardTable } from "@opencode-ai/core/directory-maintenance-guard.sql"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { RuntimeOwner } from "@opencode-ai/core/runtime-owner"
import { RuntimeOwnerTable } from "@opencode-ai/core/runtime-owner.sql"
import { testEffect } from "./lib/effect"

const layer = AppNodeBuilder.build(
  LayerNode.group([Database.node, RuntimeOwner.node, DirectoryMaintenanceGuard.node]),
  [[Database.node, Database.layerFromPath(":memory:")]],
)
const it = testEffect(layer)

const currentRuntimeID = "runtime-owner:guard-current" as RuntimeOwner.ID
const deadOwnerID = "runtime-owner:guard-dead" as RuntimeOwner.ID
const liveOwnerID = "runtime-owner:guard-live" as RuntimeOwner.ID
const unknownOwnerID = "runtime-owner:guard-unknown" as RuntimeOwner.ID
const foreignOwnerID = "runtime-owner:guard-foreign" as RuntimeOwner.ID

const fakeRuntimeLayer = Layer.succeed(
  RuntimeOwner.Service,
  RuntimeOwner.Service.of({
    id: currentRuntimeID,
    pid: 999_001,
    startedAt: 1,
    retain: Effect.succeed({ release: Effect.void }),
    snapshot: (id) =>
      Effect.succeed({ id, pid: 999_001, startedAt: 1, heartbeatAt: 1, controlEpoch: 0 }),
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
  AppNodeBuilder.build(
    LayerNode.group([Database.node, RuntimeOwner.node, DirectoryMaintenanceGuard.node]),
    [
      [Database.node, Database.layerFromPath(":memory:")],
      [RuntimeOwner.node, fakeRuntimeLayer],
    ],
  ),
)

const NAMES = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"] as const

type DirectoryKey = DirectoryMaintenanceGuard.DirectoryKey
type Token = DirectoryMaintenanceGuard.Token
type AcquisitionID = DirectoryMaintenanceGuard.AcquisitionID

const physicalKey = (path: string): DirectoryKey => {
  const key = DirectoryMaintenanceGuard.existingDirectoryKey(path, process.platform)
  if (key === undefined) throw new Error(`expected an existing physical directory key for ${path}`)
  return key
}

// The runtime mints acquisition ids internally and exports no branded
// constructor; token fixtures for externally seeded acquisitions funnel every
// cast through this one checked helper instead of scattering `as AcquisitionID`.
const acquisitionID = (value: string): AcquisitionID => {
  if (value.length === 0) throw new Error("expected a non-empty acquisition id")
  return value as AcquisitionID
}

interface Workspace {
  readonly root: string
  readonly dir: (name: string) => string
  readonly key: (path: string) => DirectoryKey
}

const withWorkspace = <A, E, R>(body: (workspace: Workspace) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "openfork-directory-guard-")))
    yield* Effect.addFinalizer(() => Effect.promise(() => rm(root, { recursive: true, force: true })))
    const dir = (name: string) => join(root, name)
    yield* Effect.promise(() => Promise.all(NAMES.map((name) => mkdir(dir(name), { recursive: true }))))
    return yield* body({ root, dir, key: physicalKey })
  })

const seedOwners = (...ids: RuntimeOwner.ID[]) =>
  Database.Service.use(({ db }) =>
    db
      .insert(RuntimeOwnerTable)
      .values(ids.map((id, index) => ({ id, pid: 500_000 + index, started_at: 1, heartbeat_at: 1, control_epoch: 0 })))
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie),
  )

const seedHold = (input: {
  directory: string
  guardId: string
  ownerID: RuntimeOwner.ID
  acquisitionId?: string
  generation?: number
  state?: "active" | "released" | "reconcile_required"
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

const rows = () =>
  Database.Service.use(({ db }) => db.select().from(DirectoryMaintenanceGuardTable).all().pipe(Effect.orDie))

const row = (directory: string) =>
  Database.Service.use(({ db }) =>
    db
      .select()
      .from(DirectoryMaintenanceGuardTable)
      .where(eq(DirectoryMaintenanceGuardTable.directory, directory))
      .get()
      .pipe(Effect.orDie),
  )

const acquisitionRows = (acquisitionId: string) =>
  Database.Service.use(({ db }) =>
    db
      .select()
      .from(DirectoryMaintenanceGuardTable)
      .where(eq(DirectoryMaintenanceGuardTable.acquisition_id, acquisitionId))
      .all()
      .pipe(Effect.orDie),
  )

const markReleased = (directory: string) =>
  Database.Service.use(({ db }) =>
    db
      .update(DirectoryMaintenanceGuardTable)
      .set({ state: "released", released_at: Date.now(), updated_at: Date.now() })
      .where(eq(DirectoryMaintenanceGuardTable.directory, directory))
      .run()
      .pipe(Effect.orDie),
  )

// Production SQLite triggers make raw guard-row corruption impossible, so the
// few health fixtures that deliberately simulate below-trigger drift drop the
// trigger pair for their own test database only. Trigger rejection itself is
// asserted separately.
const dropAuthorityTriggers = () =>
  Database.Service.use(({ db }) =>
    Effect.forEach(
      ["directory_maintenance_guard_no_delete", "directory_maintenance_guard_authority_update"],
      (name) => db.run(sql`DROP TRIGGER IF EXISTS ${sql.identifier(name)}`),
    ).pipe(Effect.asVoid, Effect.orDie),
  )

const sorted = (keys: ReadonlyArray<DirectoryKey>) => [...keys].sort()

describe("DirectoryMaintenanceGuard lexical keys", () => {
  const win = (value: string) => DirectoryMaintenanceGuard.lexicalDirectoryKey(value, "win32")
  const posix = (value: string) => DirectoryMaintenanceGuard.lexicalDirectoryKey(value, "linux")

  test("folds Windows case, separators, dot segments, and trailing separators into one identity", () => {
    expect(win("C:\\Repos\\OpenFork")).toBe(win("c:/repos/openfork/"))
    expect(win("C:\\repo\\a\\..\\b")).toBe(win("c:/repo/b/"))
    expect(win("C:/repo//b")).toBe(win("c:/repo/b"))
    expect(win("C:/repo/b/./")).toBe(win("c:/repo/b"))
    expect(String(win("C:\\"))).toBe("c:/")
    expect(win("C:/repo/b/../..")).toBe(win("C:/"))
  })

  test("rejects Windows forms that are not fully qualified", () => {
    // Root-relative and drive-relative forms resolve against ambient process
    // state, not filesystem identity.
    expect(win("/foo")).toBeUndefined()
    expect(win("C:foo")).toBeUndefined()
    expect(win("relative/path")).toBeUndefined()
    expect(win("//server")).toBeUndefined()
    expect(win("\\\\?\\C:\\repo")).toBeUndefined()
    expect(win("\\\\.\\pipe\\x")).toBeUndefined()
    // `..` clamps at the share root under node:path win32 semantics.
    expect(win("//server/share/..")).toBe(win("//server/share"))
    expect(win("//server/share/../..")).toBe(win("//server/share"))
  })

  test("normalizes UNC aliases consistently", () => {
    expect(win("\\\\server\\share\\repo\\.\\a\\..\\b")).toBe(win("//SERVER/SHARE/REPO/b/"))
    expect(win("//server/share")).toBe(win("\\\\server\\share\\"))
    expect(String(win("//server/share"))).toBe("//server/share/")
  })

  test("normalizes POSIX dot segments and repeated separators while preserving case", () => {
    expect(posix("/ws/a/../b/./")).toBe(posix("/ws/b"))
    expect(posix("/ws//b")).toBe(posix("/ws/b"))
    expect(String(posix("/"))).toBe("/")
    expect(String(posix("/ws/alpha/"))).toBe("/ws/alpha")
    expect(posix("relative/path")).toBeUndefined()
    expect(posix("")).toBeUndefined()
    // POSIX filesystems are case-sensitive: folding there would merge distinct
    // directories rather than prevent split brain.
    expect(posix("/Repos/OpenFork")).not.toBe(posix("/repos/openfork"))
  })
})

describe("DirectoryMaintenanceGuard physical identity", () => {
  const strict = (value: string) => DirectoryMaintenanceGuard.existingDirectoryKey(value, process.platform)

  test("rejects relative paths, missing directories, and files instead of lexical fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "openfork-directory-guard-identity-"))
    try {
      expect(strict("relative/path")).toBeUndefined()
      expect(strict("")).toBeUndefined()
      expect(strict(join(root, "missing"))).toBeUndefined()

      const file = join(root, "archive.txt")
      await writeFile(file, "not a directory")
      expect(strict(file)).toBeUndefined()

      const existing = join(root, "alpha")
      await mkdir(existing)
      expect(strict(existing)).toBe(physicalKey(existing))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  if (process.platform === "win32") {
    test("rejects root-relative, drive-relative, and device-namespace Windows forms", () => {
      expect(strict("/foo")).toBeUndefined()
      expect(strict("C:foo")).toBeUndefined()
      expect(strict("//server")).toBeUndefined()
      expect(strict("\\\\?\\C:\\repo")).toBeUndefined()
      expect(strict("\\\\.\\pipe\\x")).toBeUndefined()
    })
  }

  it.effect("collapses a junction/symlink alias onto the physical directory identity", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const alias = join(ws.root, "alpha-alias")
        yield* Effect.promise(() =>
          symlink(ws.dir("alpha"), alias, process.platform === "win32" ? "junction" : "dir"),
        )
        // The alias and its target must be one durable identity, not two.
        expect(ws.key(alias)).toBe(ws.key(ws.dir("alpha")))

        const guards = yield* DirectoryMaintenanceGuard.Service
        const duplicate = yield* guards
          .acquire({ guardId: "guard-alias", directories: [ws.dir("alpha"), alias] })
          .pipe(Effect.flip)
        expect(duplicate).toBeInstanceOf(DirectoryMaintenanceGuard.DuplicateDirectoryError)

        const acquired = yield* guards.acquire({ guardId: "guard-alias-2", directories: [alias, ws.dir("bravo")] })
        expect(acquired.state).toBe("acquired")
        if (acquired.state !== "acquired") return
        expect(acquired.token.directories).toEqual(sorted([ws.key(ws.dir("alpha")), ws.key(ws.dir("bravo"))]))
        expect(yield* guards.assertHealthy(acquired.token)).toEqual({ state: "healthy" })
        expect(yield* guards.release(acquired.token)).toBe("released")
      }),
    ),
  )

  it.effect("rejects acquisition input that cannot be proven as an existing physical directory", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const guards = yield* DirectoryMaintenanceGuard.Service
        const missing = yield* guards
          .acquire({ guardId: "guard-missing", directories: [ws.dir("alpha"), join(ws.root, "absent")] })
          .pipe(Effect.flip)
        expect(missing).toBeInstanceOf(DirectoryMaintenanceGuard.InvalidDirectoryError)
        expect((missing as DirectoryMaintenanceGuard.InvalidDirectoryError).directory).toBe(join(ws.root, "absent"))

        const file = join(ws.root, "not-a-directory.txt")
        yield* Effect.promise(() => writeFile(file, "file"))
        const notDirectory = yield* guards
          .acquire({ guardId: "guard-file", directories: [ws.dir("alpha"), file] })
          .pipe(Effect.flip)
        expect(notDirectory).toBeInstanceOf(DirectoryMaintenanceGuard.InvalidDirectoryError)

        expect(yield* rows()).toHaveLength(0)
      }),
    ),
  )
})

describe("DirectoryMaintenanceGuard acquisition", () => {
  it.effect("acquires two directories atomically under one guard and retains the runtime owner", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const runtime = yield* RuntimeOwner.Service
        const guards = yield* DirectoryMaintenanceGuard.Service

        const result = yield* guards.acquire({
          guardId: "guard-two",
          directories: [ws.dir("bravo"), ws.dir("alpha")],
        })
        expect(result.state).toBe("acquired")
        if (result.state !== "acquired") return
        const token = result.token
        expect(token.guardId).toBe("guard-two")
        expect(token.ownerID).toBe(runtime.id)
        expect(token.generation).toBe(1)
        expect(token.directories).toEqual(sorted([ws.key(ws.dir("alpha")), ws.key(ws.dir("bravo"))]))
        expect(token.acquisitionId.length).toBeGreaterThan(0)

        const persisted = yield* rows()
        expect(persisted).toHaveLength(2)
        for (const entry of persisted) {
          expect(entry).toMatchObject({
            guard_id: "guard-two",
            owner_id: runtime.id,
            acquisition_id: token.acquisitionId,
            generation: 1,
            state: "active",
            released_at: null,
          })
          expect(entry.acquired_at).toBeGreaterThan(0)
          expect(entry.updated_at).toBeGreaterThan(0)
        }
        expect(persisted.map((entry) => entry.directory).sort()).toEqual(sorted(token.directories))

        // Acquiring durable authority must retain the owner row/heartbeat.
        expect(yield* runtime.snapshot(runtime.id)).toMatchObject({ id: runtime.id, pid: process.pid })
        expect(yield* guards.assertHealthy(token)).toEqual({ state: "healthy" })
        expect(yield* guards.release(token)).toBe("released")
      }),
    ),
  )

  it.effect("blocks the whole acquisition when any directory is held, with no partial writes", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        yield* seedOwners(foreignOwnerID)
        yield* seedHold({ directory: ws.key(ws.dir("alpha")), guardId: "guard-foreign", ownerID: foreignOwnerID })
        const guards = yield* DirectoryMaintenanceGuard.Service

        const result = yield* guards.acquire({ guardId: "guard-new", directories: [ws.dir("alpha"), ws.dir("bravo")] })
        expect(result).toEqual({
          state: "blocked",
          blocked: [
            {
              directory: ws.key(ws.dir("alpha")),
              guardId: "guard-foreign",
              ownerID: foreignOwnerID,
              acquisitionId: acquisitionID("directory-maintenance:seed-guard-foreign"),
              generation: 1,
              state: "active",
            },
          ],
          activityLeases: [],
          executing: [],
        })
        expect(yield* row(ws.key(ws.dir("bravo")))).toBeUndefined()
        expect(yield* row(ws.key(ws.dir("alpha")))).toMatchObject({
          guard_id: "guard-foreign",
          owner_id: foreignOwnerID,
          state: "active",
        })
      }),
    ),
  )

  it.effect("preserves each blocker's acquisition identity when two requested directories are held separately", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        yield* seedOwners(foreignOwnerID)
        yield* seedHold({
          directory: ws.key(ws.dir("alpha")),
          guardId: "guard-foreign-a",
          ownerID: foreignOwnerID,
          acquisitionId: "blocker-acquisition-a",
          generation: 3,
        })
        yield* seedHold({
          directory: ws.key(ws.dir("bravo")),
          guardId: "guard-foreign-b",
          ownerID: foreignOwnerID,
          acquisitionId: "blocker-acquisition-b",
          generation: 7,
        })
        const guards = yield* DirectoryMaintenanceGuard.Service

        // Two requested directories, two unrelated holders: the blocked
        // evidence must keep both authoritative blocker identities instead of
        // collapsing them into one guard/owner-shaped entry.
        const result = yield* guards.acquire({ guardId: "guard-new", directories: [ws.dir("alpha"), ws.dir("bravo")] })
        expect(result).toEqual({
          state: "blocked",
          blocked: [
            {
              directory: ws.key(ws.dir("alpha")),
              guardId: "guard-foreign-a",
              ownerID: foreignOwnerID,
              acquisitionId: acquisitionID("blocker-acquisition-a"),
              generation: 3,
              state: "active",
            },
            {
              directory: ws.key(ws.dir("bravo")),
              guardId: "guard-foreign-b",
              ownerID: foreignOwnerID,
              acquisitionId: acquisitionID("blocker-acquisition-b"),
              generation: 7,
              state: "active",
            },
          ],
          activityLeases: [],
          executing: [],
        })
        expect((yield* rows()).map((entry) => entry.guard_id).sort()).toEqual(["guard-foreign-a", "guard-foreign-b"])
      }),
    ),
  )

  it.effect("blocks a second overlapping acquisition from the same owner while the first guard is active", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const guards = yield* DirectoryMaintenanceGuard.Service
        const first = yield* guards.acquire({ guardId: "guard-first", directories: [ws.dir("alpha"), ws.dir("bravo")] })
        expect(first.state).toBe("acquired")

        const second = yield* guards.acquire({
          guardId: "guard-second",
          directories: [ws.dir("alpha"), ws.dir("charlie")],
        })
        expect(second.state).toBe("blocked")
        if (second.state !== "blocked") return
        expect(second.blocked.map((entry) => entry.directory)).toEqual([ws.key(ws.dir("alpha"))])
        expect(yield* row(ws.key(ws.dir("charlie")))).toBeUndefined()
      }),
    ),
  )

  it.effect("keeps multiple disjoint acquisitions under one guard id and owner fully independent", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const guards = yield* DirectoryMaintenanceGuard.Service
        const first = yield* guards.acquire({
          guardId: "guard-shared",
          directories: [ws.dir("alpha"), ws.dir("bravo")],
        })
        const second = yield* guards.acquire({
          guardId: "guard-shared",
          directories: [ws.dir("charlie"), ws.dir("delta")],
        })
        if (first.state !== "acquired" || second.state !== "acquired") {
          return yield* Effect.die("expected both disjoint acquisitions to succeed")
        }
        expect(second.token.acquisitionId).not.toBe(first.token.acquisitionId)
        expect(second.token.ownerID).toBe(first.token.ownerID)
        expect(yield* guards.assertHealthy(first.token)).toEqual({ state: "healthy" })
        expect(yield* guards.assertHealthy(second.token)).toEqual({ state: "healthy" })

        // One token must never affect the other acquisition.
        expect(yield* guards.release(first.token)).toBe("released")
        expect(yield* guards.assertHealthy(second.token)).toEqual({ state: "healthy" })
        expect((yield* acquisitionRows(second.token.acquisitionId)).every((entry) => entry.state === "active")).toBe(
          true,
        )
        expect((yield* acquisitionRows(first.token.acquisitionId)).every((entry) => entry.state === "released")).toBe(
          true,
        )
        expect(yield* guards.release(second.token)).toBe("released")
      }),
    ),
  )

  it.effect("reuses released rows for a new guard instead of inserting duplicates", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const guards = yield* DirectoryMaintenanceGuard.Service
        const first = yield* guards.acquire({ guardId: "guard-one", directories: [ws.dir("alpha"), ws.dir("bravo")] })
        if (first.state !== "acquired") return yield* Effect.die("expected first acquisition")
        expect(yield* guards.release(first.token)).toBe("released")

        const released = yield* rows()
        expect(released).toHaveLength(2)
        for (const entry of released) {
          expect(entry.state).toBe("released")
          expect(entry.released_at).not.toBeNull()
          expect(entry.guard_id).toBe("guard-one")
        }

        const second = yield* guards.acquire({ guardId: "guard-two", directories: [ws.dir("bravo"), ws.dir("alpha")] })
        expect(second.state).toBe("acquired")
        if (second.state !== "acquired") return
        expect(second.token.generation).toBe(first.token.generation + 1)
        expect(second.token.acquisitionId).not.toBe(first.token.acquisitionId)

        const reused = yield* rows()
        expect(reused).toHaveLength(2)
        for (const entry of reused) {
          expect(entry).toMatchObject({
            guard_id: "guard-two",
            acquisition_id: second.token.acquisitionId,
            generation: second.token.generation,
            state: "active",
            released_at: null,
          })
        }
        expect(yield* guards.assertHealthy(second.token)).toEqual({ state: "healthy" })
      }),
    ),
  )

  it.effect("reuses released rows whose generations diverged across acquisitions", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const guards = yield* DirectoryMaintenanceGuard.Service
        const first = yield* guards.acquire({
          guardId: "guard-diverge-one",
          directories: [ws.dir("alpha"), ws.dir("bravo")],
        })
        if (first.state !== "acquired") return yield* Effect.die("expected first acquisition")
        expect(yield* guards.release(first.token)).toBe("released")

        const second = yield* guards.acquire({
          guardId: "guard-diverge-two",
          directories: [ws.dir("alpha"), ws.dir("charlie")],
        })
        if (second.state !== "acquired") return yield* Effect.die("expected second acquisition")
        expect(second.token.generation).toBe(first.token.generation + 1)
        expect(yield* guards.release(second.token)).toBe("released")

        // bravo is still generation 1 while charlie is generation 2, so the
        // third acquisition publishes max(1, 2) + 1 = 3: bravo jumps by two.
        // That is service-legal reuse, so a durable trigger must require a
        // strictly newer generation, not exactly OLD.generation + 1.
        const third = yield* guards.acquire({
          guardId: "guard-diverge-three",
          directories: [ws.dir("bravo"), ws.dir("charlie")],
        })
        if (third.state !== "acquired") return yield* Effect.die("expected third acquisition")
        expect(third.token.generation).toBe(second.token.generation + 1)
        expect(yield* row(ws.key(ws.dir("bravo")))).toMatchObject({
          guard_id: "guard-diverge-three",
          acquisition_id: third.token.acquisitionId,
          generation: third.token.generation,
          state: "active",
          released_at: null,
        })
        expect(yield* row(ws.key(ws.dir("charlie")))).toMatchObject({
          acquisition_id: third.token.acquisitionId,
          generation: third.token.generation,
          state: "active",
        })
        expect(yield* guards.assertHealthy(third.token)).toEqual({ state: "healthy" })
        expect(yield* guards.release(third.token)).toBe("released")
      }),
    ),
  )

  it.effect("never lets a stale handle reach a newer acquisition that reused the same guard id", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const guards = yield* DirectoryMaintenanceGuard.Service
        const first = yield* guards.acquire({ guardId: "guard-reused", directories: [ws.dir("alpha"), ws.dir("bravo")] })
        if (first.state !== "acquired") return yield* Effect.die("expected first acquisition")
        expect(yield* guards.release(first.token)).toBe("released")

        // The guard id is caller-supplied and therefore repeatable; the durable
        // acquisition identity is what keeps the previous handle from fencing
        // the newer acquisition.
        const second = yield* guards.acquire({ guardId: "guard-reused", directories: [ws.dir("alpha"), ws.dir("bravo")] })
        if (second.state !== "acquired") return yield* Effect.die("expected second acquisition")
        expect(second.token.ownerID).toBe(first.token.ownerID)
        expect(second.token.generation).toBe(first.token.generation + 1)
        expect(second.token.acquisitionId).not.toBe(first.token.acquisitionId)

        expect(yield* guards.release(first.token)).toBe("stale")
        expect(yield* guards.assertHealthy(first.token)).toEqual({
          state: "unhealthy",
          issues: [
            { directory: first.token.directories[0]!, reason: "foreign-acquisition" },
            { directory: first.token.directories[1]!, reason: "foreign-acquisition" },
          ],
        })
        expect(yield* guards.assertHealthy(second.token)).toEqual({ state: "healthy" })
        expect((yield* rows()).every((entry) => entry.state === "active")).toBe(true)
        expect(yield* guards.release(second.token)).toBe("released")
        expect(yield* guards.release(second.token)).toBe("stale")
      }),
    ),
  )

  it.effect("cancels an exact release when even one expected row mismatches", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const guards = yield* DirectoryMaintenanceGuard.Service
        const acquired = yield* guards.acquire({ guardId: "guard-partial", directories: [ws.dir("alpha"), ws.dir("bravo")] })
        if (acquired.state !== "acquired") return yield* Effect.die("expected acquisition")
        const { db } = yield* Database.Service
        // This fixture injects identity drift on purpose; production triggers
        // reject it, so drop them for this test database only.
        yield* dropAuthorityTriggers()
        yield* db
          .update(DirectoryMaintenanceGuardTable)
          .set({ guard_id: "guard-foreign" })
          .where(eq(DirectoryMaintenanceGuardTable.directory, ws.key(ws.dir("bravo"))))
          .run()
          .pipe(Effect.orDie)

        expect(yield* guards.release(acquired.token)).toBe("stale")
        expect(yield* row(ws.key(ws.dir("alpha")))).toMatchObject({
          guard_id: "guard-partial",
          state: "active",
          released_at: null,
        })
        expect(yield* row(ws.key(ws.dir("bravo")))).toMatchObject({ guard_id: "guard-foreign", state: "active" })
      }),
    ),
  )
})

describe("DirectoryMaintenanceGuard exact token integrity", () => {
  it.effect(
    "rejects subset, superset, empty, duplicate, forged, and non-canonical token sets with zero durable changes",
    () =>
      withWorkspace((ws) =>
        Effect.gen(function* () {
          const guards = yield* DirectoryMaintenanceGuard.Service
          const acquired = yield* guards.acquire({
            guardId: "guard-exact",
            directories: [ws.dir("alpha"), ws.dir("bravo")],
          })
          if (acquired.state !== "acquired") return yield* Effect.die("expected acquisition")
          const token = acquired.token
          const [alpha, bravo] = token.directories as [DirectoryKey, DirectoryKey]
          const charlie = ws.key(ws.dir("charlie"))

          const attempt = (directories: ReadonlyArray<DirectoryKey>) => guards.release({ ...token, directories })
          const forged = (acquisitionId: string) =>
            guards.release({ ...token, acquisitionId: acquisitionID(acquisitionId) })

          expect(yield* attempt([alpha])).toBe("stale") // truncated
          expect(yield* attempt([alpha, bravo, charlie])).toBe("stale") // extended
          expect(yield* attempt([])).toBe("stale") // empty
          expect(yield* attempt([alpha, alpha])).toBe("stale") // duplicate
          expect(yield* attempt([`${alpha}/` as DirectoryKey, bravo])).toBe("stale") // non-canonical
          expect(yield* forged("directory-maintenance:not-mine")).toBe("stale") // forged identity

          const persisted = yield* acquisitionRows(token.acquisitionId)
          expect(persisted).toHaveLength(2)
          expect(persisted.every((entry) => entry.state === "active" && entry.released_at === null)).toBe(true)

          expect(yield* attempt([alpha, charlie])).toBe("stale") // forged replacement
          expect(yield* guards.assertHealthy({ ...token, directories: [alpha] })).toEqual({
            state: "unhealthy",
            issues: [{ directory: alpha, reason: "malformed-token" }],
          })
          expect(yield* guards.assertHealthy({ ...token, directories: sorted([alpha, charlie]) })).toEqual({
            state: "unhealthy",
            issues: [
              { directory: bravo, reason: "directory-set-mismatch" },
              { directory: charlie, reason: "missing" },
            ],
          })
          expect(yield* guards.assertHealthy({ ...token, directories: [alpha, bravo, charlie] })).toEqual({
            state: "unhealthy",
            issues: [{ directory: charlie, reason: "missing" }],
          })
          expect(yield* guards.assertHealthy({ ...token, directories: [] })).toEqual({
            state: "unhealthy",
            issues: [{ directory: "" as DirectoryKey, reason: "malformed-token" }],
          })
          expect(yield* guards.assertHealthy({ ...token, directories: [alpha, alpha] })).toEqual({
            state: "unhealthy",
            issues: [{ directory: alpha, reason: "malformed-token" }],
          })
          expect(yield* guards.assertHealthy({ ...token, directories: [`${alpha}/` as DirectoryKey, bravo] })).toEqual(
            {
              state: "unhealthy",
              issues: [{ directory: `${alpha}/` as DirectoryKey, reason: "malformed-token" }],
            },
          )
          expect(yield* guards.assertHealthy({ ...token, acquisitionId: acquisitionID("directory-maintenance:not-mine") }))
            .toEqual({
              state: "unhealthy",
              issues: [
                { directory: alpha, reason: "foreign-acquisition" },
                { directory: bravo, reason: "foreign-acquisition" },
              ],
            })
          expect(yield* guards.assertHealthy({ ...token, guardId: " guard-exact" })).toEqual({
            state: "unhealthy",
            issues: [{ directory: alpha, reason: "malformed-token" }],
          })

          // Reordering is the only normalization: membership must still equal
          // the exact acquisition row set.
          expect(yield* guards.release({ ...token, directories: [bravo, alpha] })).toBe("released")
          expect((yield* acquisitionRows(token.acquisitionId)).every((entry) => entry.state === "released")).toBe(true)
        }),
      ),
  )
})

describe("DirectoryMaintenanceGuard health", () => {
  it.effect("reports every exact-identity mismatch reason", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const guards = yield* DirectoryMaintenanceGuard.Service
        const { db } = yield* Database.Service
        yield* seedOwners(foreignOwnerID)
        // This fixture deliberately simulates below-trigger identity drift so
        // assertHealthy's detection is exercised; production triggers reject
        // exactly these writes, and their rejection is asserted in the durable
        // authority trigger tests. Missing-row coverage uses a separate
        // seeded-absence fixture and never deletes a production row.
        yield* dropAuthorityTriggers()
        const acquired = yield* guards.acquire({ guardId: "guard-health", directories: [ws.dir("alpha"), ws.dir("bravo")] })
        if (acquired.state !== "acquired") return yield* Effect.die("expected acquisition")
        const bravo = ws.key(ws.dir("bravo"))
        expect(yield* guards.assertHealthy(acquired.token)).toEqual({ state: "healthy" })

        const update = (values: Partial<typeof DirectoryMaintenanceGuardTable.$inferInsert>) =>
          db
            .update(DirectoryMaintenanceGuardTable)
            .set(values)
            .where(eq(DirectoryMaintenanceGuardTable.directory, bravo))
            .run()
            .pipe(Effect.orDie)

        yield* update({ state: "released", released_at: 1 })
        expect(yield* guards.assertHealthy(acquired.token)).toEqual({
          state: "unhealthy",
          issues: [{ directory: bravo, reason: "released" }],
        })

        yield* update({ state: "active", released_at: null, guard_id: "guard-other" })
        expect(yield* guards.assertHealthy(acquired.token)).toEqual({
          state: "unhealthy",
          issues: [{ directory: bravo, reason: "foreign-guard" }],
        })

        yield* update({ guard_id: "guard-health", owner_id: foreignOwnerID })
        expect(yield* guards.assertHealthy(acquired.token)).toEqual({
          state: "unhealthy",
          issues: [{ directory: bravo, reason: "foreign-owner" }],
        })

        yield* update({ owner_id: acquired.token.ownerID, generation: acquired.token.generation + 1 })
        expect(yield* guards.assertHealthy(acquired.token)).toEqual({
          state: "unhealthy",
          issues: [{ directory: bravo, reason: "wrong-generation" }],
        })

        yield* update({ generation: acquired.token.generation, state: "reconcile_required" })
        expect(yield* guards.assertHealthy(acquired.token)).toEqual({
          state: "unhealthy",
          issues: [{ directory: bravo, reason: "reconcile_required" }],
        })

        yield* update({ state: "active", acquisition_id: "directory-maintenance:forged" })
        expect(yield* guards.assertHealthy(acquired.token)).toEqual({
          state: "unhealthy",
          issues: [{ directory: bravo, reason: "foreign-acquisition" }],
        })

        yield* update({ acquisition_id: acquired.token.acquisitionId })
      }),
    ),
  )

  it.effect("reports a missing directory row without deleting durable authority", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const guards = yield* DirectoryMaintenanceGuard.Service
        yield* seedOwners(currentRuntimeID)
        const alpha = ws.key(ws.dir("alpha"))
        const bravo = ws.key(ws.dir("bravo"))
        // Durable triggers make the deleted-row fixture impossible, so absence
        // is synthesized by publishing only alpha: the token claims a
        // two-directory acquisition whose bravo row was never written. No
        // durable row is removed, and the same `!row` health branch a vanished
        // row would take is exercised.
        yield* seedHold({
          directory: alpha,
          guardId: "guard-missing-fixture",
          ownerID: currentRuntimeID,
          acquisitionId: "directory-maintenance:missing-fixture",
        })
        expect(
          yield* guards.assertHealthy({
            acquisitionId: acquisitionID("directory-maintenance:missing-fixture"),
            guardId: "guard-missing-fixture",
            ownerID: currentRuntimeID,
            generation: 1,
            directories: sorted([alpha, bravo]),
          }),
        ).toEqual({ state: "unhealthy", issues: [{ directory: bravo, reason: "missing" }] })
        expect(yield* rows()).toHaveLength(1)
      }),
    ),
  )

  it.effect("treats a malformed token as unhealthy instead of trusting its shape", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const guards = yield* DirectoryMaintenanceGuard.Service
        const acquired = yield* guards.acquire({ guardId: "guard-malformed", directories: [ws.dir("alpha"), ws.dir("bravo")] })
        if (acquired.state !== "acquired") return yield* Effect.die("expected acquisition")
        const token = acquired.token

        expect(yield* guards.assertHealthy({ ...token, generation: 0 })).toEqual({
          state: "unhealthy",
          issues: [{ directory: token.directories[0]!, reason: "malformed-token" }],
        })
        expect(yield* guards.assertHealthy({ ...token, guardId: "guard-malformed " })).toEqual({
          state: "unhealthy",
          issues: [{ directory: token.directories[0]!, reason: "malformed-token" }],
        })
        expect(yield* guards.assertHealthy({ ...token, ownerID: "" as RuntimeOwner.ID })).toEqual({
          state: "unhealthy",
          issues: [{ directory: token.directories[0]!, reason: "malformed-token" }],
        })
        expect(yield* guards.assertHealthy({ ...token, directories: [token.directories[0]!] })).toEqual({
          state: "unhealthy",
          issues: [{ directory: token.directories[0]!, reason: "malformed-token" }],
        })
        expect(
          yield* guards.assertHealthy({
            ...token,
            directories: sorted([token.directories[0]!, ws.key(ws.dir("charlie"))]),
          }),
        ).toEqual({
          state: "unhealthy",
          issues: [
            { directory: token.directories[1]!, reason: "directory-set-mismatch" },
            { directory: ws.key(ws.dir("charlie")), reason: "missing" },
          ],
        })
      }),
    ),
  )
})

describe("DirectoryMaintenanceGuard durable authority triggers", () => {
  const rawUpdate = (directory: DirectoryKey, values: Partial<typeof DirectoryMaintenanceGuardTable.$inferInsert>) =>
    Database.Service.use(({ db }) =>
      db
        .update(DirectoryMaintenanceGuardTable)
        .set(values)
        .where(eq(DirectoryMaintenanceGuardTable.directory, directory))
        .run()
        .pipe(Effect.exit),
    )

  it.effect("rejects raw deletion of guard rows even for an exact acquisition", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const guards = yield* DirectoryMaintenanceGuard.Service
        const { db } = yield* Database.Service
        const acquired = yield* guards.acquire({
          guardId: "guard-trigger-delete",
          directories: [ws.dir("alpha"), ws.dir("bravo")],
        })
        if (acquired.state !== "acquired") return yield* Effect.die("expected acquisition")
        const alpha = ws.key(ws.dir("alpha"))

        const deletion = yield* db
          .delete(DirectoryMaintenanceGuardTable)
          .where(eq(DirectoryMaintenanceGuardTable.directory, alpha))
          .run()
          .pipe(Effect.exit)
        expect(Exit.isFailure(deletion)).toBe(true)
        if (Exit.isFailure(deletion)) {
          expect(Cause.pretty(deletion.cause)).toContain("directory_maintenance_guard rows are never deletable")
        }

        const acquisitionDeletion = yield* db
          .delete(DirectoryMaintenanceGuardTable)
          .where(eq(DirectoryMaintenanceGuardTable.acquisition_id, acquired.token.acquisitionId))
          .run()
          .pipe(Effect.exit)
        expect(Exit.isFailure(acquisitionDeletion)).toBe(true)
        if (Exit.isFailure(acquisitionDeletion)) {
          expect(Cause.pretty(acquisitionDeletion.cause)).toContain(
            "directory_maintenance_guard rows are never deletable",
          )
        }

        expect(yield* acquisitionRows(acquired.token.acquisitionId)).toHaveLength(2)
        expect(yield* guards.assertHealthy(acquired.token)).toEqual({ state: "healthy" })
        expect(yield* guards.release(acquired.token)).toBe("released")
      }),
    ),
  )

  it.effect("rejects raw REPLACE of an existing guard row that the delete trigger cannot see", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const guards = yield* DirectoryMaintenanceGuard.Service
        const { db } = yield* Database.Service
        const acquired = yield* guards.acquire({
          guardId: "guard-trigger-replace",
          directories: [ws.dir("alpha"), ws.dir("bravo")],
        })
        if (acquired.state !== "acquired") return yield* Effect.die("expected acquisition")
        expect(yield* guards.release(acquired.token)).toBe("released")
        const alpha = ws.key(ws.dir("alpha"))

        // With recursive_triggers OFF, SQLite's REPLACE conflict resolution
        // deletes the conflicting row without firing the DELETE trigger, so the
        // no-delete guard alone cannot see this rewrite of released authority.
        const replacement = yield* db
          .run(
            sql`INSERT OR REPLACE INTO directory_maintenance_guard (directory, guard_id, owner_id, acquisition_id, generation, state, acquired_at, released_at, updated_at) VALUES (${alpha}, 'guard-forged', ${acquired.token.ownerID}, 'directory-maintenance:forged', 1, 'active', 1, NULL, 1)`,
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(replacement)).toBe(true)
        if (Exit.isFailure(replacement)) {
          expect(Cause.pretty(replacement.cause)).toContain("directory_maintenance_guard rows are never replaceable")
        }
        expect(yield* row(alpha)).toMatchObject({
          guard_id: "guard-trigger-replace",
          acquisition_id: acquired.token.acquisitionId,
          state: "released",
        })

        // Released-row reuse through the service still works after the abort.
        const reuse = yield* guards.acquire({
          guardId: "guard-trigger-replace-next",
          directories: [ws.dir("alpha"), ws.dir("bravo")],
        })
        expect(reuse.state).toBe("acquired")
        if (reuse.state !== "acquired") return
        expect(reuse.token.generation).toBe(acquired.token.generation + 1)
        expect(yield* guards.assertHealthy(reuse.token)).toEqual({ state: "healthy" })
      }),
    ),
  )

  it.effect("rejects raw authority identity mutation while the row stays active", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        yield* seedOwners(foreignOwnerID)
        const guards = yield* DirectoryMaintenanceGuard.Service
        const acquired = yield* guards.acquire({
          guardId: "guard-trigger-identity",
          directories: [ws.dir("alpha"), ws.dir("bravo")],
        })
        if (acquired.state !== "acquired") return yield* Effect.die("expected acquisition")
        const alpha = ws.key(ws.dir("alpha"))
        const generation = acquired.token.generation

        // active -> released may not smuggle in a new guard, owner, acquisition
        // identity, generation, or acquisition timestamp.
        expect(Exit.isFailure(yield* rawUpdate(alpha, { state: "released", released_at: 1, guard_id: "guard-forged" }))).toBe(
          true,
        )
        expect(
          Exit.isFailure(yield* rawUpdate(alpha, { state: "released", released_at: 1, owner_id: foreignOwnerID })),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* rawUpdate(alpha, {
              state: "released",
              released_at: 1,
              acquisition_id: acquisitionID("directory-maintenance:forged"),
            }),
          ),
        ).toBe(true)
        expect(Exit.isFailure(yield* rawUpdate(alpha, { state: "released", released_at: 1, generation: generation + 1 }))).toBe(
          true,
        )
        expect(Exit.isFailure(yield* rawUpdate(alpha, { state: "released", released_at: 1, acquired_at: 1 }))).toBe(true)
        // Same-state writes may only refresh updated_at.
        expect(Exit.isFailure(yield* rawUpdate(alpha, { guard_id: "guard-forged" }))).toBe(true)
        expect(Exit.isFailure(yield* rawUpdate(alpha, { acquisition_id: acquisitionID("directory-maintenance:forged") }))).toBe(
          true,
        )
        expect(Exit.isFailure(yield* rawUpdate(alpha, { generation: generation + 1 }))).toBe(true)
        expect(Exit.isFailure(yield* rawUpdate(alpha, { acquired_at: 1 }))).toBe(true)
        // active -> reconcile_required keeps the same durable identity.
        expect(Exit.isFailure(yield* rawUpdate(alpha, { state: "reconcile_required", guard_id: "guard-forged" }))).toBe(true)

        expect(yield* row(alpha)).toMatchObject({
          guard_id: "guard-trigger-identity",
          owner_id: acquired.token.ownerID,
          acquisition_id: acquired.token.acquisitionId,
          generation,
          state: "active",
          released_at: null,
        })
        expect(yield* guards.assertHealthy(acquired.token)).toEqual({ state: "healthy" })
        expect(yield* guards.release(acquired.token)).toBe("released")
      }),
    ),
  )

  it.effect("rejects raw released->active reuse without generation+1 and a fresh acquisition id", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const guards = yield* DirectoryMaintenanceGuard.Service
        const first = yield* guards.acquire({
          guardId: "guard-trigger-reuse",
          directories: [ws.dir("alpha"), ws.dir("bravo")],
        })
        if (first.state !== "acquired") return yield* Effect.die("expected acquisition")
        expect(yield* guards.release(first.token)).toBe("released")
        const alpha = ws.key(ws.dir("alpha"))
        const generation = first.token.generation

        // A released row may not return to active with its old generation, even
        // with a new acquisition id...
        expect(
          Exit.isFailure(
            yield* rawUpdate(alpha, {
              state: "active",
              released_at: null,
              acquisition_id: acquisitionID("directory-maintenance:raw-reuse"),
            }),
          ),
        ).toBe(true)
        // ...nor with a bumped generation under the old acquisition id...
        expect(Exit.isFailure(yield* rawUpdate(alpha, { state: "active", released_at: null, generation: generation + 1 }))).toBe(
          true,
        )
        // ...nor by jumping to a terminal state or dropping released_at.
        expect(Exit.isFailure(yield* rawUpdate(alpha, { state: "reconcile_required" }))).toBe(true)
        expect(Exit.isFailure(yield* rawUpdate(alpha, { released_at: null }))).toBe(true)

        expect(yield* row(alpha)).toMatchObject({
          state: "released",
          generation,
          acquisition_id: first.token.acquisitionId,
        })

        // The exact reuse shape is the only legal released -> active mutation.
        const reuse = yield* rawUpdate(alpha, {
          state: "active",
          released_at: null,
          acquisition_id: acquisitionID("directory-maintenance:raw-reuse"),
          generation: generation + 1,
          acquired_at: Date.now(),
          updated_at: Date.now(),
        })
        expect(Exit.isSuccess(reuse)).toBe(true)
        expect(yield* row(alpha)).toMatchObject({
          state: "active",
          released_at: null,
          generation: generation + 1,
          acquisition_id: "directory-maintenance:raw-reuse",
        })
      }),
    ),
  )

  it.effect("keeps reconcile_required terminal except for identity-preserving resolution", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const guards = yield* DirectoryMaintenanceGuard.Service
        const acquired = yield* guards.acquire({
          guardId: "guard-trigger-terminal",
          directories: [ws.dir("alpha"), ws.dir("bravo")],
        })
        if (acquired.state !== "acquired") return yield* Effect.die("expected acquisition")
        const alpha = ws.key(ws.dir("alpha"))
        const generation = acquired.token.generation

        expect(Exit.isSuccess(yield* rawUpdate(alpha, { state: "reconcile_required", updated_at: Date.now() }))).toBe(true)
        // reconcile_required is terminal: it never returns to active...
        expect(Exit.isFailure(yield* rawUpdate(alpha, { state: "active" }))).toBe(true)
        // ...and resolution may not rewrite identity or omit released_at.
        expect(
          Exit.isFailure(yield* rawUpdate(alpha, { state: "released", released_at: Date.now(), guard_id: "guard-forged" })),
        ).toBe(true)
        expect(
          Exit.isFailure(yield* rawUpdate(alpha, { state: "released", released_at: Date.now(), generation: generation + 1 })),
        ).toBe(true)
        expect(Exit.isFailure(yield* rawUpdate(alpha, { state: "released", released_at: null }))).toBe(true)
        expect(Exit.isSuccess(yield* rawUpdate(alpha, { state: "released", released_at: Date.now(), updated_at: Date.now() }))).toBe(
          true,
        )
        const resolved = yield* row(alpha)
        expect(resolved?.state).toBe("released")
        expect(resolved?.generation).toBe(generation)
        expect(resolved?.released_at).not.toBeNull()
      }),
    ),
  )
})

describe("DirectoryMaintenanceGuard input validation", () => {
  it.effect("rejects duplicate keys after canonicalization, non-existent, and non-absolute directories", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const guards = yield* DirectoryMaintenanceGuard.Service

        const duplicate = yield* guards
          .acquire({ guardId: "guard-dup", directories: [ws.dir("alpha"), `${ws.dir("alpha")}/`] })
          .pipe(Effect.flip)
        expect(duplicate).toBeInstanceOf(DirectoryMaintenanceGuard.DuplicateDirectoryError)

        const relative = yield* guards
          .acquire({ guardId: "guard-rel", directories: [ws.dir("alpha"), "relative/path"] })
          .pipe(Effect.flip)
        expect(relative).toBeInstanceOf(DirectoryMaintenanceGuard.InvalidDirectoryError)
        expect((relative as DirectoryMaintenanceGuard.InvalidDirectoryError).directory).toBe("relative/path")

        const missing = yield* guards
          .acquire({ guardId: "guard-missing", directories: [ws.dir("alpha"), join(ws.root, "absent")] })
          .pipe(Effect.flip)
        expect(missing).toBeInstanceOf(DirectoryMaintenanceGuard.InvalidDirectoryError)

        const single = yield* guards.acquire({ guardId: "guard-single", directories: [ws.dir("alpha")] }).pipe(Effect.flip)
        expect(single).toBeInstanceOf(DirectoryMaintenanceGuard.InsufficientDirectoriesError)
        expect((single as DirectoryMaintenanceGuard.InsufficientDirectoriesError).count).toBe(1)

        expect(yield* rows()).toHaveLength(0)
      }),
    ),
  )

  it.effect("rejects guard ids that are empty, padded, embedded, or over-length", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const guards = yield* DirectoryMaintenanceGuard.Service
        for (const guardId of [
          "   ",
          "guard ",
          " guard",
          "guard\nid",
          "guard\u0000id",
          "",
          "guard id",
          "guard\tbad",
          "g".repeat(DirectoryMaintenanceGuard.MAX_CANONICAL_GUARD_ID_LENGTH + 1),
        ]) {
          const error = yield* guards
            .acquire({ guardId, directories: [ws.dir("alpha"), ws.dir("bravo")] })
            .pipe(Effect.flip)
          expect(error).toBeInstanceOf(DirectoryMaintenanceGuard.InvalidGuardIDError)
        }
        expect(yield* rows()).toHaveLength(0)

        // The canonical bound itself is accepted: exactly 200 characters.
        const accepted = yield* guards.acquire({
          guardId: "g".repeat(DirectoryMaintenanceGuard.MAX_CANONICAL_GUARD_ID_LENGTH),
          directories: [ws.dir("alpha"), ws.dir("bravo")],
        })
        expect(accepted.state).toBe("acquired")
        if (accepted.state !== "acquired") return
        expect(yield* guards.release(accepted.token)).toBe("released")
      }),
    ),
  )

  if (process.platform === "win32") {
    it.effect("rejects Windows case, separator, dot-segment, and namespace ambiguity for acquisition", () =>
      withWorkspace((ws) =>
        Effect.gen(function* () {
          const guards = yield* DirectoryMaintenanceGuard.Service
          const rootRelative = yield* guards
            .acquire({ guardId: "guard-root-relative", directories: [ws.dir("alpha"), "/Repo/Alpha"] })
            .pipe(Effect.flip)
          expect(rootRelative).toBeInstanceOf(DirectoryMaintenanceGuard.InvalidDirectoryError)

          const device = yield* guards
            .acquire({ guardId: "guard-device", directories: [ws.dir("alpha"), "\\\\?\\C:\\repo"] })
            .pipe(Effect.flip)
          expect(device).toBeInstanceOf(DirectoryMaintenanceGuard.InvalidDirectoryError)

          const alias = yield* guards
            .acquire({ guardId: "guard-alias-input", directories: [ws.dir("alpha"), `${ws.dir("alpha").toUpperCase()}`] })
            .pipe(Effect.flip)
          // A case-variant spelling of an already-claimed directory resolves to
          // the same physical key, so it is a duplicate, never a second identity.
          expect(alias).toBeInstanceOf(DirectoryMaintenanceGuard.DuplicateDirectoryError)
          expect((alias as DirectoryMaintenanceGuard.DuplicateDirectoryError).directory).toBe(ws.key(ws.dir("alpha")))
          expect(yield* rows()).toHaveLength(0)
        }),
      ),
    )
  }
})

describe("DirectoryMaintenanceGuard reconciliation", () => {
  recoveryIt.effect("reconciles each dead acquisition separately and keeps uncertainty blocking", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const guards = yield* DirectoryMaintenanceGuard.Service
        const { db } = yield* Database.Service
        yield* seedOwners(deadOwnerID, liveOwnerID, unknownOwnerID)
        yield* seedHold({
          directory: ws.key(ws.dir("alpha")),
          guardId: "guard-dead",
          ownerID: deadOwnerID,
          acquisitionId: "acquisition-dead-1",
        })
        yield* seedHold({
          directory: ws.key(ws.dir("bravo")),
          guardId: "guard-dead",
          ownerID: deadOwnerID,
          acquisitionId: "acquisition-dead-1",
        })
        yield* seedHold({
          directory: ws.key(ws.dir("charlie")),
          guardId: "guard-dead",
          ownerID: deadOwnerID,
          acquisitionId: "acquisition-dead-2",
        })
        yield* seedHold({
          directory: ws.key(ws.dir("delta")),
          guardId: "guard-dead",
          ownerID: deadOwnerID,
          acquisitionId: "acquisition-dead-2",
        })
        yield* seedHold({ directory: ws.key(ws.dir("echo")), guardId: "guard-live", ownerID: liveOwnerID })
        yield* seedHold({ directory: ws.key(ws.dir("foxtrot")), guardId: "guard-unknown", ownerID: unknownOwnerID })

        const report = yield* guards.reconcile()
        // One dead runtime, two acquisitions: they remain separately auditable.
        expect(report.reconciled).toEqual([
          {
            acquisitionId: acquisitionID("acquisition-dead-1"),
            ownerID: deadOwnerID,
            directories: sorted([ws.key(ws.dir("alpha")), ws.key(ws.dir("bravo"))]),
          },
          {
            acquisitionId: acquisitionID("acquisition-dead-2"),
            ownerID: deadOwnerID,
            directories: sorted([ws.key(ws.dir("charlie")), ws.key(ws.dir("delta"))]),
          },
        ])
        expect(report.blocked.find((entry) => entry.ownerID === liveOwnerID)).toEqual({
          acquisitionId: acquisitionID("directory-maintenance:seed-guard-live"),
          ownerID: liveOwnerID,
          proof: "alive-or-unknown",
          directories: [ws.key(ws.dir("echo"))],
        })
        expect(report.blocked.find((entry) => entry.ownerID === unknownOwnerID)).toEqual({
          acquisitionId: acquisitionID("directory-maintenance:seed-guard-unknown"),
          ownerID: unknownOwnerID,
          proof: "not-local-or-unknown",
          directories: [ws.key(ws.dir("foxtrot"))],
        })

        expect(yield* row(ws.key(ws.dir("alpha")))).toMatchObject({ state: "reconcile_required", released_at: null })
        expect(yield* row(ws.key(ws.dir("bravo")))).toMatchObject({ state: "reconcile_required", released_at: null })
        expect(yield* row(ws.key(ws.dir("echo")))).toMatchObject({ state: "active" })
        expect(yield* row(ws.key(ws.dir("foxtrot")))).toMatchObject({ state: "active" })

        // reconcile_required is terminal for acquisition and never auto-released.
        const blocked = yield* guards.acquire({ guardId: "guard-retry", directories: [ws.dir("alpha"), ws.dir("bravo")] })
        expect(blocked.state).toBe("blocked")
        if (blocked.state === "blocked") {
          expect(blocked.blocked.map((entry) => entry.state)).toEqual(["reconcile_required", "reconcile_required"])
        }

        const repeated = yield* guards.reconcile()
        expect(repeated.reconciled).toEqual([])
        expect(repeated.blocked.map((entry) => entry.ownerID).sort()).toEqual([liveOwnerID, unknownOwnerID].sort())
        expect(yield* row(ws.key(ws.dir("alpha")))).toMatchObject({ state: "reconcile_required" })
        expect((yield* acquisitionRows("acquisition-dead-1")).every((entry) => entry.state === "reconcile_required")).toBe(
          true,
        )
        expect((yield* acquisitionRows("acquisition-dead-2")).every((entry) => entry.state === "reconcile_required")).toBe(
          true,
        )
        // Reconcile itself never releases: only an explicit resolution can.
        expect((yield* rows()).some((entry) => entry.state === "released")).toBe(false)
        void db
      }),
    ),
  )

  it.effect("never treats a stale heartbeat as death proof for a live local owner", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const runtime = yield* RuntimeOwner.Service
        const guards = yield* DirectoryMaintenanceGuard.Service
        const { db } = yield* Database.Service
        const acquired = yield* guards.acquire({ guardId: "guard-stale", directories: [ws.dir("alpha"), ws.dir("bravo")] })
        if (acquired.state !== "acquired") return yield* Effect.die("expected acquisition")

        yield* db
          .update(RuntimeOwnerTable)
          .set({ heartbeat_at: 1 })
          .where(eq(RuntimeOwnerTable.id, runtime.id))
          .run()
          .pipe(Effect.orDie)

        const report = yield* guards.reconcile()
        expect(report.reconciled).toEqual([])
        expect(report.blocked).toEqual([
          {
            acquisitionId: acquired.token.acquisitionId,
            ownerID: runtime.id,
            proof: "alive-or-unknown",
            directories: sorted([ws.key(ws.dir("alpha")), ws.key(ws.dir("bravo"))]),
          },
        ])
        expect(yield* row(ws.key(ws.dir("alpha")))).toMatchObject({ state: "active" })
        expect(yield* row(ws.key(ws.dir("bravo")))).toMatchObject({ state: "active" })
        expect(yield* guards.assertHealthy(acquired.token)).toEqual({ state: "healthy" })
        expect(yield* guards.release(acquired.token)).toBe("released")
      }),
    ),
  )

  recoveryIt.effect("reports each blocked acquisition under one alive owner separately with exact directories", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const guards = yield* DirectoryMaintenanceGuard.Service
        yield* seedOwners(liveOwnerID)
        yield* seedHold({
          directory: ws.key(ws.dir("alpha")),
          guardId: "guard-block-a",
          ownerID: liveOwnerID,
          acquisitionId: "blocked-acquisition-a",
        })
        yield* seedHold({
          directory: ws.key(ws.dir("bravo")),
          guardId: "guard-block-a",
          ownerID: liveOwnerID,
          acquisitionId: "blocked-acquisition-a",
        })
        yield* seedHold({
          directory: ws.key(ws.dir("charlie")),
          guardId: "guard-block-b",
          ownerID: liveOwnerID,
          acquisitionId: "blocked-acquisition-b",
        })
        yield* seedHold({
          directory: ws.key(ws.dir("delta")),
          guardId: "guard-block-b",
          ownerID: liveOwnerID,
          acquisitionId: "blocked-acquisition-b",
        })

        // One alive owner, two acquisitions: the death proof is computed once
        // but each acquisition is listed separately with its exact directory
        // set instead of one aggregated owner entry.
        const report = yield* guards.reconcile()
        expect(report.reconciled).toEqual([])
        expect(report.blocked).toEqual([
          {
            acquisitionId: acquisitionID("blocked-acquisition-a"),
            ownerID: liveOwnerID,
            proof: "alive-or-unknown",
            directories: sorted([ws.key(ws.dir("alpha")), ws.key(ws.dir("bravo"))]),
          },
          {
            acquisitionId: acquisitionID("blocked-acquisition-b"),
            ownerID: liveOwnerID,
            proof: "alive-or-unknown",
            directories: sorted([ws.key(ws.dir("charlie")), ws.key(ws.dir("delta"))]),
          },
        ])
        expect((yield* rows()).every((entry) => entry.state === "active")).toBe(true)
      }),
    ),
  )
})

describe("DirectoryMaintenanceGuard reconcile_required resolution", () => {
  recoveryIt.effect("resolves one exact reconcile_required acquisition and keeps every mismatch blocking", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const guards = yield* DirectoryMaintenanceGuard.Service
        yield* seedOwners(deadOwnerID, liveOwnerID, unknownOwnerID)
        yield* seedHold({
          directory: ws.key(ws.dir("alpha")),
          guardId: "guard-resolve",
          ownerID: deadOwnerID,
          acquisitionId: "acquisition-resolve",
          generation: 2,
        })
        yield* seedHold({
          directory: ws.key(ws.dir("bravo")),
          guardId: "guard-resolve",
          ownerID: deadOwnerID,
          acquisitionId: "acquisition-resolve",
          generation: 2,
        })

        // Reconcile first: it must never auto-release.
        const report = yield* guards.reconcile()
        expect(report.reconciled).toEqual([
          {
            acquisitionId: acquisitionID("acquisition-resolve"),
            ownerID: deadOwnerID,
            directories: sorted([ws.key(ws.dir("alpha")), ws.key(ws.dir("bravo"))]),
          },
        ])
        expect(yield* row(ws.key(ws.dir("alpha")))).toMatchObject({ state: "reconcile_required", released_at: null })

        const token = {
          acquisitionId: acquisitionID("acquisition-resolve"),
          guardId: "guard-resolve",
          ownerID: deadOwnerID,
          generation: 2,
          directories: sorted([ws.key(ws.dir("alpha")), ws.key(ws.dir("bravo"))]),
        } satisfies Token

        expect(yield* guards.resolveReconcileRequired({ ...token, generation: 3 })).toEqual({ state: "stale" })
        expect(
          yield* guards.resolveReconcileRequired({
            ...token,
            acquisitionId: acquisitionID("acquisition-other"),
          }),
        ).toEqual({ state: "stale" })
        expect(yield* guards.resolveReconcileRequired({ ...token, guardId: "guard-other" })).toEqual({ state: "stale" })
        expect(yield* guards.resolveReconcileRequired({ ...token, directories: [token.directories[0]!] })).toEqual({
          state: "stale",
        })
        expect(
          yield* guards.resolveReconcileRequired({
            ...token,
            directories: sorted([...token.directories, ws.key(ws.dir("charlie"))]),
          }),
        ).toEqual({ state: "stale" })
        expect(yield* row(ws.key(ws.dir("alpha")))).toMatchObject({ state: "reconcile_required" })

        // A live or unprovable owner stays blocking even with exact identity.
        yield* seedHold({
          directory: ws.key(ws.dir("charlie")),
          guardId: "guard-live-resolve",
          ownerID: liveOwnerID,
          acquisitionId: "acquisition-live",
          state: "reconcile_required",
        })
        yield* seedHold({
          directory: ws.key(ws.dir("delta")),
          guardId: "guard-live-resolve",
          ownerID: liveOwnerID,
          acquisitionId: "acquisition-live",
          state: "reconcile_required",
        })
        yield* seedHold({
          directory: ws.key(ws.dir("echo")),
          guardId: "guard-unknown-resolve",
          ownerID: unknownOwnerID,
          acquisitionId: "acquisition-unknown",
          state: "reconcile_required",
        })
        yield* seedHold({
          directory: ws.key(ws.dir("foxtrot")),
          guardId: "guard-unknown-resolve",
          ownerID: unknownOwnerID,
          acquisitionId: "acquisition-unknown",
          state: "reconcile_required",
        })
        expect(
          yield* guards.resolveReconcileRequired({
            acquisitionId: acquisitionID("acquisition-live"),
            guardId: "guard-live-resolve",
            ownerID: liveOwnerID,
            generation: 1,
            directories: sorted([ws.key(ws.dir("charlie")), ws.key(ws.dir("delta"))]),
          }),
        ).toEqual({ state: "blocked", proof: "alive-or-unknown" })
        expect(
          yield* guards.resolveReconcileRequired({
            acquisitionId: acquisitionID("acquisition-unknown"),
            guardId: "guard-unknown-resolve",
            ownerID: unknownOwnerID,
            generation: 1,
            directories: sorted([ws.key(ws.dir("echo")), ws.key(ws.dir("foxtrot"))]),
          }),
        ).toEqual({ state: "blocked", proof: "not-local-or-unknown" })
        expect(yield* row(ws.key(ws.dir("charlie")))).toMatchObject({ state: "reconcile_required" })
        expect(yield* row(ws.key(ws.dir("echo")))).toMatchObject({ state: "reconcile_required" })

        // An active (not reconcile_required) acquisition is not resolvable.
        yield* seedHold({
          directory: ws.key(ws.dir("golf")),
          guardId: "guard-active-resolve",
          ownerID: deadOwnerID,
          acquisitionId: "acquisition-active-resolve",
        })
        yield* seedHold({
          directory: ws.key(ws.dir("hotel")),
          guardId: "guard-active-resolve",
          ownerID: deadOwnerID,
          acquisitionId: "acquisition-active-resolve",
        })
        expect(
          yield* guards.resolveReconcileRequired({
            acquisitionId: acquisitionID("acquisition-active-resolve"),
            guardId: "guard-active-resolve",
            ownerID: deadOwnerID,
            generation: 1,
            directories: sorted([ws.key(ws.dir("golf")), ws.key(ws.dir("hotel"))]),
          }),
        ).toEqual({ state: "stale" })
        expect(yield* row(ws.key(ws.dir("golf")))).toMatchObject({ state: "active" })

        // Only exact identity plus proven-local-death at resolution time resolves.
        expect(yield* guards.resolveReconcileRequired(token)).toEqual({ state: "resolved" })
        expect(yield* row(ws.key(ws.dir("alpha")))).toMatchObject({ state: "released" })
        const bravoRow = yield* row(ws.key(ws.dir("bravo")))
        if (bravoRow === undefined) return yield* Effect.die("expected the resolved bravo row")
        expect(bravoRow.released_at).not.toBeNull()
        expect((yield* acquisitionRows("acquisition-resolve")).every((entry) => entry.state === "released")).toBe(true)
        expect(yield* guards.resolveReconcileRequired(token)).toEqual({ state: "stale" })
      }),
    ),
  )
})

describe("DirectoryMaintenanceGuard retention accounting", () => {
  interface Counters {
    retains: number
    releases: number
  }

  const countingRuntimeLayer = (
    id: RuntimeOwner.ID,
    counters: Counters,
    proof: (ownerID: RuntimeOwner.ID) => RuntimeOwner.LocalDeathProof = () => "alive-or-unknown",
  ) =>
    Layer.succeed(
      RuntimeOwner.Service,
      RuntimeOwner.Service.of({
        id,
        pid: 999_001,
        startedAt: 1,
        retain: Effect.sync(() => {
          counters.retains += 1
          return {
            release: Effect.sync(() => {
              counters.releases += 1
            }),
          } satisfies RuntimeOwner.Retention
        }),
        snapshot: (ownerID) =>
          Effect.succeed({ id: ownerID, pid: 999_001, startedAt: 1, heartbeatAt: 1, controlEpoch: 0 }),
        proveLocalDeath: (ownerID) => Effect.succeed(proof(ownerID)),
      }),
    )

  const countingLayer = (id: RuntimeOwner.ID, counters: Counters) =>
    AppNodeBuilder.build(
      LayerNode.group([Database.node, RuntimeOwner.node, DirectoryMaintenanceGuard.node]),
      [
        [Database.node, Database.layerFromPath(":memory:")],
        [RuntimeOwner.node, countingRuntimeLayer(id, counters)],
      ],
    )

  test("releases retention exactly once on a blocked acquisition", async () => {
    const root = await mkdtemp(join(tmpdir(), "openfork-directory-guard-retention-"))
    try {
      const alpha = join(root, "alpha")
      const bravo = join(root, "bravo")
      await mkdir(alpha)
      await mkdir(bravo)
      const counters: Counters = { retains: 0, releases: 0 }
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* seedOwners(foreignOwnerID)
            yield* seedHold({ directory: physicalKey(alpha), guardId: "guard-held", ownerID: foreignOwnerID })
            const guards = yield* DirectoryMaintenanceGuard.Service
            return yield* guards.acquire({ guardId: "guard-blocked", directories: [alpha, bravo] })
          }).pipe(Effect.provide(countingLayer(currentRuntimeID, counters))),
        ),
      )
      expect(result.state).toBe("blocked")
      expect(counters).toEqual({ retains: 1, releases: 1 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("settles a blocked acquisition's retention exactly once when interrupted mid-release", async () => {
    const root = await mkdtemp(join(tmpdir(), "openfork-directory-guard-retention-"))
    try {
      const alpha = join(root, "alpha")
      const bravo = join(root, "bravo")
      await mkdir(alpha)
      await mkdir(bravo)
      const counters: Counters = { retains: 0, releases: 0 }
      const gates: { started?: Deferred.Deferred<void>; release?: Deferred.Deferred<void> } = {}
      const gatedRuntimeLayer = Layer.succeed(
        RuntimeOwner.Service,
        RuntimeOwner.Service.of({
          id: currentRuntimeID,
          pid: 999_001,
          startedAt: 1,
          retain: Effect.sync(() => {
            counters.retains += 1
            return {
              release: Effect.gen(function* () {
                const started = gates.started
                const release = gates.release
                if (started) yield* Deferred.succeed(started, undefined)
                if (release) yield* Deferred.await(release)
                counters.releases += 1
              }),
            } satisfies RuntimeOwner.Retention
          }),
          snapshot: (ownerID) =>
            Effect.succeed({ id: ownerID, pid: 999_001, startedAt: 1, heartbeatAt: 1, controlEpoch: 0 }),
          proveLocalDeath: () => Effect.succeed("alive-or-unknown" as const),
        }),
      )
      const layer = AppNodeBuilder.build(
        LayerNode.group([Database.node, RuntimeOwner.node, DirectoryMaintenanceGuard.node]),
        [
          [Database.node, Database.layerFromPath(":memory:")],
          [RuntimeOwner.node, gatedRuntimeLayer],
        ],
      )

      const outcome = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* seedOwners(foreignOwnerID)
            yield* seedHold({ directory: physicalKey(alpha), guardId: "guard-held", ownerID: foreignOwnerID })
            const started = yield* Deferred.make<void>()
            const release = yield* Deferred.make<void>()
            gates.started = started
            gates.release = release
            const guards = yield* DirectoryMaintenanceGuard.Service
            const acquire = yield* guards
              .acquire({ guardId: "guard-blocked", directories: [alpha, bravo] })
              .pipe(Effect.forkChild)
            // The blocked settlement is already inside the acquisition's
            // finalization boundary; interrupting must not abandon it.
            yield* Deferred.await(started)
            const interrupting = yield* Fiber.interrupt(acquire).pipe(Effect.forkChild)
            yield* Effect.yieldNow
            expect(counters.releases).toBe(0)
            yield* Deferred.succeed(release, undefined)
            yield* Fiber.join(interrupting)
            return { persisted: yield* rows() }
          }).pipe(Effect.provide(layer)),
        ),
      )
      expect(counters).toEqual({ retains: 1, releases: 1 })
      expect(outcome.persisted).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("releases retention on a defect that never published durable ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "openfork-directory-guard-retention-"))
    try {
      const alpha = join(root, "alpha")
      const bravo = join(root, "bravo")
      await mkdir(alpha)
      await mkdir(bravo)
      const counters: Counters = { retains: 0, releases: 0 }
      const unseeded = "runtime-owner:guard-unseeded" as RuntimeOwner.ID
      const outcome = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const guards = yield* DirectoryMaintenanceGuard.Service
            const exit = yield* Effect.exit(guards.acquire({ guardId: "guard-defect", directories: [alpha, bravo] }))
            return { exit, persisted: yield* rows() }
          }).pipe(Effect.provide(countingLayer(unseeded, counters))),
        ),
      )
      // The foreign-key failure means the owner row was never published, so the
      // transaction dies instead of committing partial authority.
      expect(Exit.isFailure(outcome.exit)).toBe(true)
      expect(counters).toEqual({ retains: 1, releases: 1 })
      expect(outcome.persisted).toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("releases retention when an acquire is interrupted before durable ownership is published", async () => {
    const root = await mkdtemp(join(tmpdir(), "openfork-directory-guard-retention-"))
    try {
      const alpha = join(root, "alpha")
      const bravo = join(root, "bravo")
      await mkdir(alpha)
      await mkdir(bravo)
      const counters: Counters = { retains: 0, releases: 0 }
      const persisted = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const guards = yield* DirectoryMaintenanceGuard.Service
            const { db } = yield* Database.Service
            const started = yield* Deferred.make<void>()
            // Hold the writer reservation so the acquire suspends waiting on the
            // IMMEDIATE transaction boundary and can be interrupted before it
            // publishes durable ownership.
            const holder = yield* db
              .transaction(() => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)), {
                behavior: "immediate",
              })
              .pipe(Effect.forkChild)
            yield* Deferred.await(started)
            const acquire = yield* guards
              .acquire({ guardId: "guard-interrupt", directories: [alpha, bravo] })
              .pipe(Effect.forkChild)
            for (let attempt = 0; attempt < 100 && counters.retains === 0; attempt++) yield* Effect.yieldNow
            expect(counters.retains).toBe(1)

            const interrupting = yield* Fiber.interrupt(acquire).pipe(Effect.forkChild)
            yield* Effect.yieldNow
            yield* Fiber.interrupt(holder)
            yield* Fiber.join(interrupting)

            return yield* rows()
          }).pipe(Effect.provide(countingLayer(currentRuntimeID, counters))),
        ),
      )
      expect(counters).toEqual({ retains: 1, releases: 1 })
      expect(persisted).toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("settles a retention interrupted at the retain-to-finalizer registration boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "openfork-directory-guard-retention-"))
    try {
      const alpha = join(root, "alpha")
      const bravo = join(root, "bravo")
      await mkdir(alpha)
      await mkdir(bravo)
      const counters: Counters = { retains: 0, releases: 0 }
      const gates: { retained?: Deferred.Deferred<void>; gate?: Deferred.Deferred<void> } = {}
      // `retain` records its side effect, signals it, and only then suspends
      // before returning the handle: exactly the retain-to-finalizer
      // registration window where an interrupt used to abort the still
      // resolving retain and leave the un-returned handle unreleasable.
      const boundaryRuntimeLayer = Layer.succeed(
        RuntimeOwner.Service,
        RuntimeOwner.Service.of({
          id: currentRuntimeID,
          pid: 999_001,
          startedAt: 1,
          retain: Effect.gen(function* () {
            counters.retains += 1
            const retained = gates.retained
            const gate = gates.gate
            if (retained) yield* Deferred.succeed(retained, undefined)
            if (gate) yield* Deferred.await(gate)
            return {
              release: Effect.sync(() => {
                counters.releases += 1
              }),
            } satisfies RuntimeOwner.Retention
          }),
          snapshot: (ownerID) =>
            Effect.succeed({ id: ownerID, pid: 999_001, startedAt: 1, heartbeatAt: 1, controlEpoch: 0 }),
          proveLocalDeath: () => Effect.succeed("alive-or-unknown" as const),
        }),
      )
      const layer = AppNodeBuilder.build(
        LayerNode.group([Database.node, RuntimeOwner.node, DirectoryMaintenanceGuard.node]),
        [
          [Database.node, Database.layerFromPath(":memory:")],
          [RuntimeOwner.node, boundaryRuntimeLayer],
        ],
      )

      const outcome = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const guards = yield* DirectoryMaintenanceGuard.Service
            const retained = yield* Deferred.make<void>()
            const gate = yield* Deferred.make<void>()
            gates.retained = retained
            gates.gate = gate
            const acquire = yield* guards
              .acquire({ guardId: "guard-retain-boundary", directories: [alpha, bravo] })
              .pipe(Effect.forkChild)
            // The retain side effect is recorded before the handle exists:
            // interrupt at that boundary, then let the suspended retain resolve.
            yield* Deferred.await(retained)
            const interrupting = yield* Fiber.interrupt(acquire).pipe(Effect.forkChild)
            yield* Effect.yieldNow
            yield* Deferred.succeed(gate, undefined)

            // Observe both exits without re-propagating the interruption.
            const acquireExit = yield* Fiber.await(acquire)
            const interruptExit = yield* Fiber.await(interrupting)
            return { acquireExit, interruptExit, persisted: yield* rows() }
          }).pipe(Effect.provide(layer)),
        ),
      )
      expect(counters.retains).toBe(1)
      expect(counters.releases).toBe(counters.retains)
      expect(outcome.persisted).toHaveLength(0)
      expect(Exit.hasInterrupts(outcome.acquireExit)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("adopts retention when the transaction commits but acquire exits before transfer", async () => {
    const root = await mkdtemp(join(tmpdir(), "openfork-directory-guard-retention-"))
    try {
      const alpha = join(root, "alpha")
      const bravo = join(root, "bravo")
      await mkdir(alpha)
      await mkdir(bravo)
      const counters: Counters = { retains: 0, releases: 0 }
      const hook: { arm: boolean } = { arm: false }
      // Commits through the real writer and only then interrupts, inside the
      // wrapped transaction effect: a deterministic exit in the
      // commit-to-transfer window. The one-shot hook fires only for the
      // acquire under test.
      const interruptAfterCommit = Layer.provide(
        Layer.effect(
          Database.Service,
          Effect.map(Database.Service, (base) => {
            const afterCommit = Effect.suspend(() => {
              if (!hook.arm) return Effect.void
              hook.arm = false
              return Effect.interrupt
            })
            return Database.Service.of({
              db: Object.assign(Object.create(base.db), {
                transaction: ((...args: unknown[]) =>
                  (base.db.transaction as unknown as (...inner: unknown[]) => Effect.Effect<unknown>)(...args).pipe(
                    Effect.flatMap((result: unknown) => afterCommit.pipe(Effect.map(() => result))),
                  )) as unknown as typeof base.db.transaction,
              }) as typeof base.db,
              readDb: base.readDb,
              scanDb: base.scanDb,
              filename: base.filename,
            })
          }),
        ),
        Database.layerFromPath(":memory:"),
      )
      const layer = AppNodeBuilder.build(
        LayerNode.group([Database.node, RuntimeOwner.node, DirectoryMaintenanceGuard.node]),
        [
          [Database.node, interruptAfterCommit],
          [RuntimeOwner.node, countingRuntimeLayer(currentRuntimeID, counters)],
        ],
      )

      const outcome = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* seedOwners(currentRuntimeID)
            const guards = yield* DirectoryMaintenanceGuard.Service
            hook.arm = true
            const exit = yield* Effect.exit(
              guards.acquire({ guardId: "guard-post-commit", directories: [alpha, bravo] }),
            )
            const persisted = yield* rows()
            expect(counters.releases).toBe(0)
            const held = persisted.filter((entry) => entry.guard_id === "guard-post-commit")
            expect(held).toHaveLength(2)
            expect(held.every((entry) => entry.state === "active" && entry.released_at === null)).toBe(true)

            const token: Token = {
              acquisitionId: acquisitionID(held[0]!.acquisition_id),
              guardId: "guard-post-commit",
              ownerID: held[0]!.owner_id as RuntimeOwner.ID,
              generation: held[0]!.generation,
              directories: sorted(held.map((entry) => entry.directory as DirectoryKey)),
            }
            // The reconstructed exact handle proves the durable rows are
            // healthy; adoption is observable as the release count staying 0.
            expect(yield* guards.assertHealthy(token)).toEqual({ state: "healthy" })
            return { exit, persisted }
          }).pipe(Effect.provide(layer)),
        ),
      )

      // Interrupted exit after the durable commit: the finalizer must adopt
      // the retention (no release, so the heartbeat is not orphaned) for the
      // two committed active rows.
      expect(Exit.hasInterrupts(outcome.exit)).toBe(true)
      expect(counters).toEqual({ retains: 1, releases: 0 })
      expect(outcome.persisted.filter((entry) => entry.guard_id === "guard-post-commit")).toHaveLength(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("keeps retention while a healthy active acquisition exists and drops it once terminal", async () => {
    const root = await mkdtemp(join(tmpdir(), "openfork-directory-guard-retention-"))
    try {
      const alpha = join(root, "alpha")
      const bravo = join(root, "bravo")
      await mkdir(alpha)
      await mkdir(bravo)
      const counters: Counters = { retains: 0, releases: 0 }
      const outcome = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* seedOwners(foreignOwnerID, currentRuntimeID)
            const guards = yield* DirectoryMaintenanceGuard.Service
            const acquired = yield* guards.acquire({ guardId: "guard-live-retention", directories: [alpha, bravo] })
            if (acquired.state !== "acquired") return yield* Effect.die("expected acquisition")
            const token = acquired.token
            expect(yield* guards.assertHealthy(token)).toEqual({ state: "healthy" })

            // A forged subset handle must not release the live acquisition's
            // retention, and must make no durable change.
            expect(yield* guards.release({ ...token, directories: [token.directories[0]!] })).toBe("stale")
            expect(counters.releases).toBe(0)
            expect((yield* acquisitionRows(token.acquisitionId)).every((entry) => entry.state === "active")).toBe(true)

            expect(yield* guards.release({ ...token, directories: sorted([...token.directories].reverse()) })).toBe(
              "released",
            )
            expect(counters).toEqual({ retains: 1, releases: 1 })
            expect(yield* guards.release(token)).toBe("stale")
            expect(counters).toEqual({ retains: 1, releases: 1 })
            return token
          }).pipe(Effect.provide(countingLayer(currentRuntimeID, counters))),
        ),
      )
      expect(outcome.acquisitionId.length).toBeGreaterThan(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("keeps retention for malformed, subset, and superset handles while the acquisition is healthy", async () => {
    const root = await mkdtemp(join(tmpdir(), "openfork-directory-guard-retention-"))
    try {
      const alpha = join(root, "alpha")
      const bravo = join(root, "bravo")
      const charlie = join(root, "charlie")
      await Promise.all([alpha, bravo, charlie].map((directory) => mkdir(directory)))
      const counters: Counters = { retains: 0, releases: 0 }
      const outcome = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* seedOwners(foreignOwnerID, currentRuntimeID)
            const guards = yield* DirectoryMaintenanceGuard.Service
            const acquired = yield* guards.acquire({ guardId: "guard-healthy-retention", directories: [alpha, bravo] })
            if (acquired.state !== "acquired") return yield* Effect.die("expected acquisition")
            const token = acquired.token

            // Malformed, truncated, and extended handles that still carry the
            // healthy acquisitionId must report stale without releasing a
            // retention the durable active rows still need.
            for (const guardId of [
              "",
              "guard bad",
              "guard\tbad",
              "g".repeat(DirectoryMaintenanceGuard.MAX_CANONICAL_GUARD_ID_LENGTH + 1),
            ]) {
              expect(yield* guards.release({ ...token, guardId })).toBe("stale")
            }
            expect(yield* guards.release({ ...token, directories: [token.directories[0]!] })).toBe("stale")
            expect(
              yield* guards.release({ ...token, directories: sorted([...token.directories, physicalKey(charlie)]) }),
            ).toBe("stale")
            expect(counters.releases).toBe(0)
            expect((yield* acquisitionRows(token.acquisitionId)).every((entry) => entry.state === "active")).toBe(true)

            expect(yield* guards.release(token)).toBe("released")
            expect(counters).toEqual({ retains: 1, releases: 1 })
            // A terminal acquisition never releases its retention twice.
            expect(yield* guards.release({ ...token, guardId: "guard bad" })).toBe("stale")
            expect(yield* guards.release({ ...token, directories: [token.directories[0]!] })).toBe("stale")
            expect(counters).toEqual({ retains: 1, releases: 1 })
            return token
          }).pipe(Effect.provide(countingLayer(currentRuntimeID, counters))),
        ),
      )
      expect(outcome.acquisitionId.length).toBeGreaterThan(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("releases retention for a terminal stale handle whose durable rows are already released", async () => {
    const root = await mkdtemp(join(tmpdir(), "openfork-directory-guard-retention-"))
    try {
      const alpha = join(root, "alpha")
      const bravo = join(root, "bravo")
      await mkdir(alpha)
      await mkdir(bravo)
      const counters: Counters = { retains: 0, releases: 0 }
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* seedOwners(currentRuntimeID)
            const guards = yield* DirectoryMaintenanceGuard.Service
            const acquired = yield* guards.acquire({ guardId: "guard-terminal", directories: [alpha, bravo] })
            if (acquired.state !== "acquired") return yield* Effect.die("expected acquisition")
            // The durable acquisition is gone (released outside this handle):
            // keeping the heartbeat would leak the retention.
            yield* markReleased(physicalKey(alpha))
            yield* markReleased(physicalKey(bravo))
            const unhealthy = yield* guards.assertHealthy(acquired.token)
            expect(unhealthy.state).toBe("unhealthy")
            expect(counters).toEqual({ retains: 1, releases: 1 })
            expect(yield* guards.release(acquired.token)).toBe("stale")
            expect(counters).toEqual({ retains: 1, releases: 1 })
            expect(yield* guards.release(acquired.token)).toBe("stale")
            expect(counters).toEqual({ retains: 1, releases: 1 })
          }).pipe(Effect.provide(countingLayer(currentRuntimeID, counters))),
        ),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("DirectoryMaintenanceGuard persistence", () => {
  test("persists active blocking, released reuse, and acquisition identity across a database restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "openfork-directory-guard-persistence-"))
    const databasePath = join(root, "openfork.db")
    const alpha = join(root, "alpha")
    const bravo = join(root, "bravo")
    const charlie = join(root, "charlie")
    const delta = join(root, "delta")
    const makeLayer = () =>
      AppNodeBuilder.build(
        LayerNode.group([Database.node, RuntimeOwner.node, DirectoryMaintenanceGuard.node]),
        [[Database.node, Database.layerFromPath(databasePath)]],
      )

    try {
      await Promise.all([alpha, bravo, charlie, delta].map((directory) => mkdir(directory)))
      const first = await Effect.runPromise(
        Effect.gen(function* () {
          const guards = yield* DirectoryMaintenanceGuard.Service
          const active = yield* guards.acquire({ guardId: "guard-restart-active", directories: [alpha, bravo] })
          const released = yield* guards.acquire({ guardId: "guard-restart-released", directories: [charlie, delta] })
          if (active.state !== "acquired" || released.state !== "acquired") {
            return yield* Effect.die("expected both acquisitions")
          }
          expect(yield* guards.release(released.token)).toBe("released")
          return { active: active.token, released: released.token }
        }).pipe(Effect.provide(makeLayer())),
      )
      expect(first.active.generation).toBe(1)
      expect(first.released.generation).toBe(1)

      // A fresh Database + service graph against the same file, as a restarted
      // process would build.
      const second = await Effect.runPromise(
        Effect.gen(function* () {
          const guards = yield* DirectoryMaintenanceGuard.Service
          const reuse = yield* guards.acquire({ guardId: "guard-restart-reuse", directories: [delta, charlie] })
          const blocked = yield* guards.acquire({ guardId: "guard-restart-blocked", directories: [alpha, bravo] })
          return {
            reuse,
            blocked,
            staleHandle: yield* guards.release(first.released),
            drained: yield* guards.assertHealthy(first.released),
          }
        }).pipe(Effect.provide(makeLayer())),
      )

      expect(second.reuse.state).toBe("acquired")
      if (second.reuse.state !== "acquired") return
      expect(second.reuse.token.generation).toBe(first.released.generation + 1)
      expect(second.reuse.token.acquisitionId).not.toBe(first.released.acquisitionId)
      expect(second.blocked).toEqual({
        state: "blocked",
        blocked: [
          {
            directory: physicalKey(alpha),
            guardId: "guard-restart-active",
            ownerID: first.active.ownerID,
            acquisitionId: first.active.acquisitionId,
            generation: first.active.generation,
            state: "active",
          },
          {
            directory: physicalKey(bravo),
            guardId: "guard-restart-active",
            ownerID: first.active.ownerID,
            acquisitionId: first.active.acquisitionId,
            generation: first.active.generation,
            state: "active",
          },
        ],
        activityLeases: [],
        executing: [],
      })
      expect(second.staleHandle).toBe("stale")
      expect(second.drained).toEqual({
        state: "unhealthy",
        issues: [
          { directory: physicalKey(charlie), reason: "foreign-acquisition" },
          { directory: physicalKey(delta), reason: "foreign-acquisition" },
        ],
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("DirectoryMaintenanceGuard concurrency", () => {
  test("two file-backed services racing acquire produce exactly one winner and no partial rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "openfork-directory-guard-race-"))
    const databasePath = join(root, "openfork.db")
    const alpha = join(root, "alpha")
    const bravo = join(root, "bravo")
    const makeLayer = () =>
      AppNodeBuilder.build(
        LayerNode.group([Database.node, RuntimeOwner.node, DirectoryMaintenanceGuard.node]),
        [[Database.node, Database.layerFromPath(databasePath)]],
      )
    const attempt = () =>
      Effect.gen(function* () {
        const guards = yield* DirectoryMaintenanceGuard.Service
        return yield* guards.acquire({ guardId: "guard-race", directories: [alpha, bravo] })
      }).pipe(Effect.scoped, Effect.provide(makeLayer()))

    try {
      await Promise.all([alpha, bravo].map((directory) => mkdir(directory)))
      const [first, second] = await Effect.runPromise(Effect.all([attempt(), attempt()], { concurrency: "unbounded" }))
      const states = [first.state, second.state].sort()
      expect(states).toEqual(["acquired", "blocked"])
      const winner = first.state === "acquired" ? first : second
      if (winner.state !== "acquired") throw new Error("expected exactly one acquisition winner")

      const persisted = await Effect.runPromise(
        Effect.gen(function* () {
          const { readDb } = yield* Database.Service
          return yield* readDb.select().from(DirectoryMaintenanceGuardTable).all().pipe(Effect.orDie)
        }).pipe(Effect.scoped, Effect.provide(makeLayer())),
      )
      expect(persisted).toHaveLength(2)
      expect(persisted.map((entry) => entry.directory).sort()).toEqual(sorted(winner.token.directories))
      for (const entry of persisted) {
        expect(entry).toMatchObject({
          guard_id: "guard-race",
          owner_id: winner.token.ownerID,
          acquisition_id: winner.token.acquisitionId,
          generation: winner.token.generation,
          state: "active",
          released_at: null,
        })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
