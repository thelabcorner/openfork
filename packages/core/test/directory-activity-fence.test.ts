import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { DirectoryActivityFence } from "@opencode-ai/core/directory-activity-fence"
import { DirectoryMaintenanceGuard } from "@opencode-ai/core/directory-maintenance-guard"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { RuntimeOwner } from "@opencode-ai/core/runtime-owner"
import { testEffect } from "./lib/effect"

const realNodes = LayerNode.group([
  Database.node,
  RuntimeOwner.node,
  DirectoryMaintenanceGuard.node,
  DirectoryActivityFence.node,
])

const it = testEffect(
  AppNodeBuilder.build(realNodes, [[Database.node, Database.layerFromPath(":memory:")]]),
)

interface Workspace {
  readonly root: string
  readonly dir: (name: string) => string
}

const withWorkspace = <A, E, R>(
  body: (workspace: Workspace) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() =>
      mkdtemp(join(tmpdir(), "openfork-directory-activity-fence-")),
    )
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => rm(root, { recursive: true, force: true })),
    )
    return yield* body({ root, dir: (name) => join(root, name) })
  })

const physicalKey = (path: string): DirectoryMaintenanceGuard.DirectoryKey => {
  const key = DirectoryMaintenanceGuard.existingDirectoryKey(path, process.platform)
  if (key === undefined) throw new Error(`expected a physical directory key for ${path}`)
  return key
}

function mockGuard(
  overrides: Partial<DirectoryMaintenanceGuard.Interface>,
): DirectoryMaintenanceGuard.Interface {
  return DirectoryMaintenanceGuard.Service.of({
    acquire: () => Effect.die("unexpected acquire"),
    assertHealthy: () => Effect.die("unexpected assertHealthy"),
    release: () => Effect.die("unexpected release"),
    resolveReconcileRequired: () => Effect.die("unexpected resolveReconcileRequired"),
    reconcile: () => Effect.die("unexpected reconcile"),
    ...overrides,
  })
}

const mockNodes = LayerNode.group([
  DirectoryMaintenanceGuard.node,
  DirectoryActivityFence.node,
])

function runWithMock<A, E>(
  guard: DirectoryMaintenanceGuard.Interface,
  program: Effect.Effect<A, E, DirectoryActivityFence.Service>,
): Promise<A> {
  const layer = AppNodeBuilder.build(mockNodes, [
    [
      DirectoryMaintenanceGuard.node,
      Layer.succeed(
        DirectoryMaintenanceGuard.Service,
        DirectoryMaintenanceGuard.Service.of(guard),
      ),
    ],
  ])
  return Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(layer))))
}

describe("DirectoryActivityFence", () => {
  it.effect("acquires exactly two directories and forwards health/release identity", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const alpha = ws.dir("alpha")
        const bravo = ws.dir("bravo")
        yield* Effect.promise(() =>
          Promise.all([
            mkdir(alpha, { recursive: true }),
            mkdir(bravo, { recursive: true }),
          ]),
        )

        const fence = yield* DirectoryActivityFence.Service
        const acquired = yield* fence.acquire({
          guardId: "g3-exact-echo",
          directories: [alpha, bravo],
        })
        expect(acquired.state).toBe("acquired")
        if (acquired.state !== "acquired") return yield* Effect.die("expected acquired")

        const handle = acquired.token
        expect(handle.guardId).toBe("g3-exact-echo")
        expect(handle.acquisitionId.startsWith("directory-maintenance:")).toBe(true)
        expect(handle.generation).toBeGreaterThan(0)
        expect(handle.directories).toEqual([physicalKey(alpha), physicalKey(bravo)].sort())

        expect(yield* fence.assertHealthy(handle)).toEqual({ state: "healthy" })
        expect(yield* fence.release(handle)).toBe("released")
        expect(yield* fence.release(handle)).toBe("stale")
      }),
    ),
  )

  test("forwards the exact acquired handle and health/release results without rewriting", async () => {
    const token = {
      acquisitionId:
        "directory-maintenance:g3-mock" as DirectoryMaintenanceGuard.AcquisitionID,
      guardId: "g3-mock",
      ownerID: "runtime-owner:g3-mock" as RuntimeOwner.ID,
      generation: 7,
      directories: [
        "c:/mock/alpha" as DirectoryMaintenanceGuard.DirectoryKey,
        "c:/mock/bravo" as DirectoryMaintenanceGuard.DirectoryKey,
      ],
    } satisfies DirectoryMaintenanceGuard.Token
    const acquired = { state: "acquired" as const, token }
    const unhealthy = {
      state: "unhealthy" as const,
      issues: [
        {
          directory: token.directories[0]!,
          reason: "wrong-generation" as const,
        },
      ],
    }

    let acquireInput: DirectoryMaintenanceGuard.AcquireInput | undefined
    let healthyHandle: DirectoryMaintenanceGuard.Token | undefined
    let releasedHandle: DirectoryMaintenanceGuard.Token | undefined

    const result = await runWithMock(
      mockGuard({
        acquire: (input) =>
          Effect.sync(() => {
            acquireInput = input
            return acquired
          }),
        assertHealthy: (handle) =>
          Effect.sync(() => {
            healthyHandle = handle
            return unhealthy
          }),
        release: (handle) =>
          Effect.sync(() => {
            releasedHandle = handle
            return "stale" as const
          }),
      }),
      Effect.gen(function* () {
        const fence = yield* DirectoryActivityFence.Service
        const got = yield* fence.acquire({
          guardId: "g3-mock",
          directories: ["alpha", "bravo"],
        })
        expect(got).toBe(acquired)
        if (got.state !== "acquired") return yield* Effect.die("expected acquired")
        expect(yield* fence.assertHealthy(got.token)).toBe(unhealthy)
        expect(yield* fence.release(got.token)).toBe("stale")
        return got.token
      }),
    )

    expect(result).toBe(token)
    expect(acquireInput).toEqual({
      guardId: "g3-mock",
      directories: ["alpha", "bravo"],
    })
    expect(healthyHandle).toBe(token)
    expect(releasedHandle).toBe(token)
  })

  test("passes maintenance and execution blockers through without fabricating identity", async () => {
    const maintenance = {
      directory: "c:/mock/alpha" as DirectoryMaintenanceGuard.DirectoryKey,
      guardId: "foreign-guard",
      ownerID: "runtime-owner:foreign" as RuntimeOwner.ID,
      acquisitionId:
        "directory-maintenance:foreign" as DirectoryMaintenanceGuard.AcquisitionID,
      generation: 3,
      state: "reconcile_required" as const,
    } satisfies DirectoryMaintenanceGuard.BlockedDirectory
    const execution = {
      sessionID: "ses_g3_execution" as never,
      ownerID: "runtime-owner:execution" as RuntimeOwner.ID,
      generation: 4,
      persistedDirectory: "C:\\mock\\alpha",
      directory: "c:/mock/alpha" as DirectoryMaintenanceGuard.DirectoryKey,
      recoveryOwnerID: "runtime-owner:recovery" as RuntimeOwner.ID,
    } satisfies DirectoryMaintenanceGuard.ActiveExecutionBlocker

    for (const blocked of [
      { state: "blocked" as const, blocked: [maintenance], executing: [] },
      { state: "blocked" as const, blocked: [], executing: [execution] },
    ]) {
      const got = await runWithMock(
        mockGuard({ acquire: () => Effect.succeed(blocked) }),
        Effect.gen(function* () {
          const fence = yield* DirectoryActivityFence.Service
          return yield* fence.acquire({
            guardId: "g3-blocked",
            directories: ["alpha", "bravo"],
          })
        }),
      )
      expect(got).toBe(blocked)
    }

    expect("guardId" in execution).toBe(false)
    expect("acquisitionId" in execution).toBe(false)
  })

  test("never silently truncates a runtime directory array that escaped the tuple type", async () => {
    let forwarded: readonly string[] | undefined

    await runWithMock(
      mockGuard({
        acquire: (input) =>
          Effect.sync(() => {
            forwarded = input.directories
            return {
              state: "blocked" as const,
              blocked: [],
              executing: [
                {
                  sessionID: "ses_g3_runtime_escape" as never,
                  ownerID: "runtime-owner:g3-runtime-escape" as RuntimeOwner.ID,
                  generation: 1,
                  persistedDirectory: "C:\\runtime\\escape",
                  directory: null,
                },
              ],
            }
          }),
      }),
      Effect.gen(function* () {
        const fence = yield* DirectoryActivityFence.Service
        yield* fence.acquire({
          guardId: "g3-runtime-escape",
          directories: ["alpha", "bravo", "charlie"] as unknown as readonly [
            string,
            string,
          ],
        })
      }),
    )

    expect(forwarded).toEqual(["alpha", "bravo", "charlie"])
  })

  it.effect("preserves primitive input errors without minting authority", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const alpha = ws.dir("alpha")
        yield* Effect.promise(() => mkdir(alpha, { recursive: true }))
        const fence = yield* DirectoryActivityFence.Service

        const invalidGuard = yield* Effect.flip(
          fence.acquire({
            guardId: "invalid guard",
            directories: [alpha, ws.dir("missing")],
          }),
        )
        expect(invalidGuard).toBeInstanceOf(
          DirectoryMaintenanceGuard.InvalidGuardIDError,
        )

        const duplicate = yield* Effect.flip(
          fence.acquire({
            guardId: "g3-duplicate",
            directories: [alpha, alpha],
          }),
        )
        expect(duplicate).toBeInstanceOf(
          DirectoryMaintenanceGuard.DuplicateDirectoryError,
        )
      }),
    ),
  )

  test("source remains an internal thin wrapper with no authority or transport surface", async () => {
    const source = await readFile(
      join(import.meta.dir, "../src/directory-activity-fence.ts"),
      "utf8",
    )

    for (const forbidden of [
      "DirectoryMaintenanceGuardTable",
      'from "./database/',
      "RuntimeOwner",
      "EventV2",
      "ProjectTable",
      "Worktree",
      "InstanceStore",
      "LocationServiceMap",
      "server/routes",
      "protocol",
      "sdk",
      "resolveReconcileRequired",
      "reconcile:",
    ]) {
      expect(source).not.toContain(forbidden)
    }
    expect(source).toContain("deps: [DirectoryMaintenanceGuard.node]")
  })
})
