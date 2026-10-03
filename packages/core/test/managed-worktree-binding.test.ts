import { describe, expect, test } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { Cause, Effect, Exit } from "effect"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { DirectoryMaintenanceGuard } from "@opencode-ai/core/directory-maintenance-guard"
import { ManagedWorktreeBinding } from "@opencode-ai/core/managed-worktree-binding"
import { ManagedWorktreeBindingTable } from "@opencode-ai/core/managed-worktree-binding.sql"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { testEffect } from "./lib/effect"

const nodes = () => LayerNode.group([Database.node, ManagedWorktreeBinding.node])
const layer = AppNodeBuilder.build(nodes(), [[Database.node, Database.layerFromPath(":memory:")]])
const it = testEffect(layer)

type DirectoryKey = ManagedWorktreeBinding.DirectoryKey
type BindingState = ManagedWorktreeBinding.BindingState
type CreateObservation = ManagedWorktreeBinding.CreateInitializeObservation
type StatusObservation = ManagedWorktreeBinding.StatusObservation
type TableRow = typeof ManagedWorktreeBindingTable.$inferSelect

const HEAD = "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1"
const HEAD_NEXT = "c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2"
const INSTALLATION = "install_test"
const REPOSITORY = "repo_test"
const WORKTREE = "wt_test"
const VOLUME = "vol_test"
const PROJECT = "project_test"
const BRANCH = "refs/heads/feature/managed"
const PIN = "refs/worktree-store/pins/wt_test"

const NAMES = ["alpha", "bravo", "charlie", "delta"] as const

const physicalKey = (path: string): DirectoryKey => {
  const key = DirectoryMaintenanceGuard.existingDirectoryKey(path, process.platform)
  if (key === undefined) throw new Error(`expected an existing physical directory key for ${path}`)
  return key
}

interface Workspace {
  readonly root: string
  readonly dir: (name: string) => string
  readonly key: (path: string) => DirectoryKey
}

const withWorkspace = <A, E, R>(body: (workspace: Workspace) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "openfork-managed-binding-")))
    yield* Effect.addFinalizer(() => Effect.promise(() => rm(root, { recursive: true, force: true })))
    const dir = (name: string) => join(root, name)
    yield* Effect.promise(() => Promise.all(NAMES.map((name) => mkdir(dir(name), { recursive: true }))))
    return yield* body({ root, dir, key: physicalKey })
  })

const aliasTo = (target: string, alias: string) =>
  Effect.promise(() => symlink(target, alias, process.platform === "win32" ? "junction" : "dir"))

const intent = (directory: string, overrides: Partial<ManagedWorktreeBinding.CreationIntentInput> = {}) =>
  ({
    directory,
    installationId: INSTALLATION,
    repositoryId: REPOSITORY,
    worktreeId: WORKTREE,
    storageVolumeId: VOLUME,
    projectId: PROJECT,
    branchRef: BRANCH,
    pinRef: PIN,
    ...overrides,
  }) satisfies ManagedWorktreeBinding.CreationIntentInput

const createObservation = (
  directory: string,
  key: DirectoryKey,
  overrides: Partial<CreateObservation> = {},
): CreateObservation => ({
  installationId: INSTALLATION,
  repositoryId: REPOSITORY,
  worktreeId: WORKTREE,
  storageVolumeId: VOLUME,
  targetPath: directory,
  pathKey: key,
  ownership: "managed",
  lifecycleState: "idle_clean",
  durabilityClass: "reconstructable_clean",
  revision: 4,
  head: HEAD,
  branchRef: BRANCH,
  pinRef: PIN,
  createOperationId: "op_create",
  initializationOperationId: "op_initialize",
  ...overrides,
})

const statusObservation = (
  directory: string,
  key: DirectoryKey,
  overrides: Partial<StatusObservation> = {},
): StatusObservation => ({
  installationId: INSTALLATION,
  repositoryId: REPOSITORY,
  worktreeId: WORKTREE,
  storageVolumeId: VOLUME,
  targetPath: directory,
  pathKey: key,
  ownership: "managed",
  lifecycleState: "idle_clean",
  durabilityClass: "reconstructable_clean",
  revision: 4,
  head: HEAD,
  branchRef: BRANCH,
  pinRef: PIN,
  quarantined: false,
  reconcileRequired: false,
  openOperationCount: 0,
  unresolvedGuardAttemptCount: 0,
  ...overrides,
})

const recordIntent = (directory: string, overrides: Partial<ManagedWorktreeBinding.CreationIntentInput> = {}) =>
  Effect.gen(function* () {
    const bindings = yield* ManagedWorktreeBinding.Service
    const result = yield* bindings.recordCreationIntent(intent(directory, overrides))
    if (result.state !== "recorded") return yield* Effect.die("expected a recorded creation intent")
    return result.binding
  })

const activateExact = (
  directory: string,
  generation: number,
  overrides: Partial<CreateObservation> = {},
  operationId = "op_invoke",
) =>
  Effect.gen(function* () {
    const bindings = yield* ManagedWorktreeBinding.Service
    return yield* bindings.activate({
      directory,
      expectedGeneration: generation,
      operationId,
      observation: createObservation(directory, physicalKey(directory), overrides),
    })
  })

const bindingRows = () =>
  Database.Service.use(({ db }) => db.select().from(ManagedWorktreeBindingTable).all().pipe(Effect.orDie))

const bindingRow = (directory: DirectoryKey) =>
  Database.Service.use(({ db }) =>
    db.select().from(ManagedWorktreeBindingTable).where(eq(ManagedWorktreeBindingTable.directory, directory)).get().pipe(Effect.orDie),
  )

const rawUpdate = (directory: DirectoryKey, values: Partial<typeof ManagedWorktreeBindingTable.$inferInsert>) =>
  Database.Service.use(({ db }) =>
    db
      .update(ManagedWorktreeBindingTable)
      .set(values)
      .where(eq(ManagedWorktreeBindingTable.directory, directory))
      .run()
      .pipe(Effect.exit),
  )

const seedBinding = (input: {
  readonly directory: DirectoryKey
  readonly bindingState?: BindingState
  readonly generation?: number
  readonly head?: string | null
  readonly managerRevision?: number | null
  readonly lifecycleState?: string | null
  readonly operationId?: string | null
  readonly activatedAt?: number | null
  readonly reconciledAt?: number | null
  readonly quarantinedAt?: number | null
  readonly retiredAt?: number | null
}) =>
  Database.Service.use(({ db }) =>
    db
      .insert(ManagedWorktreeBindingTable)
      .values({
        directory: input.directory,
        binding_state: input.bindingState ?? "handoff_pending",
        generation: input.generation ?? 1,
        installation_id: INSTALLATION,
        repository_id: REPOSITORY,
        worktree_id: WORKTREE,
        storage_volume_id: VOLUME,
        project_id: PROJECT,
        workspace_id: null,
        branch_ref: BRANCH,
        pin_ref: PIN,
        head: input.head ?? null,
        manager_revision: input.managerRevision ?? null,
        lifecycle_state: input.lifecycleState ?? null,
        operation_id: input.operationId ?? null,
        create_operation_id: null,
        initialization_operation_id: null,
        state_reason: "seeded",
        evidence_json: null,
        created_at: 10,
        activated_at: input.activatedAt ?? null,
        reconciled_at: input.reconciledAt ?? null,
        quarantined_at: input.quarantinedAt ?? null,
        retired_at: input.retiredAt ?? null,
        updated_at: 11,
      })
      .run()
      .pipe(Effect.orDie),
  )

describe("ManagedWorktreeBinding creation intent", () => {
  it.effect("rejects non-physical directories and non-canonical identities", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const bindings = yield* ManagedWorktreeBinding.Service

        const missing = yield* bindings.recordCreationIntent(intent(ws.dir("missing"))).pipe(Effect.flip)
        expect(missing).toBeInstanceOf(ManagedWorktreeBinding.InvalidDirectoryError)
        const relative = yield* bindings.recordCreationIntent(intent("relative/path")).pipe(Effect.flip)
        expect(relative).toBeInstanceOf(ManagedWorktreeBinding.InvalidDirectoryError)

        const paddedWorktree = yield* bindings
          .recordCreationIntent(intent(ws.dir("alpha"), { worktreeId: `${WORKTREE} ` }))
          .pipe(Effect.flip)
        expect(paddedWorktree).toBeInstanceOf(ManagedWorktreeBinding.InvalidIdentityError)
        const spacedRepository = yield* bindings
          .recordCreationIntent(intent(ws.dir("alpha"), { repositoryId: "repo two" }))
          .pipe(Effect.flip)
        expect(spacedRepository).toBeInstanceOf(ManagedWorktreeBinding.InvalidIdentityError)
        const shortBranch = yield* bindings
          .recordCreationIntent(intent(ws.dir("alpha"), { branchRef: "feature/managed" }))
          .pipe(Effect.flip)
        expect(shortBranch).toBeInstanceOf(ManagedWorktreeBinding.InvalidIdentityError)
        const escapingPin = yield* bindings
          .recordCreationIntent(intent(ws.dir("alpha"), { pinRef: "refs/heads/pins/../escape" }))
          .pipe(Effect.flip)
        expect(escapingPin).toBeInstanceOf(ManagedWorktreeBinding.InvalidIdentityError)
        const blankWorkspace = yield* bindings
          .recordCreationIntent(intent(ws.dir("alpha"), { workspaceId: "" }))
          .pipe(Effect.flip)
        expect(blankWorkspace).toBeInstanceOf(ManagedWorktreeBinding.InvalidIdentityError)

        expect(yield* bindingRows()).toHaveLength(0)
      }),
    ),
  )

  it.effect("records one durable intent per canonical directory key and reports duplicates", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const bindings = yield* ManagedWorktreeBinding.Service

        const recorded = yield* bindings.recordCreationIntent(intent(ws.dir("alpha")))
        expect(recorded.state).toBe("recorded")
        if (recorded.state !== "recorded") return yield* Effect.die("expected recorded")
        expect(recorded.binding.bindingState).toBe("handoff_pending")
        expect(recorded.binding.generation).toBe(1)
        expect(recorded.binding.directory).toBe(ws.key(ws.dir("alpha")))
        expect(recorded.binding.createdAt).toBeGreaterThan(0)
        expect(recorded.binding.head).toBeNull()
        expect(recorded.binding.projectId).toBe(PROJECT)

        const duplicateDirectory = yield* bindings.recordCreationIntent(intent(ws.dir("alpha")))
        expect(duplicateDirectory).toMatchObject({ state: "duplicate", reason: "directory" })

        // One worktree-store identity may not bind a second live directory.
        const duplicateIdentity = yield* bindings.recordCreationIntent(intent(ws.dir("bravo")))
        expect(duplicateIdentity).toMatchObject({ state: "duplicate", reason: "identity" })

        const other = yield* bindings.recordCreationIntent(intent(ws.dir("charlie"), { worktreeId: "wt_other" }))
        expect(other.state).toBe("recorded")
        expect(yield* bindingRows()).toHaveLength(2)
      }),
    ),
  )

  it.effect("collapses a physical alias spelling onto the same directory key", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const alias = ws.dir("alpha-alias")
        yield* aliasTo(ws.dir("alpha"), alias)
        const spelling = process.platform === "win32" ? alias.replaceAll("\\", "/").toUpperCase() : alias
        const bindings = yield* ManagedWorktreeBinding.Service

        const recorded = yield* bindings.recordCreationIntent(intent(spelling))
        expect(recorded.state).toBe("recorded")
        if (recorded.state !== "recorded") return yield* Effect.die("expected recorded")
        expect(recorded.binding.directory).toBe(ws.key(ws.dir("alpha")))
        expect(yield* bindingRows()).toHaveLength(1)

        const duplicate = yield* bindings.recordCreationIntent(intent(ws.dir("alpha")))
        expect(duplicate).toMatchObject({ state: "duplicate", reason: "directory" })
      }),
    ),
  )

  it.effect("allows a retired identity to bind another directory", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const bindings = yield* ManagedWorktreeBinding.Service
        const alpha = yield* recordIntent(ws.dir("alpha"))
        const retired = yield* bindings.retire({
          directory: ws.dir("alpha"),
          expectedGeneration: alpha.generation,
        })
        expect(retired.state).toBe("retired")

        const rebound = yield* bindings.recordCreationIntent(intent(ws.dir("bravo")))
        expect(rebound.state).toBe("recorded")
        if (rebound.state !== "recorded") return yield* Effect.die("expected recorded")
        expect(rebound.binding.directory).toBe(ws.key(ws.dir("bravo")))
        expect(rebound.binding.bindingState).toBe("handoff_pending")
      }),
    ),
  )
})

describe("ManagedWorktreeBinding activation", () => {
  it.effect("activates only an exact successful create-initialize observation and records evidence", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const bindings = yield* ManagedWorktreeBinding.Service
        const recorded = yield* recordIntent(ws.dir("alpha"))

        const activated = yield* activateExact(ws.dir("alpha"), recorded.generation, {}, "op_invoke_exact")
        expect(activated.state).toBe("activated")
        if (activated.state !== "activated") return yield* Effect.die("expected activation")
        expect(activated.binding.bindingState).toBe("active")
        expect(activated.binding.generation).toBe(recorded.generation + 1)
        expect(activated.binding.head).toBe(HEAD)
        expect(activated.binding.managerRevision).toBe(4)
        expect(activated.binding.lifecycleState).toBe("idle_clean")
        expect(activated.binding.operationId).toBe("op_invoke_exact")
        expect(activated.binding.createOperationId).toBe("op_create")
        expect(activated.binding.initializationOperationId).toBe("op_initialize")
        expect(activated.binding.activatedAt).not.toBeNull()
        expect(activated.binding.reconciledAt).toBeNull()
        expect(activated.binding.retiredAt).toBeNull()
        expect(activated.binding.stateReason).toBe("managed-create-initialize-exact")

        const evidence = JSON.parse(activated.binding.evidenceJson ?? "null")
        expect(evidence.head).toBe(HEAD)
        expect(evidence.revision).toBe(4)
        expect(evidence.worktreeId).toBe(WORKTREE)

        const active = yield* bindings.requireActive(ws.dir("alpha"))
        expect(active.state).toBe("active")
      }),
    ),
  )

  it.effect("every identity or observation mismatch becomes reconcile_required with preserved correlation", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const bindings = yield* ManagedWorktreeBinding.Service
        const probes: ReadonlyArray<{ readonly overrides: Partial<CreateObservation>; readonly reason: string }> = [
          { overrides: { installationId: "install_other" }, reason: "identity-mismatch:installationId" },
          { overrides: { repositoryId: "repo_other" }, reason: "identity-mismatch:repositoryId" },
          { overrides: { worktreeId: "wt_other" }, reason: "identity-mismatch:worktreeId" },
          { overrides: { storageVolumeId: "vol_other" }, reason: "identity-mismatch:storageVolumeId" },
          { overrides: { targetPath: ws.dir("bravo") }, reason: "directory-mismatch" },
          { overrides: { pathKey: ws.key(ws.dir("bravo")) }, reason: "directory-mismatch" },
          { overrides: { ownership: "foreign" }, reason: "ownership-not-managed" },
          { overrides: { lifecycleState: "error" }, reason: "lifecycle-not-idle-clean" },
          { overrides: { durabilityClass: "volatile" }, reason: "durability-not-reconstructable-clean" },
          { overrides: { branchRef: "refs/heads/other" }, reason: "branch-ref-mismatch" },
          { overrides: { pinRef: null }, reason: "pin-ref-mismatch" },
          { overrides: { createOperationId: null, initializationOperationId: null }, reason: "missing-operation-evidence" },
        ]

        for (const [index, probe] of probes.entries()) {
          yield* withWorkspace((scoped) =>
            Effect.gen(function* () {
              const worktreeId = `wt_probe_${index}`
              const recorded = yield* recordIntent(scoped.dir("alpha"), { worktreeId })
              const result = yield* activateExact(scoped.dir("alpha"), recorded.generation, {
                worktreeId,
                ...probe.overrides,
              })
              expect(result.state).toBe("reconcile_required")
              if (result.state !== "reconcile_required") return yield* Effect.die("expected reconcile_required")
              expect(result.reason).toBe(probe.reason)

              const persisted = yield* bindingRow(scoped.key(scoped.dir("alpha")))
              expect(persisted?.binding_state).toBe("reconcile_required")
              expect(persisted?.generation).toBe(2)
              expect(persisted?.state_reason).toBe(probe.reason)
              expect(persisted?.activated_at).toBeNull()
              expect(persisted?.head).toBeNull()
              const evidence = JSON.parse(persisted?.evidence_json ?? "null")
              expect(evidence.reason).toBe(probe.reason)
              expect(evidence.observation.worktreeId).toBe(probe.overrides.worktreeId ?? worktreeId)

              const gate = yield* bindings.requireActive(scoped.dir("alpha"))
              expect(gate.state).toBe("inactive")
            }),
          )
        }
        expect(yield* bindingRows()).toHaveLength(probes.length)
      }),
    ),
  )

  it.effect("a quarantined outcome quarantines and stays terminal", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const bindings = yield* ManagedWorktreeBinding.Service
        const recorded = yield* recordIntent(ws.dir("alpha"))

        const result = yield* activateExact(ws.dir("alpha"), recorded.generation, { lifecycleState: "quarantined" })
        expect(result.state).toBe("quarantined")
        if (result.state !== "quarantined") return yield* Effect.die("expected quarantine")
        expect(result.reason).toBe("manager-quarantine")
        expect(result.binding.bindingState).toBe("quarantined")
        expect(result.binding.quarantinedAt).not.toBeNull()
        expect(result.binding.activatedAt).toBeNull()

        // An exact clean status observation can never lift quarantine.
        const terminal = yield* bindings.reconcileWithStatus({
          directory: ws.dir("alpha"),
          expectedGeneration: result.binding.generation,
          observation: statusObservation(ws.dir("alpha"), ws.key(ws.dir("alpha"))),
        })
        expect(terminal.state).toBe("terminal")
        if (terminal.state === "terminal") expect(terminal.binding.generation).toBe(result.binding.generation)

        // Explicit retirement is the only way out.
        const retired = yield* bindings.retire({
          directory: ws.dir("alpha"),
          expectedGeneration: result.binding.generation,
          reason: "operator-quarantine-retirement",
        })
        expect(retired.state).toBe("retired")
        if (retired.state === "retired") {
          expect(retired.binding.quarantinedAt).not.toBeNull()
          expect(retired.binding.retiredAt).not.toBeNull()
        }
      }),
    ),
  )

  it.effect("malformed observations error with zero durable writes", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const bindings = yield* ManagedWorktreeBinding.Service
        const recorded = yield* recordIntent(ws.dir("alpha"))
        const key = ws.key(ws.dir("alpha"))

        const badRevision = yield* bindings
          .activate({
            directory: ws.dir("alpha"),
            expectedGeneration: recorded.generation,
            operationId: "op_invoke",
            observation: createObservation(ws.dir("alpha"), key, { revision: 0 }),
          })
          .pipe(Effect.flip)
        expect(badRevision).toBeInstanceOf(ManagedWorktreeBinding.InvalidObservationError)
        const badHead = yield* bindings
          .activate({
            directory: ws.dir("alpha"),
            expectedGeneration: recorded.generation,
            operationId: "op_invoke",
            observation: createObservation(ws.dir("alpha"), key, { head: "not-an-object-id" }),
          })
          .pipe(Effect.flip)
        expect(badHead).toBeInstanceOf(ManagedWorktreeBinding.InvalidObservationError)
        const badOperation = yield* bindings
          .activate({
            directory: ws.dir("alpha"),
            expectedGeneration: recorded.generation,
            operationId: "op invoke with spaces",
            observation: createObservation(ws.dir("alpha"), key),
          })
          .pipe(Effect.flip)
        expect(badOperation).toBeInstanceOf(ManagedWorktreeBinding.InvalidObservationError)
        const badStatus = yield* bindings
          .reconcileWithStatus({
            directory: ws.dir("alpha"),
            expectedGeneration: recorded.generation,
            observation: statusObservation(ws.dir("alpha"), key, { openOperationCount: -1 }),
          })
          .pipe(Effect.flip)
        expect(badStatus).toBeInstanceOf(ManagedWorktreeBinding.InvalidObservationError)
        const badReason = yield* bindings
          .markReconcileRequired({
            directory: ws.dir("alpha"),
            expectedGeneration: recorded.generation,
            reason: "control\u0000character",
          })
          .pipe(Effect.flip)
        expect(badReason).toBeInstanceOf(ManagedWorktreeBinding.InvalidReasonError)

        expect(yield* bindingRow(key)).toMatchObject({ binding_state: "handoff_pending", generation: 1 })
      }),
    ),
  )

  it.effect("activation is generation-fenced and state-fenced", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const bindings = yield* ManagedWorktreeBinding.Service
        const recorded = yield* recordIntent(ws.dir("alpha"))

        expect((yield* activateExact(ws.dir("alpha"), recorded.generation + 10)).state).toBe("stale")
        const activated = yield* activateExact(ws.dir("alpha"), recorded.generation)
        expect(activated.state).toBe("activated")
        if (activated.state !== "activated") return yield* Effect.die("expected activation")

        // Re-activation of an active row is stale, and a stale generation can
        // never steer the newer binding.
        expect((yield* activateExact(ws.dir("alpha"), recorded.generation)).state).toBe("stale")
        expect((yield* activateExact(ws.dir("alpha"), activated.binding.generation)).state).toBe("stale")

        const persisted = yield* bindingRow(ws.key(ws.dir("alpha")))
        expect(persisted).toMatchObject({ binding_state: "active", generation: activated.binding.generation })
      }),
    ),
  )

  it.effect("an ambiguous invocation without an observation records reconcile_required with evidence", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const bindings = yield* ManagedWorktreeBinding.Service
        const recorded = yield* recordIntent(ws.dir("alpha"))

        const marked = yield* bindings.markReconcileRequired({
          directory: ws.dir("alpha"),
          expectedGeneration: recorded.generation,
          reason: "manager-invocation-failed",
          evidence: "managed-create-initialize timed out after 30s; outcome unknown",
        })
        expect(marked.state).toBe("reconcile_required")
        if (marked.state !== "reconcile_required") return yield* Effect.die("expected reconcile_required")
        expect(marked.binding.bindingState).toBe("reconcile_required")
        expect(marked.binding.generation).toBe(2)
        expect(marked.binding.reconciledAt).not.toBeNull()
        const evidence = JSON.parse(marked.binding.evidenceJson ?? "null")
        expect(evidence.reason).toBe("manager-invocation-failed")
        expect(evidence.evidence).toContain("timed out")

        // A reconciled row is not activatable by another creation observation;
        // re-proof is a status reconciliation.
        expect((yield* activateExact(ws.dir("alpha"), marked.binding.generation)).state).toBe("stale")
        const again = yield* bindings.markReconcileRequired({
          directory: ws.dir("alpha"),
          expectedGeneration: marked.binding.generation,
          reason: "second-attempt",
        })
        expect(again.state).toBe("stale")
        expect((yield* bindingRow(ws.key(ws.dir("alpha"))))?.state_reason).toBe("manager-invocation-failed")

        const gate = yield* bindings.requireActive(ws.dir("alpha"))
        expect(gate.state).toBe("inactive")
      }),
    ),
  )

  it.effect("only active bindings are loadable", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const bindings = yield* ManagedWorktreeBinding.Service
        const recorded = yield* recordIntent(ws.dir("alpha"))

        const missing = yield* bindings.requireActive(ws.dir("bravo"))
        expect(missing.state).toBe("inactive")
        expect(missing.binding).toBeUndefined()

        const pending = yield* bindings.requireActive(ws.dir("alpha"))
        expect(pending.state).toBe("inactive")
        expect(pending.binding?.bindingState).toBe("handoff_pending")
        expect((yield* bindings.get(ws.dir("alpha")))?.bindingState).toBe("handoff_pending")

        const activated = yield* activateExact(ws.dir("alpha"), recorded.generation)
        if (activated.state !== "activated") return yield* Effect.die("expected activation")
        expect((yield* bindings.requireActive(ws.dir("alpha"))).state).toBe("active")

        const retired = yield* bindings.retire({
          directory: ws.dir("alpha"),
          expectedGeneration: activated.binding.generation,
        })
        expect(retired.state).toBe("retired")
        const afterRetire = yield* bindings.requireActive(ws.dir("alpha"))
        expect(afterRetire.state).toBe("inactive")
        expect(afterRetire.binding?.bindingState).toBe("retired")
      }),
    ),
  )
})

describe("ManagedWorktreeBinding status reconciliation", () => {
  it.effect("activates handoff_pending and reconcile_required only on exact clean identities", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const bindings = yield* ManagedWorktreeBinding.Service

        const pending = yield* recordIntent(ws.dir("alpha"))
        const fromPending = yield* bindings.reconcileWithStatus({
          directory: ws.dir("alpha"),
          expectedGeneration: pending.generation,
          observation: statusObservation(ws.dir("alpha"), ws.key(ws.dir("alpha"))),
        })
        expect(fromPending.state).toBe("activated")
        if (fromPending.state !== "activated") return yield* Effect.die("expected activation")
        expect(fromPending.binding.bindingState).toBe("active")
        expect(fromPending.binding.head).toBe(HEAD)
        expect(fromPending.binding.managerRevision).toBe(4)
        expect(fromPending.binding.activatedAt).not.toBeNull()
        expect(fromPending.binding.operationId).toBeNull()

        const reconciled = yield* recordIntent(ws.dir("bravo"), { worktreeId: "wt_bravo" })
        const marked = yield* bindings.markReconcileRequired({
          directory: ws.dir("bravo"),
          expectedGeneration: reconciled.generation,
          reason: "ambiguous-create",
        })
        if (marked.state !== "reconcile_required") return yield* Effect.die("expected reconcile_required")

        const fromReconcile = yield* bindings.reconcileWithStatus({
          directory: ws.dir("bravo"),
          expectedGeneration: marked.binding.generation,
          observation: statusObservation(ws.dir("bravo"), ws.key(ws.dir("bravo")), { worktreeId: "wt_bravo" }),
        })
        expect(fromReconcile.state).toBe("activated")
        if (fromReconcile.state === "activated") {
          expect(fromReconcile.binding.generation).toBe(3)
          expect(fromReconcile.binding.bindingState).toBe("active")
        }
      }),
    ),
  )

  it.effect("active bindings stay unchanged on head/revision drift but degrade on identity failure", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const bindings = yield* ManagedWorktreeBinding.Service
        const recorded = yield* recordIntent(ws.dir("alpha"))
        const activated = yield* activateExact(ws.dir("alpha"), recorded.generation)
        if (activated.state !== "activated") return yield* Effect.die("expected activation")

        const drift = yield* bindings.reconcileWithStatus({
          directory: ws.dir("alpha"),
          expectedGeneration: activated.binding.generation,
          observation: statusObservation(ws.dir("alpha"), ws.key(ws.dir("alpha")), {
            head: HEAD_NEXT,
            revision: 9,
          }),
        })
        expect(drift.state).toBe("unchanged")
        const persisted = yield* bindingRow(ws.key(ws.dir("alpha")))
        expect(persisted).toMatchObject({
          binding_state: "active",
          generation: activated.binding.generation,
          head: HEAD,
          manager_revision: 4,
        })

        const mismatch = yield* bindings.reconcileWithStatus({
          directory: ws.dir("alpha"),
          expectedGeneration: activated.binding.generation,
          observation: statusObservation(ws.dir("alpha"), ws.key(ws.dir("alpha")), { worktreeId: "wt_other" }),
        })
        expect(mismatch.state).toBe("reconcile_required")
        if (mismatch.state !== "reconcile_required") return yield* Effect.die("expected reconcile_required")
        expect(mismatch.reason).toBe("identity-mismatch:worktreeId")
        expect(mismatch.binding.generation).toBe(activated.binding.generation + 1)
        expect(mismatch.binding.head).toBe(HEAD)
        const evidence = JSON.parse(mismatch.binding.evidenceJson ?? "null")
        expect(evidence.reason).toBe("identity-mismatch:worktreeId")
      }),
    ),
  )

  it.effect("manager quarantine and reconcile evidence degrade active bindings", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const bindings = yield* ManagedWorktreeBinding.Service
        const recorded = yield* recordIntent(ws.dir("alpha"))
        const activated = yield* activateExact(ws.dir("alpha"), recorded.generation)
        if (activated.state !== "activated") return yield* Effect.die("expected activation")

        const managerReconcile = yield* bindings.reconcileWithStatus({
          directory: ws.dir("alpha"),
          expectedGeneration: activated.binding.generation,
          observation: statusObservation(ws.dir("alpha"), ws.key(ws.dir("alpha")), { reconcileRequired: true }),
        })
        expect(managerReconcile.state).toBe("reconcile_required")
        if (managerReconcile.state === "reconcile_required") {
          expect(managerReconcile.reason).toBe("manager-reconcile-required")
        }

        const second = yield* recordIntent(ws.dir("bravo"), { worktreeId: "wt_bravo" })
        const secondActivated = yield* activateExact(ws.dir("bravo"), second.generation, { worktreeId: "wt_bravo" })
        if (secondActivated.state !== "activated") return yield* Effect.die("expected activation")
        const quarantined = yield* bindings.reconcileWithStatus({
          directory: ws.dir("bravo"),
          expectedGeneration: secondActivated.binding.generation,
          observation: statusObservation(ws.dir("bravo"), ws.key(ws.dir("bravo")), {
            worktreeId: "wt_bravo",
            quarantined: true,
            lifecycleState: "quarantined",
          }),
        })
        expect(quarantined.state).toBe("quarantined")
        if (quarantined.state === "quarantined") {
          expect(quarantined.binding.quarantinedAt).not.toBeNull()
        }

        const third = yield* recordIntent(ws.dir("charlie"), { worktreeId: "wt_charlie" })
        const thirdActivated = yield* activateExact(ws.dir("charlie"), third.generation, { worktreeId: "wt_charlie" })
        if (thirdActivated.state !== "activated") return yield* Effect.die("expected activation")
        const openOperations = yield* bindings.reconcileWithStatus({
          directory: ws.dir("charlie"),
          expectedGeneration: thirdActivated.binding.generation,
          observation: statusObservation(ws.dir("charlie"), ws.key(ws.dir("charlie")), {
            worktreeId: "wt_charlie",
            openOperationCount: 2,
          }),
        })
        expect(openOperations.state).toBe("reconcile_required")
        if (openOperations.state === "reconcile_required") {
          expect(openOperations.reason).toBe("open-operations")
        }
      }),
    ),
  )

  it.effect("terminal states are never lifted by status evidence", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const bindings = yield* ManagedWorktreeBinding.Service

        yield* seedBinding({
          directory: ws.key(ws.dir("alpha")),
          bindingState: "quarantined",
          generation: 3,
          quarantinedAt: 12,
        })
        const quarantined = yield* bindings.reconcileWithStatus({
          directory: ws.dir("alpha"),
          expectedGeneration: 3,
          observation: statusObservation(ws.dir("alpha"), ws.key(ws.dir("alpha"))),
        })
        expect(quarantined.state).toBe("terminal")
        expect((yield* bindingRow(ws.key(ws.dir("alpha"))))?.generation).toBe(3)

        const recorded = yield* recordIntent(ws.dir("bravo"), { worktreeId: "wt_bravo" })
        const activated = yield* activateExact(ws.dir("bravo"), recorded.generation, { worktreeId: "wt_bravo" })
        if (activated.state !== "activated") return yield* Effect.die("expected activation")
        const retired = yield* bindings.retire({
          directory: ws.dir("bravo"),
          expectedGeneration: activated.binding.generation,
        })
        if (retired.state !== "retired") return yield* Effect.die("expected retirement")
        const afterRetire = yield* bindings.reconcileWithStatus({
          directory: ws.dir("bravo"),
          expectedGeneration: retired.binding.generation,
          observation: statusObservation(ws.dir("bravo"), ws.key(ws.dir("bravo")), { worktreeId: "wt_bravo" }),
        })
        expect(afterRetire.state).toBe("terminal")
        expect((yield* bindingRow(ws.key(ws.dir("bravo"))))?.generation).toBe(retired.binding.generation)
      }),
    ),
  )

  it.effect("reconciliation is generation-fenced and malformed observations never write", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const bindings = yield* ManagedWorktreeBinding.Service
        const recorded = yield* recordIntent(ws.dir("alpha"))

        const stale = yield* bindings.reconcileWithStatus({
          directory: ws.dir("alpha"),
          expectedGeneration: recorded.generation + 5,
          observation: statusObservation(ws.dir("alpha"), ws.key(ws.dir("alpha"))),
        })
        expect(stale.state).toBe("stale")

        // Ambiguous evidence on a pending row transitions to reconcile_required.
        const ambiguous = yield* bindings.reconcileWithStatus({
          directory: ws.dir("alpha"),
          expectedGeneration: recorded.generation,
          observation: statusObservation(ws.dir("alpha"), ws.key(ws.dir("alpha")), { ownership: "foreign" }),
        })
        expect(ambiguous.state).toBe("reconcile_required")
        if (ambiguous.state !== "reconcile_required") return yield* Effect.die("expected reconcile_required")
        expect(ambiguous.reason).toBe("ownership-not-managed")
        expect(ambiguous.binding.generation).toBe(2)

        // Ambiguous evidence on a reconcile_required row leaves it there with
        // zero writes.
        const remains = yield* bindings.reconcileWithStatus({
          directory: ws.dir("alpha"),
          expectedGeneration: 2,
          observation: statusObservation(ws.dir("alpha"), ws.key(ws.dir("alpha")), { reconcileRequired: true }),
        })
        expect(remains.state).toBe("reconcile_required")
        if (remains.state !== "reconcile_required") return yield* Effect.die("expected reconcile_required")
        expect(remains.binding.generation).toBe(2)
        expect(remains.reason).toBe("manager-reconcile-required")
      }),
    ),
  )
})

describe("ManagedWorktreeBinding retirement", () => {
  it.effect("retirement is explicit, generation-fenced, and terminal", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const bindings = yield* ManagedWorktreeBinding.Service
        const recorded = yield* recordIntent(ws.dir("alpha"))

        expect(
          (yield* bindings.retire({ directory: ws.dir("alpha"), expectedGeneration: recorded.generation + 1 })).state,
        ).toBe("stale")
        const retired = yield* bindings.retire({
          directory: ws.dir("alpha"),
          expectedGeneration: recorded.generation,
          reason: "operator-abandoned",
        })
        expect(retired.state).toBe("retired")
        if (retired.state !== "retired") return yield* Effect.die("expected retirement")
        expect(retired.binding.bindingState).toBe("retired")
        expect(retired.binding.generation).toBe(2)
        expect(retired.binding.retiredAt).not.toBeNull()
        expect(retired.binding.stateReason).toBe("operator-abandoned")

        expect(
          (yield* bindings.retire({ directory: ws.dir("alpha"), expectedGeneration: retired.binding.generation })).state,
        ).toBe("stale")
        expect((yield* activateExact(ws.dir("alpha"), retired.binding.generation)).state).toBe("stale")
        expect(
          (
            yield* bindings.markReconcileRequired({
              directory: ws.dir("alpha"),
              expectedGeneration: retired.binding.generation,
              reason: "resurrect",
            })
          ).state,
        ).toBe("stale")
        expect((yield* bindingRow(ws.key(ws.dir("alpha"))))?.binding_state).toBe("retired")
      }),
    ),
  )
})

describe("ManagedWorktreeBinding durable authority triggers", () => {
  it.effect("rejects raw deletion and replacement of non-retired rows", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const bindings = yield* ManagedWorktreeBinding.Service
        const recorded = yield* recordIntent(ws.dir("alpha"))
        const key = ws.key(ws.dir("alpha"))
        const { db } = yield* Database.Service

        const deletion = yield* db
          .delete(ManagedWorktreeBindingTable)
          .where(eq(ManagedWorktreeBindingTable.directory, key))
          .run()
          .pipe(Effect.exit)
        expect(Exit.isFailure(deletion)).toBe(true)
        if (Exit.isFailure(deletion)) {
          expect(Cause.pretty(deletion.cause)).toContain("managed_worktree_binding rows are not deletable while non-retired")
        }

        // WITH recursive_triggers OFF, REPLACE deletes the conflicting row
        // without firing the DELETE trigger, so the BEFORE INSERT guard is the
        // only defense that can see this rewrite.
        const replacement = yield* db
          .run(sql`INSERT OR REPLACE INTO managed_worktree_binding SELECT * FROM managed_worktree_binding`)
          .pipe(Effect.exit)
        expect(Exit.isFailure(replacement)).toBe(true)
        if (Exit.isFailure(replacement)) {
          expect(Cause.pretty(replacement.cause)).toContain("managed_worktree_binding rows are never replaceable")
        }

        const duplicateInsert = yield* db.run(sql`
          INSERT INTO managed_worktree_binding (directory, binding_state, generation, installation_id, repository_id, worktree_id, storage_volume_id, project_id, branch_ref, created_at, updated_at)
          VALUES (${key}, 'handoff_pending', 1, ${INSTALLATION}, ${REPOSITORY}, ${WORKTREE}, ${VOLUME}, ${PROJECT}, ${BRANCH}, 1, 1)
        `).pipe(Effect.exit)
        expect(Exit.isFailure(duplicateInsert)).toBe(true)
        expect(yield* bindingRow(key)).toMatchObject({
          binding_state: "handoff_pending",
          generation: recorded.generation,
        })

        const retired = yield* bindings.retire({ directory: ws.dir("alpha"), expectedGeneration: recorded.generation })
        if (retired.state !== "retired") return yield* Effect.die("expected retirement")
        const deletionAfterRetire = yield* db
          .delete(ManagedWorktreeBindingTable)
          .where(eq(ManagedWorktreeBindingTable.directory, key))
          .run()
          .pipe(Effect.exit)
        expect(Exit.isSuccess(deletionAfterRetire)).toBe(true)
        expect(yield* bindingRow(key)).toBeUndefined()
      }),
    ),
  )

  it.effect("raw identity is immutable and observation evidence is write-once", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const recorded = yield* recordIntent(ws.dir("alpha"))
        const activated = yield* activateExact(ws.dir("alpha"), recorded.generation)
        if (activated.state !== "activated") return yield* Effect.die("expected activation")
        const key = ws.key(ws.dir("alpha"))

        for (const immutable of [
          { project_id: "project_forged" },
          { workspace_id: "workspace_forged" },
          { installation_id: "install_forged" },
          { repository_id: "repo_forged" },
          { worktree_id: "wt_forged" },
          { storage_volume_id: "vol_forged" },
          { branch_ref: "refs/heads/other" },
          { pin_ref: "refs/worktree-store/pins/other" },
          { created_at: 1 },
          { head: HEAD_NEXT },
          { manager_revision: 9 },
          { lifecycle_state: "error" },
          { operation_id: "op_other" },
          { create_operation_id: "op_other" },
          { initialization_operation_id: "op_other" },
          { activated_at: 99 },
        ] satisfies ReadonlyArray<Partial<typeof ManagedWorktreeBindingTable.$inferInsert>>) {
          expect(Exit.isFailure(yield* rawUpdate(key, immutable))).toBe(true)
        }

        // Same-state audit refresh is allowed and cannot touch authority.
        expect(Exit.isSuccess(yield* rawUpdate(key, { state_reason: "audited", updated_at: 99 }))).toBe(true)
        expect(yield* bindingRow(key)).toMatchObject({
          binding_state: "active",
          generation: activated.binding.generation,
          head: HEAD,
          project_id: PROJECT,
          state_reason: "audited",
        })
      }),
    ),
  )

  it.effect("enforces the monotonic generation CAS and the exact transition graph", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        const bindings = yield* ManagedWorktreeBinding.Service
        const recorded = yield* recordIntent(ws.dir("alpha"))
        const key = ws.key(ws.dir("alpha"))

        // Same-state writes may not bump the generation, and state changes
        // must strictly increase it.
        expect(Exit.isFailure(yield* rawUpdate(key, { generation: 2 }))).toBe(true)
        expect(Exit.isFailure(yield* rawUpdate(key, { binding_state: "reconcile_required", reconciled_at: 20 }))).toBe(
          true,
        )
        expect(Exit.isFailure(yield* rawUpdate(key, { generation: 0 }))).toBe(true)
        expect(Exit.isSuccess(yield* rawUpdate(key, { generation: 1, updated_at: 12 }))).toBe(true)

        // Legal states require their complete evidence.
        expect(Exit.isFailure(yield* rawUpdate(key, { binding_state: "active", generation: 2 }))).toBe(true)
        expect(
          Exit.isFailure(
            yield* rawUpdate(key, {
              binding_state: "active",
              generation: 2,
              head: HEAD,
              manager_revision: 4,
              lifecycle_state: "idle_clean",
            }),
          ),
        ).toBe(true)
        expect(Exit.isFailure(yield* rawUpdate(key, { binding_state: "retired", generation: 2 }))).toBe(true)
        expect(Exit.isFailure(yield* rawUpdate(key, { binding_state: "quarantined", generation: 2 }))).toBe(true)
        expect(
          Exit.isFailure(yield* rawUpdate(key, { binding_state: "reconcile_required", generation: 2 })),
        ).toBe(true)
        // active transitions may not resurrect a retired or quarantined row and
        // may not omit activation evidence.
        expect(
          Exit.isSuccess(
            yield* rawUpdate(key, { binding_state: "reconcile_required", generation: 2, reconciled_at: 20 }),
          ),
        ).toBe(true)
        expect(Exit.isFailure(yield* rawUpdate(key, { binding_state: "handoff_pending", generation: 3 }))).toBe(true)
        expect(
          Exit.isSuccess(yield* rawUpdate(key, { binding_state: "quarantined", generation: 3, quarantined_at: 21 })),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* rawUpdate(key, {
              binding_state: "active",
              generation: 4,
              head: HEAD,
              manager_revision: 4,
              lifecycle_state: "idle_clean",
              activated_at: 22,
            }),
          ),
        ).toBe(true)

        const retired = yield* bindings.retire({ directory: ws.dir("alpha"), expectedGeneration: 3 })
        expect(retired.state).toBe("retired")
        if (retired.state !== "retired") return yield* Effect.die("expected retirement")
        expect(Exit.isFailure(yield* rawUpdate(key, { binding_state: "handoff_pending", generation: 5 }))).toBe(true)
        expect(Exit.isSuccess(yield* rawUpdate(key, { updated_at: 30 }))).toBe(true)
        expect(yield* bindingRow(key)).toMatchObject({ binding_state: "retired", generation: 4 })
      }),
    ),
  )

  it.effect("publishes the canonical durable triggers", () =>
    withWorkspace((ws) =>
      Effect.gen(function* () {
        yield* recordIntent(ws.dir("alpha"))
        const { readDb } = yield* Database.Service
        const names = yield* readDb
          .all<{ name: string }>(
            sql`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'managed_worktree_binding'`,
          )
          .pipe(Effect.orDie)
        expect(names.map((row) => row.name).sort()).toEqual(
          [
            "managed_worktree_binding_authority_update",
            "managed_worktree_binding_no_delete",
            "managed_worktree_binding_no_replace",
          ].sort(),
        )
      }),
    ),
  )
})

describe("ManagedWorktreeBinding restart persistence", () => {
  test("file-backed authority survives a graph restart and keeps enforcing triggers", async () => {
    const root = await mkdtemp(join(tmpdir(), "openfork-managed-binding-restart-"))
    const databasePath = join(root, "openfork.db")
    const alpha = join(root, "alpha")
    const bravo = join(root, "bravo")
    const makeLayer = () => AppNodeBuilder.build(nodes(), [[Database.node, Database.layerFromPath(databasePath)]])

    try {
      await mkdir(alpha)
      await mkdir(bravo)
      const alphaKey = physicalKey(alpha)

      const first = await Effect.runPromise(
        Effect.gen(function* () {
          const bindings = yield* ManagedWorktreeBinding.Service
          const recorded = yield* bindings.recordCreationIntent(intent(alpha))
          if (recorded.state !== "recorded") return yield* Effect.die("expected recorded intent")
          const activated = yield* bindings.activate({
            directory: alpha,
            expectedGeneration: recorded.binding.generation,
            operationId: "op_invoke_restart",
            observation: createObservation(alpha, alphaKey),
          })
          if (activated.state !== "activated") return yield* Effect.die("expected activation")
          return activated.binding
        }).pipe(Effect.scoped, Effect.provide(makeLayer())),
      )
      expect(first.bindingState).toBe("active")
      expect(first.generation).toBe(2)

      const reopened = await Effect.runPromise(
        Effect.gen(function* () {
          const bindings = yield* ManagedWorktreeBinding.Service
          const active = yield* bindings.requireActive(alpha)
          const { db } = yield* Database.Service
          const deletion = yield* db
            .delete(ManagedWorktreeBindingTable)
            .where(eq(ManagedWorktreeBindingTable.directory, alphaKey))
            .run()
            .pipe(Effect.exit)
          // A stale generation from a previous process incarnation is rejected.
          const stale = yield* bindings.retire({ directory: alpha, expectedGeneration: 1 })
          const retired = yield* bindings.retire({ directory: alpha, expectedGeneration: 2, reason: "restart-retire" })
          const rebound = yield* bindings.recordCreationIntent(intent(bravo, { worktreeId: "wt_restart" }))
          return { active, deletion, stale, retired, rebound }
        }).pipe(Effect.scoped, Effect.provide(makeLayer())),
      )

      expect(reopened.active.state).toBe("active")
      if (reopened.active.state === "active") {
        expect(reopened.active.binding.generation).toBe(2)
        expect(reopened.active.binding.head).toBe(HEAD)
        expect(reopened.active.binding.operationId).toBe("op_invoke_restart")
        expect(reopened.active.binding.bindingState).toBe("active")
      }
      expect(Exit.isFailure(reopened.deletion)).toBe(true)
      expect(reopened.stale).toEqual({ state: "stale" })
      expect(reopened.retired.state).toBe("retired")
      expect(reopened.rebound.state).toBe("recorded")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
