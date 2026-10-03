export * as DirectoryActivityLease from "./directory-activity-lease"

import { and, eq, inArray, ne } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "./database/database"
import { DirectoryActivityLeaseTable } from "./directory-activity-lease.sql"
import { DirectoryMaintenanceGuard, existingDirectoryKey, lexicalDirectoryKey } from "./directory-maintenance-guard"
import { DirectoryMaintenanceGuardTable } from "./directory-maintenance-guard.sql"
import { makeGlobalNode } from "./effect/app-node"
import { RuntimeOwner } from "./runtime-owner"

export type State = typeof DirectoryActivityLeaseTable.$inferSelect.state
export type HeldState = Exclude<State, "released">
/** Durable identity of one whole activity-lease acquisition. */
export type LeaseID = string & { readonly __directoryActivityLeaseID: "DirectoryActivityLeaseID" }
/** Same strict physical directory identity as DirectoryMaintenanceGuard. */
export type DirectoryKey = DirectoryMaintenanceGuard.DirectoryKey

export class InvalidDirectoryError extends Schema.TaggedErrorClass<InvalidDirectoryError>()(
  "DirectoryActivityLease.InvalidDirectoryError",
  { directory: Schema.String },
) {}

export class InvalidKindError extends Schema.TaggedErrorClass<InvalidKindError>()(
  "DirectoryActivityLease.InvalidKindError",
  { kind: Schema.String },
) {}

export type Error = InvalidDirectoryError | InvalidKindError

export interface AcquireInput {
  readonly directory: string
  readonly kind: string
}

/**
 * Exact handle for one activity lease. Every field is part of the release CAS:
 * a stale handle whose generation/kind/directory/owner no longer matches the
 * durable row can never release it, and `leaseId` is unique per acquisition so
 * it can never name a newer lease.
 */
export interface Token {
  readonly leaseId: LeaseID
  readonly kind: string
  readonly ownerID: RuntimeOwner.ID
  readonly generation: number
  readonly directory: DirectoryKey
}

/**
 * Structured evidence that a non-released DirectoryMaintenanceGuard row holds
 * the requested directory. Kept distinct from any lease identity: this is the
 * other authority's evidence, not ours.
 */
export interface MaintenanceBlocker {
  readonly directory: DirectoryKey
  readonly guardId: string
  readonly ownerID: RuntimeOwner.ID
  readonly acquisitionId: DirectoryMaintenanceGuard.AcquisitionID
  readonly generation: number
  readonly state: HeldState
}

export type AcquireResult =
  | { readonly state: "acquired"; readonly token: Token }
  | { readonly state: "blocked"; readonly blocked: MaintenanceBlocker }

export type ReleaseResult = "released" | "stale"

export type HealthIssueReason =
  | "missing"
  | "released"
  | "reconcile_required"
  | "foreign-directory"
  | "foreign-kind"
  | "foreign-owner"
  | "wrong-generation"
  | "malformed-token"

export interface HealthIssue {
  readonly directory: DirectoryKey
  readonly reason: HealthIssueReason
}

export type HealthResult =
  | { readonly state: "healthy" }
  | { readonly state: "unhealthy"; readonly issues: ReadonlyArray<HealthIssue> }

export type ResolveReconcileRequiredResult =
  | { readonly state: "resolved" }
  | { readonly state: "stale" }
  | { readonly state: "blocked"; readonly proof: Exclude<RuntimeOwner.LocalDeathProof, "dead"> }

export interface ReconcileReport {
  readonly reconciled: ReadonlyArray<{
    readonly leaseId: LeaseID
    readonly kind: string
    readonly ownerID: RuntimeOwner.ID
    readonly directory: DirectoryKey
  }>
  readonly blocked: ReadonlyArray<{
    readonly leaseId: LeaseID
    readonly kind: string
    readonly ownerID: RuntimeOwner.ID
    readonly proof: Exclude<RuntimeOwner.LocalDeathProof, "dead">
    readonly directory: DirectoryKey
  }>
}

/**
 * One lease row as reported to a maintenance guard that is blocked by it.
 * Structurally distinct from `DirectoryMaintenanceGuard.BlockedDirectory` so
 * activity-lease and guard blockers are never collapsed into one identity.
 */
export interface ActivityLeaseBlocker {
  readonly directory: DirectoryKey
  readonly leaseId: LeaseID
  readonly kind: string
  readonly ownerID: RuntimeOwner.ID
  readonly generation: number
  readonly state: HeldState
}

/** `withLease` failed because a non-released maintenance guard holds the directory. */
export class BlockedError extends Schema.TaggedErrorClass<BlockedError>()(
  "DirectoryActivityLease.BlockedError",
  {
    directory: Schema.String,
    guardId: Schema.String,
    ownerID: Schema.String,
    acquisitionId: Schema.String,
    generation: Schema.Number,
    state: Schema.String,
  },
) {}

export interface Interface {
  /**
   * Atomically acquires one shared activity lease for one existing physical
   * directory under this RuntimeOwner. Inside a single IMMEDIATE transaction
   * the directory's maintenance-guard row is read and any non-released state
   * (active or reconcile_required) blocks the acquisition with structured
   * guard evidence and zero writes. Other activity leases never block: shared
   * leases coexist by design.
   *
   * Inputs must resolve to an existing physical directory via the exact
   * `existingDirectoryKey` algorithm; missing/ambiguous directories and
   * non-canonical kinds are rejected before any durable change.
   *
   * A successful acquisition keeps this RuntimeOwner's heartbeat retained
   * until the matching token is released (or is discovered stale).
   */
  readonly acquire: (input: AcquireInput) => Effect.Effect<AcquireResult, Error>
  /**
   * Proves the exact lease is healthy: the durable row must carry the token's
   * exact leaseId + directory + kind + owner + generation and active state.
   * Missing, released, reconcile_required, foreign, or superseded state is
   * unhealthy.
   */
  readonly assertHealthy: (token: Token) => Effect.Effect<HealthResult>
  /**
   * Transitions the exact lease to released in one IMMEDIATE transaction, and
   * only on exact leaseId + directory + kind + owner + generation + active
   * identity. Malformed or mismatched handles report `stale` with zero durable
   * changes; a stale handle can never release a newer lease.
   */
  readonly release: (token: Token) => Effect.Effect<ReleaseResult>
  /**
   * Service-only operator resolution for one exact `reconcile_required` lease.
   * It transitions to `released` only when the token carries the exact lease
   * identity AND RuntimeOwner.proveLocalDeath(ownerID) === dead at resolution
   * time. Every other outcome is `stale` or `blocked` with zero durable
   * changes; uncertainty stays blocking. Not wired to any route.
   */
  readonly resolveReconcileRequired: (token: Token) => Effect.Effect<ResolveReconcileRequiredResult>
  /**
   * Crash reconciliation. Active leases are inspected per owner and only
   * `RuntimeOwner.proveLocalDeath(owner_id) === "dead"` may transition them to
   * reconcile_required. Each lease is reported by its exact leaseId so several
   * leases owned by one dead runtime remain separately auditable. Alive or
   * unprovable owners stay active and blocking. Reconciliation never releases.
   */
  readonly reconcile: () => Effect.Effect<ReconcileReport>
  /**
   * Lifetime-wrapping helper for real writers: acquires one lease, runs
   * `effect` with the exact handle, and releases through the exact CAS in an
   * uninterruptible finalizer. A non-released maintenance guard fails with
   * `BlockedError` before `effect` runs.
   */
  readonly withLease: <A, E, R>(
    directory: string,
    kind: string,
    effect: (token: Token) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | Error | BlockedError, R>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/DirectoryActivityLease") {}

/** Canonical lease-kind bound, mirrored from the guard-id rule. */
export const MAX_CANONICAL_LEASE_KIND_LENGTH = 200

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const WHITESPACE = /\s/

function canonicalIdentifier(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined
  if (input.length === 0) return undefined
  if (input !== input.trim()) return undefined
  if (CONTROL_CHARACTERS.test(input)) return undefined
  return input
}

/**
 * Canonical caller-supplied lease kind: non-empty, bounded, with no control
 * characters and no whitespace anywhere. Padded, over-length, delimited, and
 * empty kinds are rejected rather than normalized.
 */
function canonicalKind(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined
  if (input.length === 0) return undefined
  if (CONTROL_CHARACTERS.test(input)) return undefined
  if (input !== input.trim() || WHITESPACE.test(input)) return undefined
  if (input.length > MAX_CANONICAL_LEASE_KIND_LENGTH) return undefined
  return input
}

interface ParsedToken {
  readonly leaseId: string
  readonly kind: string
  readonly ownerID: RuntimeOwner.ID
  readonly generation: number
  readonly directory: DirectoryKey
}

/**
 * Structural + lexical validation of a token before any durable read or write.
 * The directory must already be canonical (no alias spelling can be minted by
 * a forged handle).
 */
function parseToken(token: Token): ParsedToken | undefined {
  const leaseId = canonicalIdentifier((token as { readonly leaseId?: unknown } | undefined)?.leaseId)
  const kind = canonicalKind((token as { readonly kind?: unknown } | undefined)?.kind)
  const ownerID = canonicalIdentifier((token as { readonly ownerID?: unknown } | undefined)?.ownerID)
  if (leaseId === undefined || kind === undefined || ownerID === undefined) return undefined
  const generation = (token as { readonly generation?: unknown } | undefined)?.generation
  if (typeof generation !== "number" || !Number.isInteger(generation) || generation <= 0) return undefined
  const raw = (token as { readonly directory?: unknown } | undefined)?.directory
  if (typeof raw !== "string") return undefined
  const directory = lexicalDirectoryKey(raw)
  if (directory === undefined || directory !== raw) return undefined
  return { leaseId, kind, ownerID: ownerID as RuntimeOwner.ID, generation, directory }
}

const malformedIssue = (token: Token): HealthIssue => {
  const raw = (token as { readonly directory?: unknown } | undefined)?.directory
  return { directory: (typeof raw === "string" ? raw : "") as DirectoryKey, reason: "malformed-token" }
}

const rawLeaseId = (token: Token): string | undefined => {
  const value = (token as { readonly leaseId?: unknown } | undefined)?.leaseId
  return typeof value === "string" && value.length > 0 ? value : undefined
}

type Row = typeof DirectoryActivityLeaseTable.$inferSelect

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db, readDb } = yield* Database.Service
    const runtime = yield* RuntimeOwner.Service
    // Retention is keyed by the unique lease identity, never by a
    // delimiter-joined caller string, so releasing one lease can never stop
    // the heartbeat another live lease still needs.
    const retentions = new Map<string, RuntimeOwner.Retention>()

    const dropRetention = Effect.fn("DirectoryActivityLease.dropRetention")(function* (
      leaseId: string,
      fallback?: RuntimeOwner.Retention,
    ) {
      const retention = retentions.get(leaseId) ?? fallback
      if (!retention) return
      retentions.delete(leaseId)
      yield* retention.release
    })

    // A stale/invalid terminal handle must not leak a retention, but a
    // retained heartbeat is only dropped once no durable row for that lease is
    // still non-released. Ambiguity keeps the retention.
    const dropTerminalRetention = Effect.fn("DirectoryActivityLease.dropTerminalRetention")(function* (
      leaseId: string,
    ) {
      if (!retentions.has(leaseId)) return
      const live = yield* readDb
        .select({ leaseId: DirectoryActivityLeaseTable.lease_id })
        .from(DirectoryActivityLeaseTable)
        .where(
          and(
            eq(DirectoryActivityLeaseTable.lease_id, leaseId),
            ne(DirectoryActivityLeaseTable.state, "released"),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      if (live.length > 0) return
      yield* dropRetention(leaseId)
    })

    // Finalization-boundary retention settlement: every exit that did not
    // transfer the retention settles it exactly once from durable state.
    const reconcileExitRetention = Effect.fn("DirectoryActivityLease.reconcileExitRetention")(function* (
      leaseId: string,
      retention: RuntimeOwner.Retention,
    ) {
      const published = yield* readDb
        .select({ state: DirectoryActivityLeaseTable.state })
        .from(DirectoryActivityLeaseTable)
        .where(eq(DirectoryActivityLeaseTable.lease_id, leaseId))
        .all()
        .pipe(Effect.orDie)
      if (published.some((row) => row.state !== "released")) {
        retentions.set(leaseId, retention)
        return
      }
      yield* dropRetention(leaseId, retention)
    })

    const acquire = Effect.fn("DirectoryActivityLease.acquire")(function* (input: AcquireInput) {
      const kind = canonicalKind(input.kind)
      if (kind === undefined) return yield* new InvalidKindError({ kind: input.kind })
      const directory = existingDirectoryKey(input.directory)
      if (directory === undefined) return yield* new InvalidDirectoryError({ directory: input.directory })
      const leaseId = `directory-activity:${crypto.randomUUID()}` as LeaseID

      // Retain and durable publish share one bracket: `runtime.retain` is the
      // uninterruptible acquire step and the settlement finalizer is installed
      // before the transaction boundary is entered, so an interrupt delivered
      // while retain is still resolving completes that retain and settles it
      // instead of leaking a heartbeat.
      let transferred = false
      return yield* Effect.acquireUseRelease(
        runtime.retain,
        (held) =>
          Effect.gen(function* () {
            const result = yield* db
              .transaction(
                (tx) =>
                  Effect.gen(function* () {
                    const guard = yield* tx
                      .select()
                      .from(DirectoryMaintenanceGuardTable)
                      .where(eq(DirectoryMaintenanceGuardTable.directory, directory))
                      .get()
                      .pipe(Effect.orDie)
                    if (guard && guard.state !== "released") {
                      return {
                        state: "blocked" as const,
                        blocked: {
                          directory,
                          guardId: guard.guard_id,
                          ownerID: guard.owner_id as RuntimeOwner.ID,
                          acquisitionId: guard.acquisition_id as DirectoryMaintenanceGuard.AcquisitionID,
                          generation: guard.generation,
                          state: guard.state,
                        } satisfies MaintenanceBlocker,
                      }
                    }

                    // Per-directory sequence over every prior lease row. The
                    // IMMEDIATE writer reservation makes concurrent
                    // acquisitions strictly ordered, and generation is a
                    // release fence, never liveness.
                    const prior = yield* tx
                      .select({ generation: DirectoryActivityLeaseTable.generation })
                      .from(DirectoryActivityLeaseTable)
                      .where(eq(DirectoryActivityLeaseTable.directory, directory))
                      .all()
                      .pipe(Effect.orDie)
                    const generation = prior.reduce((max, row) => Math.max(max, row.generation), 0) + 1
                    const now = Date.now()
                    yield* tx
                      .insert(DirectoryActivityLeaseTable)
                      .values({
                        lease_id: leaseId,
                        directory,
                        kind,
                        owner_id: runtime.id,
                        generation,
                        state: "active",
                        acquired_at: now,
                        released_at: null,
                        updated_at: now,
                      })
                      .run()
                      .pipe(Effect.orDie)
                    return {
                      state: "acquired" as const,
                      token: {
                        leaseId,
                        kind,
                        ownerID: runtime.id,
                        generation,
                        directory,
                      } satisfies Token,
                    }
                  }),
                { behavior: "immediate" },
              )
              .pipe(Effect.orDie)
            if (result.state === "acquired") {
              retentions.set(leaseId, held)
              transferred = true
            }
            return result
          }),
        (held) =>
          Effect.suspend(() => (transferred ? Effect.void : reconcileExitRetention(leaseId, held))).pipe(
            Effect.uninterruptible,
          ),
      )
    })

    const assertHealthy = Effect.fn("DirectoryActivityLease.assertHealthy")(function* (token: Token) {
      const parsed = parseToken(token)
      if (parsed === undefined) {
        const claimed = rawLeaseId(token)
        if (claimed !== undefined) yield* dropTerminalRetention(claimed)
        return { state: "unhealthy" as const, issues: [malformedIssue(token)] }
      }
      const row = yield* readDb
        .select()
        .from(DirectoryActivityLeaseTable)
        .where(eq(DirectoryActivityLeaseTable.lease_id, parsed.leaseId))
        .get()
        .pipe(Effect.orDie)

      const issues: HealthIssue[] = []
      if (!row) issues.push({ directory: parsed.directory, reason: "missing" })
      else if (row.directory !== parsed.directory) {
        issues.push({ directory: parsed.directory, reason: "foreign-directory" })
      } else if (row.kind !== parsed.kind) {
        issues.push({ directory: parsed.directory, reason: "foreign-kind" })
      } else if (row.owner_id !== parsed.ownerID) {
        issues.push({ directory: parsed.directory, reason: "foreign-owner" })
      } else if (row.generation !== parsed.generation) {
        issues.push({ directory: parsed.directory, reason: "wrong-generation" })
      } else if (row.state === "released") {
        issues.push({ directory: parsed.directory, reason: "released" })
      } else if (row.state === "reconcile_required") {
        issues.push({ directory: parsed.directory, reason: "reconcile_required" })
      }
      if (issues.length === 0) return { state: "healthy" as const }
      yield* dropTerminalRetention(parsed.leaseId)
      return { state: "unhealthy" as const, issues }
    })

    const release = Effect.fn("DirectoryActivityLease.release")(function* (token: Token) {
      const parsed = parseToken(token)
      if (parsed === undefined) {
        const claimed = rawLeaseId(token)
        if (claimed !== undefined) yield* dropTerminalRetention(claimed)
        return "stale" as const
      }
      const claim = parsed
      const result = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const row = yield* tx
                .select()
                .from(DirectoryActivityLeaseTable)
                .where(eq(DirectoryActivityLeaseTable.lease_id, claim.leaseId))
                .get()
                .pipe(Effect.orDie)
              const exactIdentity =
                row !== undefined &&
                row.state === "active" &&
                row.directory === claim.directory &&
                row.kind === claim.kind &&
                row.owner_id === claim.ownerID &&
                row.generation === claim.generation
              // No write may precede this check: a mismatch must roll back the
              // whole release, and a stale handle must never touch a newer
              // lease that reused the directory.
              if (!exactIdentity) return "stale" as const

              const now = Date.now()
              const released = yield* tx
                .update(DirectoryActivityLeaseTable)
                .set({ state: "released", released_at: now, updated_at: now })
                .where(
                  and(
                    eq(DirectoryActivityLeaseTable.lease_id, claim.leaseId),
                    eq(DirectoryActivityLeaseTable.state, "active"),
                    eq(DirectoryActivityLeaseTable.directory, claim.directory),
                    eq(DirectoryActivityLeaseTable.kind, claim.kind),
                    eq(DirectoryActivityLeaseTable.owner_id, claim.ownerID),
                    eq(DirectoryActivityLeaseTable.generation, claim.generation),
                  ),
                )
                .returning({ leaseId: DirectoryActivityLeaseTable.lease_id })
                .all()
                .pipe(Effect.orDie)
              if (released.length !== 1) {
                return yield* Effect.die(
                  "Directory activity lease release lost exact identity inside its writer transaction",
                )
              }
              return "released" as const
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)

      if (result === "released") {
        yield* dropRetention(claim.leaseId)
        return "released" as const
      }
      yield* dropTerminalRetention(claim.leaseId)
      return "stale" as const
    })

    const resolveReconcileRequired = Effect.fn("DirectoryActivityLease.resolveReconcileRequired")(function* (
      token: Token,
    ) {
      const parsed = parseToken(token)
      if (parsed === undefined) return { state: "stale" as const }
      const claim = parsed
      const proof = yield* runtime.proveLocalDeath(claim.ownerID)
      // Resolution authority is exact local death proven at resolution time.
      // TTL, heartbeat age, or handle age are never evidence, and every
      // uncertainty leaves the lease blocking.
      if (proof !== "dead") return { state: "blocked" as const, proof }

      const result = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const row = yield* tx
                .select()
                .from(DirectoryActivityLeaseTable)
                .where(eq(DirectoryActivityLeaseTable.lease_id, claim.leaseId))
                .get()
                .pipe(Effect.orDie)
              const exact =
                row !== undefined &&
                row.state === "reconcile_required" &&
                row.directory === claim.directory &&
                row.kind === claim.kind &&
                row.owner_id === claim.ownerID &&
                row.generation === claim.generation
              if (!exact) return "stale" as const

              const now = Date.now()
              const resolved = yield* tx
                .update(DirectoryActivityLeaseTable)
                .set({ state: "released", released_at: now, updated_at: now })
                .where(
                  and(
                    eq(DirectoryActivityLeaseTable.lease_id, claim.leaseId),
                    eq(DirectoryActivityLeaseTable.state, "reconcile_required"),
                    eq(DirectoryActivityLeaseTable.directory, claim.directory),
                    eq(DirectoryActivityLeaseTable.kind, claim.kind),
                    eq(DirectoryActivityLeaseTable.owner_id, claim.ownerID),
                    eq(DirectoryActivityLeaseTable.generation, claim.generation),
                  ),
                )
                .returning({ leaseId: DirectoryActivityLeaseTable.lease_id })
                .all()
                .pipe(Effect.orDie)
              if (resolved.length !== 1) {
                return yield* Effect.die(
                  "Directory activity lease resolution lost exact identity inside its writer transaction",
                )
              }
              return "resolved" as const
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)

      if (result === "resolved") {
        yield* dropRetention(claim.leaseId)
        return { state: "resolved" as const }
      }
      return { state: "stale" as const }
    })

    const reconcile = Effect.fn("DirectoryActivityLease.reconcile")(function* () {
      const rows = yield* readDb
        .select()
        .from(DirectoryActivityLeaseTable)
        .where(eq(DirectoryActivityLeaseTable.state, "active"))
        .all()
        .pipe(Effect.orDie)

      const byOwner = new Map<string, Row[]>()
      for (const row of rows) {
        const owned = byOwner.get(row.owner_id)
        if (owned) owned.push(row)
        else byOwner.set(row.owner_id, [row])
      }

      const reconciled: Array<{
        leaseId: LeaseID
        kind: string
        ownerID: RuntimeOwner.ID
        directory: DirectoryKey
      }> = []
      const blocked: Array<{
        leaseId: LeaseID
        kind: string
        ownerID: RuntimeOwner.ID
        proof: Exclude<RuntimeOwner.LocalDeathProof, "dead">
        directory: DirectoryKey
      }> = []

      for (const [ownerID, owned] of byOwner) {
        const proof = yield* runtime.proveLocalDeath(ownerID as RuntimeOwner.ID)
        if (proof !== "dead") {
          // One entry per leaseId, so several leases held by one alive or
          // unknown owner are never collapsed into one aggregate.
          for (const row of [...owned].sort((left, right) => (left.lease_id < right.lease_id ? -1 : 1))) {
            blocked.push({
              leaseId: row.lease_id as LeaseID,
              kind: row.kind,
              ownerID: ownerID as RuntimeOwner.ID,
              proof,
              directory: row.directory as DirectoryKey,
            })
          }
          continue
        }

        // IMMEDIATE transaction re-reads the dead owner's active rows and
        // transitions each lease by its exact lease_id. A partial update can
        // never commit: count mismatches die inside the writer transaction.
        yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const live = yield* tx
                  .select()
                  .from(DirectoryActivityLeaseTable)
                  .where(
                    and(
                      eq(DirectoryActivityLeaseTable.owner_id, ownerID),
                      eq(DirectoryActivityLeaseTable.state, "active"),
                    ),
                  )
                  .all()
                  .pipe(Effect.orDie)
                const now = Date.now()
                for (const row of [...live].sort((left, right) => (left.lease_id < right.lease_id ? -1 : 1))) {
                  const updated = yield* tx
                    .update(DirectoryActivityLeaseTable)
                    .set({ state: "reconcile_required", updated_at: now })
                    .where(
                      and(
                        eq(DirectoryActivityLeaseTable.lease_id, row.lease_id),
                        eq(DirectoryActivityLeaseTable.owner_id, ownerID),
                        eq(DirectoryActivityLeaseTable.state, "active"),
                      ),
                    )
                    .returning({ leaseId: DirectoryActivityLeaseTable.lease_id })
                    .all()
                    .pipe(Effect.orDie)
                  if (updated.length !== 1) {
                    return yield* Effect.die(
                      "Directory activity lease reconciliation lost exact lease identity",
                    )
                  }
                  reconciled.push({
                    leaseId: row.lease_id as LeaseID,
                    kind: row.kind,
                    ownerID: ownerID as RuntimeOwner.ID,
                    directory: row.directory as DirectoryKey,
                  })
                }
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
      }

      return { reconciled, blocked }
    })

    const withLease = <A, E, R>(
      directory: string,
      kind: string,
      effect: (token: Token) => Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | Error | BlockedError, R> =>
      Effect.acquireUseRelease(
        acquire({ directory, kind }).pipe(
          Effect.flatMap((result) =>
            result.state === "acquired"
              ? Effect.succeed(result.token)
              : Effect.fail(
                  new BlockedError({
                    directory: result.blocked.directory,
                    guardId: result.blocked.guardId,
                    ownerID: result.blocked.ownerID,
                    acquisitionId: result.blocked.acquisitionId,
                    generation: result.blocked.generation,
                    state: result.blocked.state,
                  }),
                ),
          ),
        ),
        (token) => effect(token),
        (token) => release(token).pipe(Effect.asVoid),
      )

    return Service.of({
      acquire,
      assertHealthy,
      release,
      resolveReconcileRequired,
      reconcile,
      withLease,
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, RuntimeOwner.node],
})
