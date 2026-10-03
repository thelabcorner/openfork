export * as ManagedWorktreeBinding from "./managed-worktree-binding"

import type { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { and, eq, ne } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "./database/database"
import { DirectoryMaintenanceGuard, existingDirectoryKey } from "./directory-maintenance-guard"
import { ManagedWorktreeBindingTable } from "./managed-worktree-binding.sql"
import { makeGlobalNode } from "./effect/app-node"

export type State = typeof ManagedWorktreeBindingTable.$inferSelect.binding_state
export type BindingState = State
/** Same strict physical directory identity as DirectoryMaintenanceGuard. */
export type DirectoryKey = DirectoryMaintenanceGuard.DirectoryKey

export class InvalidDirectoryError extends Schema.TaggedErrorClass<InvalidDirectoryError>()(
  "ManagedWorktreeBinding.InvalidDirectoryError",
  { directory: Schema.String },
) {}

export class InvalidIdentityError extends Schema.TaggedErrorClass<InvalidIdentityError>()(
  "ManagedWorktreeBinding.InvalidIdentityError",
  { field: Schema.String, value: Schema.String },
) {}

export class InvalidObservationError extends Schema.TaggedErrorClass<InvalidObservationError>()(
  "ManagedWorktreeBinding.InvalidObservationError",
  { reason: Schema.String },
) {}

export class InvalidReasonError extends Schema.TaggedErrorClass<InvalidReasonError>()(
  "ManagedWorktreeBinding.InvalidReasonError",
  { reason: Schema.String },
) {}

export type Error = InvalidDirectoryError | InvalidIdentityError | InvalidObservationError | InvalidReasonError

/**
 * Durable creation intent, inserted BEFORE the managed manager is invoked. The
 * directory is a raw operating-system spelling that must resolve to an existing
 * physical directory; the service canonicalizes it with
 * `DirectoryMaintenanceGuard.existingDirectoryKey` and never compares raw paths.
 */
export interface CreationIntentInput {
  readonly directory: string
  readonly installationId: string
  readonly repositoryId: string
  readonly worktreeId: string
  readonly storageVolumeId: string
  readonly projectId: string
  readonly workspaceId?: string | null
  readonly branchRef: string
  readonly pinRef?: string | null
}

/** Exact successful managed-create-initialize evidence. */
export interface CreateInitializeObservation {
  readonly installationId: string
  readonly repositoryId: string
  readonly worktreeId: string
  readonly storageVolumeId: string
  readonly targetPath: string
  readonly pathKey: string
  readonly ownership: string
  readonly lifecycleState: string
  readonly durabilityClass: string
  readonly revision: number
  readonly head: string
  readonly branchRef: string | null
  readonly pinRef: string | null
  readonly createOperationId: string | null
  readonly initializationOperationId: string | null
  readonly quarantined?: boolean
}

/** Exact managed-status evidence used for reconciliation. */
export interface StatusObservation {
  readonly installationId: string
  readonly repositoryId: string
  readonly worktreeId: string
  readonly storageVolumeId: string
  readonly targetPath: string
  readonly pathKey: string
  readonly ownership: string
  readonly lifecycleState: string
  readonly durabilityClass: string
  readonly revision: number
  readonly head: string
  readonly branchRef: string | null
  readonly pinRef: string | null
  readonly quarantined: boolean
  readonly reconcileRequired: boolean
  readonly openOperationCount: number
  readonly unresolvedGuardAttemptCount: number
}

export interface ActivateInput {
  readonly directory: string
  readonly expectedGeneration: number
  /** Correlation of the managed-create-initialize invocation that produced the observation. */
  readonly operationId: string
  readonly observation: CreateInitializeObservation
}

export interface MarkReconcileRequiredInput {
  readonly directory: string
  readonly expectedGeneration: number
  readonly reason: string
  readonly evidence?: string
}

export interface StatusReconcileInput {
  readonly directory: string
  readonly expectedGeneration: number
  readonly observation: StatusObservation
}

export interface RetireInput {
  readonly directory: string
  readonly expectedGeneration: number
  readonly reason?: string
}

/** Full durable row view. Never implies authority: check `bindingState`. */
export interface BindingView {
  readonly directory: DirectoryKey
  readonly bindingState: BindingState
  readonly generation: number
  readonly installationId: string
  readonly repositoryId: string
  readonly worktreeId: string
  readonly storageVolumeId: string
  readonly projectId: string
  readonly workspaceId: string | null
  readonly branchRef: string
  readonly pinRef: string | null
  readonly head: string | null
  readonly managerRevision: number | null
  readonly lifecycleState: string | null
  readonly operationId: string | null
  readonly createOperationId: string | null
  readonly initializationOperationId: string | null
  readonly stateReason: string | null
  readonly evidenceJson: string | null
  readonly createdAt: number
  readonly activatedAt: number | null
  readonly reconciledAt: number | null
  readonly quarantinedAt: number | null
  readonly retiredAt: number | null
  readonly updatedAt: number
}

export type RecordCreationIntentResult =
  | { readonly state: "recorded"; readonly binding: BindingView }
  | {
      readonly state: "duplicate"
      readonly reason: "directory" | "identity"
      readonly binding: BindingView
    }

export type ActivateResult =
  | { readonly state: "activated"; readonly binding: BindingView }
  | { readonly state: "reconcile_required"; readonly binding: BindingView; readonly reason: string }
  | { readonly state: "quarantined"; readonly binding: BindingView; readonly reason: string }
  | { readonly state: "stale" }

export type MarkReconcileRequiredResult =
  | { readonly state: "reconcile_required"; readonly binding: BindingView }
  | { readonly state: "stale" }

export type StatusReconcileResult =
  | { readonly state: "activated"; readonly binding: BindingView }
  | { readonly state: "unchanged"; readonly binding: BindingView }
  | { readonly state: "reconcile_required"; readonly binding: BindingView; readonly reason: string }
  | { readonly state: "quarantined"; readonly binding: BindingView; readonly reason: string }
  /** `quarantined` and `retired` are terminal for every automatic path. */
  | { readonly state: "terminal"; readonly binding: BindingView }
  | { readonly state: "stale" }

export type RetireResult = { readonly state: "retired"; readonly binding: BindingView } | { readonly state: "stale" }

export type ActiveLookup =
  | { readonly state: "active"; readonly binding: BindingView }
  | { readonly state: "inactive"; readonly binding: BindingView | undefined }

export interface Interface {
  /**
   * Inserts the durable creation intent in one IMMEDIATE transaction. One row
   * per canonical managed directory key: an existing row for the same physical
   * directory — in any state, including retired — reports `duplicate`. A
   * non-retired row already carrying the same installation/repository/worktree
   * identity under another directory reports `duplicate` with reason
   * `identity`, so one worktree-store identity can never bind two directories.
   */
  readonly recordCreationIntent: (
    input: CreationIntentInput,
  ) => Effect.Effect<RecordCreationIntentResult, InvalidDirectoryError | InvalidIdentityError>
  /**
   * CAS `handoff_pending` -> `active` only for an exact successful
   * managed-create-initialize observation: managed ownership, `idle_clean`
   * lifecycle, `reconstructable_clean` durability, exact directory key (both
   * the observed `pathKey` and the physical resolution of `targetPath`), exact
   * installation/repository/worktree/storage identities, exact branch/pin refs,
   * canonical revision/head, and operation evidence. Any other well-formed
   * outcome cannot activate: it transitions to `reconcile_required` with the
   * exact evidence preserved, or to `quarantined` when the manager reports
   * quarantine. Stale generation or a non-`handoff_pending` state reports
   * `stale` with zero writes.
   */
  readonly activate: (
    input: ActivateInput,
  ) => Effect.Effect<ActivateResult, InvalidDirectoryError | InvalidObservationError>
  /**
   * CAS `handoff_pending`/`active` -> `reconcile_required` for an ambiguous or
   * failed manager invocation that produced no usable observation. The reason
   * and optional evidence are preserved. Returns `stale` for a generation
   * mismatch or an already-terminal/reconciled row.
   */
  readonly markReconcileRequired: (
    input: MarkReconcileRequiredInput,
  ) => Effect.Effect<MarkReconcileRequiredResult, InvalidDirectoryError | InvalidReasonError>
  /**
   * Status reconciliation. In one IMMEDIATE transaction and under the exact
   * generation CAS:
   *
   * - `quarantined` and `retired` are terminal: the row is returned unchanged;
   * - `handoff_pending`/`reconcile_required` -> `active` only on exact clean
   *   identities (including any previously recorded head/revision/lifecycle);
   * - a quarantined observation moves any non-terminal binding to `quarantined`;
   * - missing/ambiguous evidence leaves the row `reconcile_required` (a
   *   `handoff_pending` row is transitioned there with the evidence preserved);
   * - an `active` row stays unchanged while its identities remain exact and
   *   clean; identity failure or manager-reported reconcile-required evidence
   *   moves it to `reconcile_required`.
   */
  readonly reconcileWithStatus: (
    input: StatusReconcileInput,
  ) => Effect.Effect<StatusReconcileResult, InvalidDirectoryError | InvalidObservationError>
  /** Explicit operator retirement from any non-retired state. Never deletes. */
  readonly retire: (input: RetireInput) => Effect.Effect<RetireResult, InvalidDirectoryError | InvalidReasonError>
  /** Durable row inspection for any state, canonicalized through the exact physical key. */
  readonly get: (directory: string) => Effect.Effect<BindingView | undefined, InvalidDirectoryError>
  /**
   * The exposure gate for future integration: only an `active` binding is
   * loadable. Every other state (including quarantined and retired) reports
   * `inactive` with the durable row when one exists.
   */
  readonly requireActive: (directory: string) => Effect.Effect<ActiveLookup, InvalidDirectoryError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ManagedWorktreeBinding") {}

/** Canonical identity bound, mirrored from the guard/lease identity rule. */
export const MAX_CANONICAL_ID_LENGTH = 200
export const MAX_CANONICAL_REF_LENGTH = 512
export const MAX_REASON_LENGTH = 500
export const MAX_EVIDENCE_LENGTH = 16_384

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const WHITESPACE = /\s/
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

type Row = typeof ManagedWorktreeBindingTable.$inferSelect
type Transaction = Parameters<Parameters<EffectDrizzleSqlite.EffectSQLiteDatabase["transaction"]>[0]>[0]

function canonicalText(input: unknown, max: number): string | undefined {
  if (typeof input !== "string") return undefined
  if (input.length === 0 || input.length > max) return undefined
  if (input !== input.trim()) return undefined
  if (CONTROL_CHARACTERS.test(input)) return undefined
  return input
}

/** Canonical identity: non-empty, bounded, no whitespace anywhere. */
function canonicalId(input: unknown): string | undefined {
  const value = canonicalText(input, MAX_CANONICAL_ID_LENGTH)
  if (value === undefined) return undefined
  if (WHITESPACE.test(value)) return undefined
  return value
}

/** Canonical fully qualified ref (`refs/...`), no whitespace and no dot segments. */
function canonicalRef(input: unknown): string | undefined {
  const value = canonicalText(input, MAX_CANONICAL_REF_LENGTH)
  if (value === undefined) return undefined
  if (WHITESPACE.test(value)) return undefined
  if (!value.startsWith("refs/") || value.endsWith("/")) return undefined
  if (value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")) return undefined
  return value
}

function positiveInteger(input: unknown): number | undefined {
  if (typeof input !== "number" || !Number.isInteger(input) || input <= 0) return undefined
  return input
}

function nonNegativeInteger(input: unknown): number | undefined {
  if (typeof input !== "number" || !Number.isInteger(input) || input < 0) return undefined
  return input
}

function toView(row: Row): BindingView {
  return Object.freeze({
    directory: row.directory as DirectoryKey,
    bindingState: row.binding_state,
    generation: row.generation,
    installationId: row.installation_id,
    repositoryId: row.repository_id,
    worktreeId: row.worktree_id,
    storageVolumeId: row.storage_volume_id,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    branchRef: row.branch_ref,
    pinRef: row.pin_ref,
    head: row.head,
    managerRevision: row.manager_revision,
    lifecycleState: row.lifecycle_state,
    operationId: row.operation_id,
    createOperationId: row.create_operation_id,
    initializationOperationId: row.initialization_operation_id,
    stateReason: row.state_reason,
    evidenceJson: row.evidence_json,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    reconciledAt: row.reconciled_at,
    quarantinedAt: row.quarantined_at,
    retiredAt: row.retired_at,
    updatedAt: row.updated_at,
  })
}

const evidence = (value: unknown) => JSON.stringify(value)

/**
 * Structural validation of a create-initialize observation, before any durable
 * read or write. A malformed observation is an error with zero durable change;
 * a well-formed but non-exact one is evidence for `reconcile_required`.
 */
function validateCreateObservation(input: CreateInitializeObservation): string | undefined {
  if (canonicalId(input.installationId) === undefined) return "observation.installationId is not a canonical identity."
  if (canonicalId(input.repositoryId) === undefined) return "observation.repositoryId is not a canonical identity."
  if (canonicalId(input.worktreeId) === undefined) return "observation.worktreeId is not a canonical identity."
  if (canonicalId(input.storageVolumeId) === undefined) return "observation.storageVolumeId is not a canonical identity."
  if (canonicalText(input.targetPath, MAX_CANONICAL_REF_LENGTH) === undefined)
    return "observation.targetPath is not a canonical path spelling."
  if (canonicalText(input.pathKey, MAX_CANONICAL_REF_LENGTH) === undefined)
    return "observation.pathKey is not a canonical path key."
  if (canonicalText(input.ownership, MAX_CANONICAL_ID_LENGTH) === undefined)
    return "observation.ownership is not bounded text."
  if (canonicalText(input.lifecycleState, MAX_CANONICAL_ID_LENGTH) === undefined)
    return "observation.lifecycleState is not bounded text."
  if (canonicalText(input.durabilityClass, MAX_CANONICAL_ID_LENGTH) === undefined)
    return "observation.durabilityClass is not bounded text."
  if (positiveInteger(input.revision) === undefined) return "observation.revision must be a positive integer."
  if (typeof input.head !== "string" || !OBJECT_ID.test(input.head))
    return "observation.head must be a lowercase git object id."
  if (input.branchRef !== null && canonicalRef(input.branchRef) === undefined)
    return "observation.branchRef must be null or a canonical refs/... ref."
  if (input.pinRef !== null && canonicalRef(input.pinRef) === undefined)
    return "observation.pinRef must be null or a canonical refs/... ref."
  if (input.createOperationId !== null && canonicalId(input.createOperationId) === undefined)
    return "observation.createOperationId must be null or a canonical identity."
  if (input.initializationOperationId !== null && canonicalId(input.initializationOperationId) === undefined)
    return "observation.initializationOperationId must be null or a canonical identity."
  if (input.quarantined !== undefined && typeof input.quarantined !== "boolean")
    return "observation.quarantined must be boolean when present."
  return undefined
}

/** Structural validation of a managed-status observation. */
function validateStatusObservation(input: StatusObservation): string | undefined {
  if (canonicalId(input.installationId) === undefined) return "observation.installationId is not a canonical identity."
  if (canonicalId(input.repositoryId) === undefined) return "observation.repositoryId is not a canonical identity."
  if (canonicalId(input.worktreeId) === undefined) return "observation.worktreeId is not a canonical identity."
  if (canonicalId(input.storageVolumeId) === undefined) return "observation.storageVolumeId is not a canonical identity."
  if (canonicalText(input.targetPath, MAX_CANONICAL_REF_LENGTH) === undefined)
    return "observation.targetPath is not a canonical path spelling."
  if (canonicalText(input.pathKey, MAX_CANONICAL_REF_LENGTH) === undefined)
    return "observation.pathKey is not a canonical path key."
  if (canonicalText(input.ownership, MAX_CANONICAL_ID_LENGTH) === undefined)
    return "observation.ownership is not bounded text."
  if (canonicalText(input.lifecycleState, MAX_CANONICAL_ID_LENGTH) === undefined)
    return "observation.lifecycleState is not bounded text."
  if (canonicalText(input.durabilityClass, MAX_CANONICAL_ID_LENGTH) === undefined)
    return "observation.durabilityClass is not bounded text."
  if (positiveInteger(input.revision) === undefined) return "observation.revision must be a positive integer."
  if (typeof input.head !== "string" || !OBJECT_ID.test(input.head))
    return "observation.head must be a lowercase git object id."
  if (input.branchRef !== null && canonicalRef(input.branchRef) === undefined)
    return "observation.branchRef must be null or a canonical refs/... ref."
  if (input.pinRef !== null && canonicalRef(input.pinRef) === undefined)
    return "observation.pinRef must be null or a canonical refs/... ref."
  if (typeof input.quarantined !== "boolean") return "observation.quarantined must be boolean."
  if (typeof input.reconcileRequired !== "boolean") return "observation.reconcileRequired must be boolean."
  if (nonNegativeInteger(input.openOperationCount) === undefined)
    return "observation.openOperationCount must be a non-negative integer."
  if (nonNegativeInteger(input.unresolvedGuardAttemptCount) === undefined)
    return "observation.unresolvedGuardAttemptCount must be a non-negative integer."
  return undefined
}

type Exactness =
  | { readonly state: "exact" }
  | { readonly state: "quarantined"; readonly reason: string }
  | { readonly state: "mismatch"; readonly reason: string }

const mismatch = (reason: string): Exactness => ({ state: "mismatch", reason })
const quarantined = (reason: string): Exactness => ({ state: "quarantined", reason })

function quarantineReason(lifecycleState: string, durabilityClass: string, flagged: boolean): string {
  if (flagged || lifecycleState === "quarantined" || durabilityClass === "quarantined") {
    return "manager-quarantine"
  }
  return ""
}

function identityExactness(
  row: Row,
  observation: {
    readonly installationId: string
    readonly repositoryId: string
    readonly worktreeId: string
    readonly storageVolumeId: string
    readonly targetPath: string
    readonly pathKey: string
    readonly ownership: string
    readonly lifecycleState: string
    readonly durabilityClass: string
    readonly branchRef: string | null
    readonly pinRef: string | null
  },
  physicalDirectory: DirectoryKey | undefined,
): Exactness | undefined {
  if (observation.ownership !== "managed") return mismatch("ownership-not-managed")
  if (observation.lifecycleState !== "idle_clean") return mismatch("lifecycle-not-idle-clean")
  if (observation.durabilityClass !== "reconstructable_clean") return mismatch("durability-not-reconstructable-clean")
  if (observation.installationId !== row.installation_id) return mismatch("identity-mismatch:installationId")
  if (observation.repositoryId !== row.repository_id) return mismatch("identity-mismatch:repositoryId")
  if (observation.worktreeId !== row.worktree_id) return mismatch("identity-mismatch:worktreeId")
  if (observation.storageVolumeId !== row.storage_volume_id) return mismatch("identity-mismatch:storageVolumeId")
  if (physicalDirectory === undefined || physicalDirectory !== row.directory || observation.pathKey !== row.directory) {
    return mismatch("directory-mismatch")
  }
  if (observation.branchRef !== row.branch_ref) return mismatch("branch-ref-mismatch")
  if ((observation.pinRef ?? null) !== (row.pin_ref ?? null)) return mismatch("pin-ref-mismatch")
  return undefined
}

function evaluateCreateInitialize(
  row: Row,
  observation: CreateInitializeObservation,
  physicalDirectory: DirectoryKey | undefined,
): Exactness {
  const quarantine = quarantineReason(
    observation.lifecycleState,
    observation.durabilityClass,
    observation.quarantined === true,
  )
  if (quarantine !== "") return quarantined(quarantine)
  const identity = identityExactness(row, observation, physicalDirectory)
  if (identity !== undefined) return identity
  if (observation.createOperationId === null && observation.initializationOperationId === null) {
    return mismatch("missing-operation-evidence")
  }
  // A binding that was already activated carries immutable evidence: a later
  // exact observation must agree with the recorded head/revision/lifecycle
  // rather than silently re-authorizing a different revision.
  if (row.head !== null && observation.head !== row.head) return mismatch("head-mismatch")
  if (row.manager_revision !== null && observation.revision !== row.manager_revision) return mismatch("revision-mismatch")
  if (row.lifecycle_state !== null && observation.lifecycleState !== row.lifecycle_state) {
    return mismatch("lifecycle-mismatch")
  }
  return { state: "exact" }
}

function evaluateStatus(
  row: Row,
  observation: StatusObservation,
  physicalDirectory: DirectoryKey | undefined,
  mode: "activate" | "validate",
): Exactness {
  const quarantine = quarantineReason(
    observation.lifecycleState,
    observation.durabilityClass,
    observation.quarantined,
  )
  if (quarantine !== "") return quarantined(quarantine)
  const identity = identityExactness(row, observation, physicalDirectory)
  if (identity !== undefined) return identity
  if (observation.reconcileRequired) return mismatch("manager-reconcile-required")
  if (observation.openOperationCount !== 0) return mismatch("open-operations")
  if (observation.unresolvedGuardAttemptCount !== 0) return mismatch("unresolved-guard-attempts")
  if (mode === "activate") {
    if (row.head !== null && observation.head !== row.head) return mismatch("head-mismatch")
    if (row.manager_revision !== null && observation.revision !== row.manager_revision) {
      return mismatch("revision-mismatch")
    }
  }
  return { state: "exact" }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db, readDb } = yield* Database.Service

    const transition = (
      tx: Transaction,
      row: Row,
      next: BindingState,
      patch: Partial<typeof ManagedWorktreeBindingTable.$inferInsert>,
    ) =>
      tx
        .update(ManagedWorktreeBindingTable)
        .set({ ...patch, binding_state: next, generation: row.generation + 1 })
        .where(
          and(
            eq(ManagedWorktreeBindingTable.directory, row.directory),
            eq(ManagedWorktreeBindingTable.generation, row.generation),
            eq(ManagedWorktreeBindingTable.binding_state, row.binding_state),
          ),
        )
        .returning()
        .all()
        .pipe(Effect.orDie)
        .pipe(
          Effect.flatMap((rows) =>
            rows.length === 1
              ? Effect.succeed(toView(rows[0]))
              : Effect.die("Managed worktree binding transition lost exact identity inside its writer transaction"),
          ),
        )

    const recordCreationIntent = Effect.fn("ManagedWorktreeBinding.recordCreationIntent")(function* (
      input: CreationIntentInput,
    ) {
      const directory = existingDirectoryKey(input.directory)
      if (directory === undefined) return yield* new InvalidDirectoryError({ directory: input.directory })
      const installationId = canonicalId(input.installationId)
      if (installationId === undefined) {
        return yield* new InvalidIdentityError({ field: "installationId", value: String(input.installationId) })
      }
      const repositoryId = canonicalId(input.repositoryId)
      if (repositoryId === undefined) {
        return yield* new InvalidIdentityError({ field: "repositoryId", value: String(input.repositoryId) })
      }
      const worktreeId = canonicalId(input.worktreeId)
      if (worktreeId === undefined) {
        return yield* new InvalidIdentityError({ field: "worktreeId", value: String(input.worktreeId) })
      }
      const storageVolumeId = canonicalId(input.storageVolumeId)
      if (storageVolumeId === undefined) {
        return yield* new InvalidIdentityError({ field: "storageVolumeId", value: String(input.storageVolumeId) })
      }
      const projectId = canonicalId(input.projectId)
      if (projectId === undefined) return yield* new InvalidIdentityError({ field: "projectId", value: String(input.projectId) })
      const workspaceId =
        input.workspaceId === undefined || input.workspaceId === null ? null : canonicalId(input.workspaceId)
      if (input.workspaceId !== undefined && input.workspaceId !== null && workspaceId === undefined) {
        return yield* new InvalidIdentityError({ field: "workspaceId", value: String(input.workspaceId) })
      }
      const branchRef = canonicalRef(input.branchRef)
      if (branchRef === undefined) return yield* new InvalidIdentityError({ field: "branchRef", value: String(input.branchRef) })
      const pinRef = input.pinRef === undefined || input.pinRef === null ? null : canonicalRef(input.pinRef)
      if (input.pinRef !== undefined && input.pinRef !== null && pinRef === undefined) {
        return yield* new InvalidIdentityError({ field: "pinRef", value: String(input.pinRef) })
      }

      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const existing = yield* tx
                .select()
                .from(ManagedWorktreeBindingTable)
                .where(eq(ManagedWorktreeBindingTable.directory, directory))
                .get()
                .pipe(Effect.orDie)
              if (existing !== undefined) {
                return { state: "duplicate" as const, reason: "directory" as const, binding: toView(existing) }
              }
              const byIdentity = yield* tx
                .select()
                .from(ManagedWorktreeBindingTable)
                .where(
                  and(
                    eq(ManagedWorktreeBindingTable.installation_id, installationId),
                    eq(ManagedWorktreeBindingTable.repository_id, repositoryId),
                    eq(ManagedWorktreeBindingTable.worktree_id, worktreeId),
                    ne(ManagedWorktreeBindingTable.binding_state, "retired"),
                  ),
                )
                .all()
                .pipe(Effect.orDie)
              if (byIdentity.length > 0) {
                return { state: "duplicate" as const, reason: "identity" as const, binding: toView(byIdentity[0]) }
              }

              const now = Date.now()
              yield* tx
                .insert(ManagedWorktreeBindingTable)
                .values({
                  directory,
                  binding_state: "handoff_pending",
                  generation: 1,
                  installation_id: installationId,
                  repository_id: repositoryId,
                  worktree_id: worktreeId,
                  storage_volume_id: storageVolumeId,
                  project_id: projectId,
                  workspace_id: workspaceId,
                  branch_ref: branchRef,
                  pin_ref: pinRef,
                  head: null,
                  manager_revision: null,
                  lifecycle_state: null,
                  operation_id: null,
                  create_operation_id: null,
                  initialization_operation_id: null,
                  state_reason: "creation-intent-recorded",
                  evidence_json: null,
                  created_at: now,
                  activated_at: null,
                  reconciled_at: null,
                  quarantined_at: null,
                  retired_at: null,
                  updated_at: now,
                })
                .run()
                .pipe(Effect.orDie)
              const row = yield* tx
                .select()
                .from(ManagedWorktreeBindingTable)
                .where(eq(ManagedWorktreeBindingTable.directory, directory))
                .get()
                .pipe(Effect.orDie)
              if (row === undefined) {
                return yield* Effect.die("Managed worktree binding creation intent did not persist inside its transaction")
              }
              return { state: "recorded" as const, binding: toView(row) }
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    })

    const activate = Effect.fn("ManagedWorktreeBinding.activate")(function* (input: ActivateInput) {
      const directory = existingDirectoryKey(input.directory)
      if (directory === undefined) return yield* new InvalidDirectoryError({ directory: input.directory })
      const expectedGeneration = positiveInteger(input.expectedGeneration)
      if (expectedGeneration === undefined) {
        return yield* new InvalidObservationError({ reason: "expectedGeneration must be a positive integer." })
      }
      const operationId = canonicalId(input.operationId)
      if (operationId === undefined) {
        return yield* new InvalidObservationError({ reason: "operationId must be a canonical non-empty identity." })
      }
      const invalid = validateCreateObservation(input.observation)
      if (invalid !== undefined) return yield* new InvalidObservationError({ reason: invalid })
      const observation = input.observation
      // Physical resolution of the observed target: a failed realpath is a
      // directory mismatch, never a lexical fallback.
      const physicalDirectory = existingDirectoryKey(observation.targetPath)

      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const row = yield* tx
                .select()
                .from(ManagedWorktreeBindingTable)
                .where(eq(ManagedWorktreeBindingTable.directory, directory))
                .get()
                .pipe(Effect.orDie)
              if (
                row === undefined ||
                row.generation !== expectedGeneration ||
                row.binding_state !== "handoff_pending"
              ) {
                return { state: "stale" as const }
              }

              const now = Date.now()
              const evaluation = evaluateCreateInitialize(row, observation, physicalDirectory)
              if (evaluation.state === "quarantined") {
                const binding = yield* transition(tx, row, "quarantined", {
                  state_reason: evaluation.reason,
                  evidence_json: evidence({ reason: evaluation.reason, observation }),
                  quarantined_at: row.quarantined_at ?? now,
                  updated_at: now,
                })
                return { state: "quarantined" as const, binding, reason: evaluation.reason }
              }
              if (evaluation.state === "mismatch") {
                const binding = yield* transition(tx, row, "reconcile_required", {
                  state_reason: evaluation.reason,
                  evidence_json: evidence({ reason: evaluation.reason, observation }),
                  reconciled_at: row.reconciled_at ?? now,
                  updated_at: now,
                })
                return { state: "reconcile_required" as const, binding, reason: evaluation.reason }
              }

              const binding = yield* transition(tx, row, "active", {
                state_reason: "managed-create-initialize-exact",
                evidence_json: evidence(observation),
                head: row.head ?? observation.head,
                manager_revision: row.manager_revision ?? observation.revision,
                lifecycle_state: row.lifecycle_state ?? observation.lifecycleState,
                operation_id: row.operation_id ?? operationId,
                create_operation_id: row.create_operation_id ?? observation.createOperationId,
                initialization_operation_id:
                  row.initialization_operation_id ?? observation.initializationOperationId,
                activated_at: row.activated_at ?? now,
                updated_at: now,
              })
              return { state: "activated" as const, binding }
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    })

    const markReconcileRequired = Effect.fn("ManagedWorktreeBinding.markReconcileRequired")(function* (
      input: MarkReconcileRequiredInput,
    ) {
      const directory = existingDirectoryKey(input.directory)
      if (directory === undefined) return yield* new InvalidDirectoryError({ directory: input.directory })
      const expectedGeneration = positiveInteger(input.expectedGeneration)
      const reason = canonicalText(input.reason, MAX_REASON_LENGTH)
      if (expectedGeneration === undefined || reason === undefined) {
        return yield* new InvalidReasonError({ reason: "expectedGeneration and reason must be canonical." })
      }
      const suppliedEvidence =
        input.evidence === undefined ? undefined : canonicalText(input.evidence, MAX_EVIDENCE_LENGTH)
      if (input.evidence !== undefined && suppliedEvidence === undefined) {
        return yield* new InvalidReasonError({ reason: "evidence must be bounded canonical text." })
      }

      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const row = yield* tx
                .select()
                .from(ManagedWorktreeBindingTable)
                .where(eq(ManagedWorktreeBindingTable.directory, directory))
                .get()
                .pipe(Effect.orDie)
              if (row === undefined || row.generation !== expectedGeneration) return { state: "stale" as const }
              if (row.binding_state !== "handoff_pending" && row.binding_state !== "active") {
                return { state: "stale" as const }
              }
              const now = Date.now()
              const binding = yield* transition(tx, row, "reconcile_required", {
                state_reason: reason,
                evidence_json:
                  suppliedEvidence === undefined
                    ? (row.evidence_json ?? evidence({ reason }))
                    : evidence({ reason, evidence: suppliedEvidence }),
                reconciled_at: row.reconciled_at ?? now,
                updated_at: now,
              })
              return { state: "reconcile_required" as const, binding }
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    })

    const reconcileWithStatus = Effect.fn("ManagedWorktreeBinding.reconcileWithStatus")(function* (
      input: StatusReconcileInput,
    ) {
      const directory = existingDirectoryKey(input.directory)
      if (directory === undefined) return yield* new InvalidDirectoryError({ directory: input.directory })
      const expectedGeneration = positiveInteger(input.expectedGeneration)
      if (expectedGeneration === undefined) {
        return yield* new InvalidObservationError({ reason: "expectedGeneration must be a positive integer." })
      }
      const invalid = validateStatusObservation(input.observation)
      if (invalid !== undefined) return yield* new InvalidObservationError({ reason: invalid })
      const observation = input.observation
      const physicalDirectory = existingDirectoryKey(observation.targetPath)

      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const row = yield* tx
                .select()
                .from(ManagedWorktreeBindingTable)
                .where(eq(ManagedWorktreeBindingTable.directory, directory))
                .get()
                .pipe(Effect.orDie)
              if (row === undefined || row.generation !== expectedGeneration) return { state: "stale" as const }
              if (row.binding_state === "quarantined" || row.binding_state === "retired") {
                return { state: "terminal" as const, binding: toView(row) }
              }

              const now = Date.now()
              const activation = row.binding_state === "handoff_pending" || row.binding_state === "reconcile_required"
              const evaluation = evaluateStatus(row, observation, physicalDirectory, activation ? "activate" : "validate")

              if (evaluation.state === "quarantined") {
                const binding = yield* transition(tx, row, "quarantined", {
                  state_reason: evaluation.reason,
                  evidence_json: evidence({ reason: evaluation.reason, observation }),
                  quarantined_at: row.quarantined_at ?? now,
                  updated_at: now,
                })
                return { state: "quarantined" as const, binding, reason: evaluation.reason }
              }

              if (activation) {
                if (evaluation.state === "exact") {
                  const binding = yield* transition(tx, row, "active", {
                    state_reason: "managed-status-exact",
                    evidence_json: evidence(observation),
                    head: row.head ?? observation.head,
                    manager_revision: row.manager_revision ?? observation.revision,
                    lifecycle_state: row.lifecycle_state ?? observation.lifecycleState,
                    activated_at: row.activated_at ?? now,
                    updated_at: now,
                  })
                  return { state: "activated" as const, binding }
                }
                if (row.binding_state === "handoff_pending") {
                  const binding = yield* transition(tx, row, "reconcile_required", {
                    state_reason: evaluation.reason,
                    evidence_json: evidence({ reason: evaluation.reason, observation }),
                    reconciled_at: row.reconciled_at ?? now,
                    updated_at: now,
                  })
                  return { state: "reconcile_required" as const, binding, reason: evaluation.reason }
                }
                // Already reconcile_required with missing/ambiguous evidence:
                // stays there with zero writes.
                return { state: "reconcile_required" as const, binding: toView(row), reason: evaluation.reason }
              }

              if (evaluation.state === "exact") return { state: "unchanged" as const, binding: toView(row) }

              const binding = yield* transition(tx, row, "reconcile_required", {
                state_reason: evaluation.reason,
                evidence_json: evidence({ reason: evaluation.reason, observation }),
                reconciled_at: row.reconciled_at ?? now,
                updated_at: now,
              })
              return { state: "reconcile_required" as const, binding, reason: evaluation.reason }
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    })

    const retire = Effect.fn("ManagedWorktreeBinding.retire")(function* (input: RetireInput) {
      const directory = existingDirectoryKey(input.directory)
      if (directory === undefined) return yield* new InvalidDirectoryError({ directory: input.directory })
      const expectedGeneration = positiveInteger(input.expectedGeneration)
      const reason = input.reason === undefined ? "explicit-retirement" : canonicalText(input.reason, MAX_REASON_LENGTH)
      if (expectedGeneration === undefined || reason === undefined) {
        return yield* new InvalidReasonError({ reason: "expectedGeneration and reason must be canonical." })
      }

      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const row = yield* tx
                .select()
                .from(ManagedWorktreeBindingTable)
                .where(eq(ManagedWorktreeBindingTable.directory, directory))
                .get()
                .pipe(Effect.orDie)
              if (row === undefined || row.generation !== expectedGeneration || row.binding_state === "retired") {
                return { state: "stale" as const }
              }
              const now = Date.now()
              const binding = yield* transition(tx, row, "retired", {
                state_reason: reason,
                retired_at: now,
                updated_at: now,
              })
              return { state: "retired" as const, binding }
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    })

    const get = Effect.fn("ManagedWorktreeBinding.get")(function* (directory: string) {
      const key = existingDirectoryKey(directory)
      if (key === undefined) return yield* new InvalidDirectoryError({ directory })
      const row = yield* readDb
        .select()
        .from(ManagedWorktreeBindingTable)
        .where(eq(ManagedWorktreeBindingTable.directory, key))
        .get()
        .pipe(Effect.orDie)
      return row === undefined ? undefined : toView(row)
    })

    const requireActive = Effect.fn("ManagedWorktreeBinding.requireActive")(function* (directory: string) {
      const binding = yield* get(directory)
      if (binding !== undefined && binding.bindingState === "active") {
        return { state: "active" as const, binding }
      }
      return { state: "inactive" as const, binding }
    })

    return Service.of({
      recordCreationIntent,
      activate,
      markReconcileRequired,
      reconcileWithStatus,
      retire,
      get,
      requireActive,
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node],
})
