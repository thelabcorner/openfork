export * as DirectoryMaintenanceGuard from "./directory-maintenance-guard"

import { and, eq, inArray, isNotNull, ne, or } from "drizzle-orm"
import { realpathSync, statSync } from "node:fs"
import nodePath from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "./database/database"
import type { ActivityLeaseBlocker, LeaseID } from "./directory-activity-lease"
import { DirectoryActivityLeaseTable } from "./directory-activity-lease.sql"
import { DirectoryMaintenanceGuardTable } from "./directory-maintenance-guard.sql"
import { makeGlobalNode } from "./effect/app-node"
import { RuntimeOwner } from "./runtime-owner"
import { SessionExecutionOwnerTable } from "./session/execution-owner.sql"
import { SessionSchema } from "./session/schema"
import { SessionTable } from "./session/sql"

export type State = typeof DirectoryMaintenanceGuardTable.$inferSelect.state
export type DirectoryKey = string & { readonly __directoryMaintenanceGuardKey: "DirectoryMaintenanceGuardKey" }
/** Durable identity of one whole multi-directory acquisition. */
export type AcquisitionID = string & {
  readonly __directoryMaintenanceGuardAcquisitionID: "DirectoryMaintenanceGuardAcquisitionID"
}
export type HeldState = Exclude<State, "released">

export class InvalidDirectoryError extends Schema.TaggedErrorClass<InvalidDirectoryError>()(
  "DirectoryMaintenanceGuard.InvalidDirectoryError",
  { directory: Schema.String },
) {}

export class DuplicateDirectoryError extends Schema.TaggedErrorClass<DuplicateDirectoryError>()(
  "DirectoryMaintenanceGuard.DuplicateDirectoryError",
  { directory: Schema.String },
) {}

export class InsufficientDirectoriesError extends Schema.TaggedErrorClass<InsufficientDirectoriesError>()(
  "DirectoryMaintenanceGuard.InsufficientDirectoriesError",
  { count: Schema.Number },
) {}

export class InvalidGuardIDError extends Schema.TaggedErrorClass<InvalidGuardIDError>()(
  "DirectoryMaintenanceGuard.InvalidGuardIDError",
  { guardId: Schema.String },
) {}

export type Error =
  | InvalidDirectoryError
  | DuplicateDirectoryError
  | InsufficientDirectoriesError
  | InvalidGuardIDError

export interface AcquireInput {
  readonly guardId: string
  readonly directories: readonly string[]
}

/**
 * Exact handle for one acquisition.
 *
 * `acquisitionId` is the durable whole-acquisition fence: every row published
 * by a successful `acquire` stores it identically, and `assertHealthy`/`release`
 * require it together with guardId + ownerID + generation + active state and an
 * exactly equal directory set. `generation` remains an additional fence for
 * released-row reuse and never substitutes for the acquisition identity.
 */
export interface Token {
  readonly acquisitionId: AcquisitionID
  readonly guardId: string
  readonly ownerID: RuntimeOwner.ID
  readonly generation: number
  readonly directories: ReadonlyArray<DirectoryKey>
}

export interface BlockedDirectory {
  readonly directory: DirectoryKey
  readonly guardId: string
  readonly ownerID: RuntimeOwner.ID
  /** Durable identity of the acquisition currently holding this directory. */
  readonly acquisitionId: AcquisitionID
  /** Durable generation of the acquisition currently holding this directory. */
  readonly generation: number
  readonly state: HeldState
}

export interface ActiveExecutionBlocker {
  readonly sessionID: SessionSchema.ID
  readonly ownerID: RuntimeOwner.ID
  readonly generation: number
  readonly persistedDirectory: string
  readonly directory: DirectoryKey | null
  readonly recoveryOwnerID?: RuntimeOwner.ID
}

export type AcquireResult =
  | { readonly state: "acquired"; readonly token: Token }
  | {
      readonly state: "blocked"
      readonly blocked: ReadonlyArray<BlockedDirectory>
      /**
       * Non-session shared-writer activity leases overlapping the requested
       * directories, kept distinct from guard blockers and session-execution
       * blockers. The service always populates this collection; it is optional
       * only so existing mock surfaces stay assignable without pretending a
       * lease is a guard.
       */
      readonly activityLeases?: ReadonlyArray<ActivityLeaseBlocker>
      readonly executing: ReadonlyArray<ActiveExecutionBlocker>
    }

export type ReleaseResult = "released" | "stale"

export type HealthIssueReason =
  | "missing"
  | "released"
  | "reconcile_required"
  | "foreign-acquisition"
  | "foreign-guard"
  | "foreign-owner"
  | "wrong-generation"
  | "directory-set-mismatch"
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
    readonly acquisitionId: AcquisitionID
    readonly ownerID: RuntimeOwner.ID
    readonly directories: ReadonlyArray<DirectoryKey>
  }>
  readonly blocked: ReadonlyArray<{
    readonly acquisitionId: AcquisitionID
    readonly ownerID: RuntimeOwner.ID
    readonly proof: Exclude<RuntimeOwner.LocalDeathProof, "dead">
    readonly directories: ReadonlyArray<DirectoryKey>
  }>
}

export interface Interface {
  /**
   * Atomically acquires two or more distinct canonical physical directory keys
   * under one guardId and one runtime owner in a single IMMEDIATE transaction.
   * Every published row carries one freshly minted acquisitionId. Any existing
   * active/reconcile_required row blocks the entire acquisition with no partial
   * writes; released rows are exact-reused; absent rows are inserted.
   *
   * Inputs must resolve to existing physical directories: a missing directory,
   * a failed realpath, or an ambiguous relative/device-namespace form is
   * rejected before any durable change.
   *
   * A successful acquisition keeps this RuntimeOwner's heartbeat retained until
   * the matching token is released (or is discovered stale).
   */
  readonly acquire: (input: AcquireInput) => Effect.Effect<AcquireResult, Error>
  /**
   * Proves the exact acquisition is healthy. The token must carry well-formed,
   * canonical, duplicate-free directories, and all rows belonging to its
   * acquisitionId must equal that directory set exactly. Missing, released,
   * reconcile_required, foreign-acquisition, foreign-guard, foreign-owner,
   * superseded, malformed, truncated, extended, or forged state is unhealthy.
   */
  readonly assertHealthy: (token: Token) => Effect.Effect<HealthResult>
  /**
   * Transitions every row of the exact acquisition to released in one IMMEDIATE
   * transaction, but only on exact acquisitionId + guardId + owner + generation
   * + active identity and an exactly equal directory set. Malformed, truncated,
   * extended, or forged tokens report `stale` with zero durable changes; any
   * mismatch rolls back all rows.
   */
  readonly release: (token: Token) => Effect.Effect<ReleaseResult>
  /**
   * Service-only operator resolution for one exact `reconcile_required`
   * acquisition. It transitions to `released` only when the token carries the
   * exact acquisitionId + guardId + owner + generation + directory-set identity
   * AND RuntimeOwner.proveLocalDeath(ownerID) === dead at resolution time. Every
   * other outcome (unknown identity, live or unprovable owner, active rows) is
   * `stale` or `blocked` with zero durable changes; uncertainty stays blocking.
   * Not wired to any route: reconcile() itself never auto-releases.
   */
  readonly resolveReconcileRequired: (token: Token) => Effect.Effect<ResolveReconcileRequiredResult>
  /**
   * Crash reconciliation. Active rows are inspected per owner and only
   * `RuntimeOwner.proveLocalDeath(owner_id) === "dead"` may transition them to
   * reconcile_required. Each acquisition is reconciled by its exact
   * acquisitionId so several acquisitions owned by one dead runtime remain
   * separately auditable. Alive-or-unknown / not-local-or-unknown owners remain
   * active and blocking, and their blocked report is equally
   * acquisition-granular: one entry per acquisitionId carrying that
   * acquisition's exact directories, even when the same owner holds several.
   * Reconciliation never releases.
   */
  readonly reconcile: () => Effect.Effect<ReconcileReport>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/DirectoryMaintenanceGuard") {}

export const MINIMUM_DIRECTORIES = 2
/** Canonical guard-identity bound, mirrored exactly from worktree-store. */
export const MAX_CANONICAL_GUARD_ID_LENGTH = 200

const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:\//
const WINDOWS_DRIVE_ROOT = /^[A-Za-z]:$/
const WINDOWS_UNC_ROOT = /^\/\/[^/]+\/[^/]+$/
const WINDOWS_DEVICE_ROOT = /^\/\/[?.](\/|$)/
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const WHITESPACE = /\s/

/**
 * A durable Windows identity must be fully qualified: drive-absolute
 * (`C:/...`) or a UNC share (`//server/share/...`). Root-relative (`/foo`) and
 * drive-relative (`C:foo`) forms resolve against ambient process state rather
 * than filesystem identity, and the `\\?\` / `\\.\` device namespaces are
 * rejected because folding them would mint a second key for the same
 * directory.
 */
function windowsQualified(value: string) {
  if (WINDOWS_DEVICE_ROOT.test(value)) return false
  if (WINDOWS_DRIVE_ABSOLUTE.test(value)) return true
  if (!value.startsWith("//")) return false
  return value.split("/").filter((segment) => segment.length > 0).length >= 2
}

/**
 * Pure lexical normalization of an already-absolute directory spelling.
 *
 * This helper performs no filesystem access and is deliberately NOT the
 * admission-grade identity: two names for one junction/symlink alias would
 * normalize to two different keys. It exists for token-shape validation and
 * for tests/diagnostics that must distinguish lexical normalization from
 * physical identity. Admission must use `existingDirectoryKey`.
 *
 * Windows inputs must be fully qualified, both platforms normalize `.`/`..`
 * segments and repeated separators with their own path semantics, and Windows
 * case is folded because the filesystem is case-insensitive (`C:/Repo` and
 * `c:/repo` must never become parallel authority records). Trailing separators
 * are removed except for filesystem, drive, and UNC share roots. Returns
 * undefined for input that cannot be a durable directory identity.
 */
export function lexicalDirectoryKey(
  input: string,
  platform: typeof process.platform = process.platform,
): DirectoryKey | undefined {
  if (platform === "win32") {
    const storage = input.replaceAll("\\", "/")
    if (!windowsQualified(storage)) return undefined
    const normalized = nodePath.win32.normalize(storage).replaceAll("\\", "/")
    // Normalization can rewrite the prefix (`//server` normalizes to `\server`)
    // or clamp dot segments at a root, so re-qualify the result before it
    // becomes a key.
    if (!windowsQualified(normalized)) return undefined
    const collapsed = normalized.replace(/\/+$/, "")
    const canonical =
      collapsed === ""
        ? normalized
        : WINDOWS_DRIVE_ROOT.test(collapsed) || WINDOWS_UNC_ROOT.test(collapsed)
          ? `${collapsed}/`
          : collapsed
    return canonical.toLowerCase() as DirectoryKey
  }

  if (!nodePath.posix.isAbsolute(input)) return undefined
  const normalized = nodePath.posix.normalize(input)
  const collapsed = normalized.replace(/\/+$/, "")
  return (collapsed === "" ? "/" : collapsed) as DirectoryKey
}

/**
 * Resolves the physical path of an existing directory, or undefined when that
 * cannot be proven. `realpath` failure is never replaced by a lexical form.
 */
function physicalRealpath(input: string, platform: typeof process.platform): string | undefined {
  try {
    const resolved = platform === "win32" ? realpathSync.native(input) : realpathSync(input)
    if (!statSync(resolved).isDirectory()) return undefined
    if (platform !== "win32") return resolved
    // `realpathSync.native` may answer with an extended-length namespace path
    // (`\\?\C:\...` or `\\?\UNC\server\share\...`). Those are still proven
    // physical identities, so fold them back to their drive/UNC spelling; a
    // volume-GUID answer has no drive-qualified spelling and is rejected.
    if (!resolved.startsWith("\\\\?\\")) return resolved
    const stripped = resolved.slice(4)
    if (stripped.startsWith("UNC\\")) return `\\\\${stripped.slice(4)}`
    return /^[A-Za-z]:\\/.test(stripped) ? stripped : undefined
  } catch {
    return undefined
  }
}

/**
 * Strict physical identity for an existing directory; the admission-grade
 * canonicalizer used by `acquire` and future admission consumers.
 *
 * The input form is validated first (fully qualified Windows drive/UNC, or a
 * POSIX absolute path — never relative, root-relative, drive-relative, or a
 * `\\?\` / `\\.\` device namespace), then the directory must physically exist
 * and `realpath` must succeed before any lexical normalization. A failed or
 * ambiguous realpath is never silently replaced by the lexical form, so two
 * names for one junction/symlink alias collapse onto one key instead of
 * minting split authority. Returns undefined when a safe existing physical
 * directory cannot be proven.
 */
export function existingDirectoryKey(
  input: string,
  platform: typeof process.platform = process.platform,
): DirectoryKey | undefined {
  if (platform === "win32") {
    if (!windowsQualified(input.replaceAll("\\", "/"))) return undefined
  } else if (!nodePath.posix.isAbsolute(input)) {
    return undefined
  }
  const real = physicalRealpath(input, platform)
  if (real === undefined) return undefined
  return lexicalDirectoryKey(real, platform)
}

/**
 * A cross-system correlation key. Leading/trailing whitespace and embedded
 * control characters (including NUL, the delimiter that used to join caller
 * strings) are rejected rather than silently normalized or made ambiguous.
 */
function canonicalIdentifier(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined
  if (input.length === 0) return undefined
  if (input !== input.trim()) return undefined
  if (CONTROL_CHARACTERS.test(input)) return undefined
  return input
}

/**
 * Canonical caller-supplied guard identity, mirrored exactly from
 * worktree-store's canonical guard-id rule: non-empty, at most
 * MAX_CANONICAL_GUARD_ID_LENGTH characters, with no control characters and no
 * whitespace anywhere (leading, trailing, or embedded). Padded, over-length,
 * delimited, and empty identities are rejected rather than normalized.
 */
function canonicalGuardId(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined
  if (input.length === 0) return undefined
  if (CONTROL_CHARACTERS.test(input)) return undefined
  if (input !== input.trim() || WHITESPACE.test(input)) return undefined
  if (input.length > MAX_CANONICAL_GUARD_ID_LENGTH) return undefined
  return input
}

interface ParsedToken {
  readonly acquisitionId: string
  readonly guardId: string
  readonly ownerID: RuntimeOwner.ID
  readonly generation: number
  readonly directories: ReadonlyArray<DirectoryKey>
}

/**
 * Structural + lexical validation of a token, performed before any durable
 * read or write. Rejects empty, duplicate, non-canonical (trailing separator,
 * case-folded alias, relative form, ...) and undersized directory sets.
 */
function parseToken(token: Token): ParsedToken | undefined {
  const acquisitionId = canonicalIdentifier((token as { readonly acquisitionId?: unknown } | undefined)?.acquisitionId)
  const guardId = canonicalGuardId((token as { readonly guardId?: unknown } | undefined)?.guardId)
  const ownerID = canonicalIdentifier((token as { readonly ownerID?: unknown } | undefined)?.ownerID)
  if (acquisitionId === undefined || guardId === undefined || ownerID === undefined) return undefined
  const generation = (token as { readonly generation?: unknown } | undefined)?.generation
  if (typeof generation !== "number" || !Number.isInteger(generation) || generation <= 0) return undefined
  const raw = (token as { readonly directories?: unknown } | undefined)?.directories
  if (!Array.isArray(raw) || raw.length < MINIMUM_DIRECTORIES) return undefined

  const directories: DirectoryKey[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== "string") return undefined
    const key = lexicalDirectoryKey(entry)
    if (key === undefined || key !== entry) return undefined
    if (seen.has(key)) return undefined
    seen.add(key)
    directories.push(key)
  }
  return { acquisitionId, guardId, ownerID: ownerID as RuntimeOwner.ID, generation, directories: directories.sort() }
}

const malformedIssue = (token: Token): HealthIssue => {
  const raw = (token as { readonly directories?: unknown } | undefined)?.directories
  const directory =
    Array.isArray(raw) && typeof raw[0] === "string" ? (raw[0] as DirectoryKey) : ("" as DirectoryKey)
  return { directory, reason: "malformed-token" }
}

const rawAcquisitionId = (token: Token): string | undefined => {
  const value = (token as { readonly acquisitionId?: unknown } | undefined)?.acquisitionId
  return typeof value === "string" && value.length > 0 ? value : undefined
}

type Row = typeof DirectoryMaintenanceGuardTable.$inferSelect

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db, readDb } = yield* Database.Service
    const runtime = yield* RuntimeOwner.Service
    // Retention is keyed by the durable acquisition identity, never by a
    // delimiter-joined caller string, so a release of one acquisition can
    // never stop the heartbeat another live acquisition still needs.
    const retentions = new Map<string, RuntimeOwner.Retention>()

    const dropRetention = Effect.fn("DirectoryMaintenanceGuard.dropRetention")(function* (
      acquisitionId: string,
      fallback?: RuntimeOwner.Retention,
    ) {
      const retention = retentions.get(acquisitionId) ?? fallback
      if (!retention) return
      retentions.delete(acquisitionId)
      yield* retention.release
    })

    // A stale/invalid terminal handle must not leak a retention, but a retained
    // heartbeat is only dropped once no durable row for that acquisition is
    // still non-released. Ambiguity keeps the retention: releasing a heartbeat
    // that a healthy active acquisition still needs is the unsafe direction.
    const dropTerminalRetention = Effect.fn("DirectoryMaintenanceGuard.dropTerminalRetention")(function* (
      acquisitionId: string,
    ) {
      if (!retentions.has(acquisitionId)) return
      const live = yield* readDb
        .select({ directory: DirectoryMaintenanceGuardTable.directory })
        .from(DirectoryMaintenanceGuardTable)
        .where(
          and(
            eq(DirectoryMaintenanceGuardTable.acquisition_id, acquisitionId),
            ne(DirectoryMaintenanceGuardTable.state, "released"),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      if (live.length > 0) return
      yield* dropRetention(acquisitionId)
    })

    // Finalization-boundary retention settlement. Every exit that did not
    // transfer the retention — a blocked settlement, a defect, an interrupt, or
    // an interruption between durable commit and the retention transfer — runs
    // this uninterruptibly, so durable ownership is proven by acquisitionId
    // before anything is released: a non-released acquisition adopts the
    // retention (a committed guard keeps its heartbeat) and an empty
    // acquisition releases it exactly once.
    const reconcileExitRetention = Effect.fn("DirectoryMaintenanceGuard.reconcileExitRetention")(function* (
      acquisitionId: string,
      retention: RuntimeOwner.Retention,
    ) {
      const published = yield* readDb
        .select({ directory: DirectoryMaintenanceGuardTable.directory, state: DirectoryMaintenanceGuardTable.state })
        .from(DirectoryMaintenanceGuardTable)
        .where(eq(DirectoryMaintenanceGuardTable.acquisition_id, acquisitionId))
        .all()
        .pipe(Effect.orDie)
      if (published.some((row) => row.state !== "released")) {
        retentions.set(acquisitionId, retention)
        return
      }
      yield* dropRetention(acquisitionId, retention)
    })

    const canonicalize = Effect.fn("DirectoryMaintenanceGuard.canonicalize")(function* (
      inputs: readonly string[],
    ) {
      const keys: DirectoryKey[] = []
      const seen = new Set<DirectoryKey>()
      for (const input of inputs) {
        const key = existingDirectoryKey(input)
        if (key === undefined) return yield* new InvalidDirectoryError({ directory: input })
        if (seen.has(key)) return yield* new DuplicateDirectoryError({ directory: key })
        seen.add(key)
        keys.push(key)
      }
      if (keys.length < MINIMUM_DIRECTORIES) return yield* new InsufficientDirectoriesError({ count: keys.length })
      return keys.sort()
    })

    const acquire = Effect.fn("DirectoryMaintenanceGuard.acquire")(function* (input: AcquireInput) {
      const guardId = canonicalGuardId(input.guardId)
      if (guardId === undefined) return yield* new InvalidGuardIDError({ guardId: input.guardId })
      const directories = yield* canonicalize(input.directories)
      const acquisitionId = `directory-maintenance:${crypto.randomUUID()}` as AcquisitionID

      // Retain and durable publish share one bracket: `runtime.retain` is the
      // uninterruptible acquire step and the settlement finalizer is installed
      // before the transaction boundary is entered, so an interrupt delivered
      // while retain is still resolving — the retain-to-finalizer registration
      // boundary — completes that retain and settles it instead of leaking a
      // heartbeat. `transferred` flips synchronously with `retentions.set`, so
      // every exit that did not transfer — blocked success, defect, interrupt,
      // or an interruption between durable commit and the transfer — settles
      // the retention exactly once from durable state inside the finalizer.
      let transferred = false
      return yield* Effect.acquireUseRelease(
        // Retain before publishing durable authority so the owner row and its
        // heartbeat exist for the whole guard lifetime.
        runtime.retain,
        (held) =>
          Effect.gen(function* () {
            const result = yield* db
              .transaction(
                (tx) =>
                  Effect.gen(function* () {
                    const existing = yield* tx
                      .select()
                      .from(DirectoryMaintenanceGuardTable)
                      .where(inArray(DirectoryMaintenanceGuardTable.directory, directories))
                      .all()
                      .pipe(Effect.orDie)
                    const byDirectory = new Map(existing.map((row) => [row.directory, row]))

                    const blocked = directories.flatMap((directory): ReadonlyArray<BlockedDirectory> => {
                      const row = byDirectory.get(directory)
                      if (!row || row.state === "released") return []
                      return [
                        {
                          directory,
                          guardId: row.guard_id,
                          ownerID: row.owner_id as RuntimeOwner.ID,
                          acquisitionId: row.acquisition_id as AcquisitionID,
                          generation: row.generation,
                          state: row.state,
                        },
                      ]
                    })
                    // Shared activity leases are checked in the same IMMEDIATE
                    // writer transaction as SessionExecutionOwner, so whichever
                    // authority commits first is visible to the loser before it
                    // may publish conflicting authority. Activity leases block
                    // exclusive maintenance but never block each other.
                    const activeLeases = yield* tx
                      .select({
                        directory: DirectoryActivityLeaseTable.directory,
                        leaseId: DirectoryActivityLeaseTable.lease_id,
                        kind: DirectoryActivityLeaseTable.kind,
                        ownerID: DirectoryActivityLeaseTable.owner_id,
                        generation: DirectoryActivityLeaseTable.generation,
                        state: DirectoryActivityLeaseTable.state,
                      })
                      .from(DirectoryActivityLeaseTable)
                      .where(
                        and(
                          inArray(DirectoryActivityLeaseTable.directory, directories),
                          ne(DirectoryActivityLeaseTable.state, "released"),
                        ),
                      )
                      .all()
                      .pipe(Effect.orDie)
                    const activityLeases: ActivityLeaseBlocker[] = activeLeases
                      .map((row) => ({
                        directory: row.directory as DirectoryKey,
                        leaseId: row.leaseId as LeaseID,
                        kind: row.kind,
                        ownerID: row.ownerID as RuntimeOwner.ID,
                        generation: row.generation,
                        state: row.state as HeldState,
                      }))
                      .sort((left, right) => {
                        if (left.directory !== right.directory) return left.directory < right.directory ? -1 : 1
                        if (left.leaseId === right.leaseId) return 0
                        return left.leaseId < right.leaseId ? -1 : 1
                      })
                    if (blocked.length > 0) {
                      return { state: "blocked" as const, blocked, activityLeases, executing: [] }
                    }

                    // Symmetric half of the execution/maintenance admission
                    // fence. This check shares the same SQLite IMMEDIATE writer
                    // serialization as SessionExecutionOwner.tryAcquire, so
                    // whichever authority commits first is visible to the
                    // loser before it may publish conflicting authority.
                    const activeExecutions = yield* tx
                      .select({
                        sessionID: SessionExecutionOwnerTable.session_id,
                        ownerID: SessionExecutionOwnerTable.owner_id,
                        generation: SessionExecutionOwnerTable.generation,
                        recoveryOwnerID: SessionExecutionOwnerTable.recovery_owner_id,
                        directory: SessionTable.directory,
                      })
                      .from(SessionExecutionOwnerTable)
                      .innerJoin(SessionTable, eq(SessionTable.id, SessionExecutionOwnerTable.session_id))
                      .where(isNotNull(SessionExecutionOwnerTable.owner_id))
                      .all()
                      .pipe(Effect.orDie)

                    const requested = new Set<string>(directories)
                    const executing: ActiveExecutionBlocker[] = []
                    for (const active of activeExecutions) {
                      const directory = existingDirectoryKey(active.directory)
                      // A live execution with an unprovable physical directory
                      // is ambiguous authority. Unknown overlap blocks rather
                      // than being guessed safe.
                      if (directory === undefined || requested.has(directory)) {
                        executing.push({
                          sessionID: SessionSchema.ID.make(active.sessionID),
                          ownerID: active.ownerID as RuntimeOwner.ID,
                          generation: active.generation,
                          persistedDirectory: active.directory,
                          directory: directory ?? null,
                          ...(active.recoveryOwnerID === null
                            ? {}
                            : { recoveryOwnerID: active.recoveryOwnerID as RuntimeOwner.ID }),
                        })
                      }
                    }
                    if (activityLeases.length > 0 || executing.length > 0) {
                      return { state: "blocked" as const, blocked: [], activityLeases, executing }
                    }

                    const now = Date.now()
                    const generation = existing.reduce((max, row) => Math.max(max, row.generation), 0) + 1
                    for (const directory of directories) {
                      const row = byDirectory.get(directory)
                      if (!row) {
                        yield* tx
                          .insert(DirectoryMaintenanceGuardTable)
                          .values({
                            directory,
                            guard_id: guardId,
                            owner_id: runtime.id,
                            acquisition_id: acquisitionId,
                            generation,
                            state: "active",
                            acquired_at: now,
                            released_at: null,
                            updated_at: now,
                          })
                          .run()
                          .pipe(Effect.orDie)
                        continue
                      }
                      const reused = yield* tx
                        .update(DirectoryMaintenanceGuardTable)
                        .set({
                          guard_id: guardId,
                          owner_id: runtime.id,
                          acquisition_id: acquisitionId,
                          generation,
                          state: "active",
                          acquired_at: now,
                          released_at: null,
                          updated_at: now,
                        })
                        .where(
                          and(
                            eq(DirectoryMaintenanceGuardTable.directory, directory),
                            eq(DirectoryMaintenanceGuardTable.state, "released"),
                            eq(DirectoryMaintenanceGuardTable.generation, row.generation),
                            eq(DirectoryMaintenanceGuardTable.acquisition_id, row.acquisition_id),
                          ),
                        )
                        .returning({ directory: DirectoryMaintenanceGuardTable.directory })
                        .get()
                        .pipe(Effect.orDie)
                      if (!reused) {
                        // Unreachable while this transaction holds the IMMEDIATE
                        // writer reservation; fail closed instead of committing a
                        // partially acquired guard.
                        return yield* Effect.die(
                          "Directory maintenance guard lost released-row reuse inside its writer transaction",
                        )
                      }
                    }
                    return {
                      state: "acquired" as const,
                      token: {
                        acquisitionId,
                        guardId,
                        ownerID: runtime.id,
                        generation,
                        directories,
                      } satisfies Token,
                    }
                  }),
                { behavior: "immediate" },
              )
              .pipe(Effect.orDie)
            if (result.state === "acquired") {
              retentions.set(acquisitionId, held)
              transferred = true
            }
            return result
          }),
        (held) =>
          Effect.suspend(() => (transferred ? Effect.void : reconcileExitRetention(acquisitionId, held))).pipe(
            Effect.uninterruptible,
          ),
      )
    })

    const assertHealthy = Effect.fn("DirectoryMaintenanceGuard.assertHealthy")(function* (token: Token) {
      const parsed = parseToken(token)
      if (parsed === undefined) {
        const claimed = rawAcquisitionId(token)
        if (claimed !== undefined) yield* dropTerminalRetention(claimed)
        return { state: "unhealthy" as const, issues: [malformedIssue(token)] }
      }
      // Rows are read both by acquisition identity (what the token claims to
      // be) and by the token's directories (what they currently are), so a
      // truncated, extended, or forged set can never be mistaken for healthy.
      const rows = yield* readDb
        .select()
        .from(DirectoryMaintenanceGuardTable)
        .where(
          or(
            inArray(DirectoryMaintenanceGuardTable.directory, [...parsed.directories]),
            eq(DirectoryMaintenanceGuardTable.acquisition_id, parsed.acquisitionId),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      const byDirectory = new Map(rows.map((row) => [row.directory, row]))
      const owned = new Set(
        rows
          .filter((row) => row.acquisition_id === parsed.acquisitionId)
          .map((row) => row.directory as string),
      )
      const claimed = new Set<string>(parsed.directories)

      const issues: HealthIssue[] = []
      for (const directory of Array.from(new Set([...claimed, ...owned])).sort()) {
        const row = byDirectory.get(directory)
        if (!claimed.has(directory)) {
          issues.push({ directory: directory as DirectoryKey, reason: "directory-set-mismatch" })
          continue
        }
        if (!row) {
          issues.push({ directory: directory as DirectoryKey, reason: "missing" })
          continue
        }
        if (row.acquisition_id !== parsed.acquisitionId) {
          issues.push({ directory: directory as DirectoryKey, reason: "foreign-acquisition" })
          continue
        }
        if (row.guard_id !== parsed.guardId) {
          issues.push({ directory: directory as DirectoryKey, reason: "foreign-guard" })
          continue
        }
        if (row.owner_id !== parsed.ownerID) {
          issues.push({ directory: directory as DirectoryKey, reason: "foreign-owner" })
          continue
        }
        if (row.generation !== parsed.generation) {
          issues.push({ directory: directory as DirectoryKey, reason: "wrong-generation" })
          continue
        }
        if (row.state === "released") {
          issues.push({ directory: directory as DirectoryKey, reason: "released" })
          continue
        }
        if (row.state === "reconcile_required") {
          issues.push({ directory: directory as DirectoryKey, reason: "reconcile_required" })
        }
      }
      if (issues.length === 0) return { state: "healthy" as const }
      yield* dropTerminalRetention(parsed.acquisitionId)
      return { state: "unhealthy" as const, issues }
    })

    const release = Effect.fn("DirectoryMaintenanceGuard.release")(function* (token: Token) {
      const parsed = parseToken(token)
      if (parsed === undefined) {
        const claimed = rawAcquisitionId(token)
        if (claimed !== undefined) yield* dropTerminalRetention(claimed)
        return "stale" as const
      }
      const claim = parsed
      const result = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const rows = yield* tx
                .select()
                .from(DirectoryMaintenanceGuardTable)
                .where(eq(DirectoryMaintenanceGuardTable.acquisition_id, claim.acquisitionId))
                .all()
                .pipe(Effect.orDie)
              const owned = new Set(rows.map((row) => row.directory as string))
              const exactSet =
                rows.length === claim.directories.length &&
                claim.directories.every((directory) => owned.has(directory))
              const exactIdentity =
                exactSet &&
                rows.every(
                  (row) =>
                    row.state === "active" &&
                    row.guard_id === claim.guardId &&
                    row.owner_id === claim.ownerID &&
                    row.generation === claim.generation,
                )
              // No write may precede this check: a mismatch must roll back the
              // whole guard, never release the rows that happened to match, and
              // a subset/superset/forged set must make zero durable changes.
              if (!exactIdentity) return "stale" as const

              const now = Date.now()
              const released = yield* tx
                .update(DirectoryMaintenanceGuardTable)
                .set({ state: "released", released_at: now, updated_at: now })
                .where(
                  and(
                    eq(DirectoryMaintenanceGuardTable.acquisition_id, claim.acquisitionId),
                    eq(DirectoryMaintenanceGuardTable.state, "active"),
                    eq(DirectoryMaintenanceGuardTable.guard_id, claim.guardId),
                    eq(DirectoryMaintenanceGuardTable.owner_id, claim.ownerID),
                    eq(DirectoryMaintenanceGuardTable.generation, claim.generation),
                    inArray(DirectoryMaintenanceGuardTable.directory, [...claim.directories]),
                  ),
                )
                .returning({ directory: DirectoryMaintenanceGuardTable.directory })
                .all()
                .pipe(Effect.orDie)
              if (released.length !== claim.directories.length) {
                return yield* Effect.die(
                  "Directory maintenance guard release lost exact identity inside its writer transaction",
                )
              }
              return "released" as const
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)

      if (result === "released") {
        yield* dropRetention(claim.acquisitionId)
        return "released" as const
      }
      yield* dropTerminalRetention(claim.acquisitionId)
      return "stale" as const
    })

    const resolveReconcileRequired = Effect.fn("DirectoryMaintenanceGuard.resolveReconcileRequired")(function* (
      token: Token,
    ) {
      const parsed = parseToken(token)
      if (parsed === undefined) return { state: "stale" as const }
      const claim = parsed
      const proof = yield* runtime.proveLocalDeath(claim.ownerID)
      // Resolution authority is exact local death proven at resolution time.
      // TTL, heartbeat age, or handle age are never evidence, and every
      // uncertainty (including a live/unknown owner or an unprovable proof)
      // leaves the acquisition blocking.
      if (proof !== "dead") return { state: "blocked" as const, proof }

      const result = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const rows = yield* tx
                .select()
                .from(DirectoryMaintenanceGuardTable)
                .where(eq(DirectoryMaintenanceGuardTable.acquisition_id, claim.acquisitionId))
                .all()
                .pipe(Effect.orDie)
              const owned = new Set(rows.map((row) => row.directory as string))
              const exact =
                rows.length === claim.directories.length &&
                claim.directories.every((directory) => owned.has(directory)) &&
                rows.every(
                  (row) =>
                    row.state === "reconcile_required" &&
                    row.guard_id === claim.guardId &&
                    row.owner_id === claim.ownerID &&
                    row.generation === claim.generation,
                )
              if (!exact) return "stale" as const

              const now = Date.now()
              const resolved = yield* tx
                .update(DirectoryMaintenanceGuardTable)
                .set({ state: "released", released_at: now, updated_at: now })
                .where(
                  and(
                    eq(DirectoryMaintenanceGuardTable.acquisition_id, claim.acquisitionId),
                    eq(DirectoryMaintenanceGuardTable.state, "reconcile_required"),
                    eq(DirectoryMaintenanceGuardTable.guard_id, claim.guardId),
                    eq(DirectoryMaintenanceGuardTable.owner_id, claim.ownerID),
                    eq(DirectoryMaintenanceGuardTable.generation, claim.generation),
                    inArray(DirectoryMaintenanceGuardTable.directory, [...claim.directories]),
                  ),
                )
                .returning({ directory: DirectoryMaintenanceGuardTable.directory })
                .all()
                .pipe(Effect.orDie)
              if (resolved.length !== claim.directories.length) {
                return yield* Effect.die(
                  "Directory maintenance guard resolution lost exact identity inside its writer transaction",
                )
              }
              return "resolved" as const
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)

      if (result === "resolved") {
        yield* dropRetention(claim.acquisitionId)
        return { state: "resolved" as const }
      }
      return { state: "stale" as const }
    })

    const reconcile = Effect.fn("DirectoryMaintenanceGuard.reconcile")(function* () {
      const rows = yield* readDb
        .select()
        .from(DirectoryMaintenanceGuardTable)
        .where(eq(DirectoryMaintenanceGuardTable.state, "active"))
        .all()
        .pipe(Effect.orDie)

      const byOwner = new Map<string, Row[]>()
      for (const row of rows) {
        const owned = byOwner.get(row.owner_id)
        if (owned) owned.push(row)
        else byOwner.set(row.owner_id, [row])
      }

      const reconciled: Array<{
        acquisitionId: AcquisitionID
        ownerID: RuntimeOwner.ID
        directories: DirectoryKey[]
      }> = []
      const blocked: Array<{
        acquisitionId: AcquisitionID
        ownerID: RuntimeOwner.ID
        proof: Exclude<RuntimeOwner.LocalDeathProof, "dead">
        directories: DirectoryKey[]
      }> = []

      for (const [ownerID, owned] of byOwner) {
        const proof = yield* runtime.proveLocalDeath(ownerID as RuntimeOwner.ID)
        if (proof !== "dead") {
          // The death proof is computed once per owner, but blocked reporting
          // stays acquisition-granular: one entry per acquisitionId with that
          // acquisition's exact directories, so several acquisitions held by
          // one alive/unknown owner are never collapsed into one aggregate.
          const byAcquisition = new Map<string, Row[]>()
          for (const row of owned) {
            const group = byAcquisition.get(row.acquisition_id)
            if (group) group.push(row)
            else byAcquisition.set(row.acquisition_id, [row])
          }
          for (const acquisitionId of [...byAcquisition.keys()].sort()) {
            blocked.push({
              acquisitionId: acquisitionId as AcquisitionID,
              ownerID: ownerID as RuntimeOwner.ID,
              proof,
              directories: byAcquisition.get(acquisitionId)!.map((row) => row.directory as DirectoryKey).sort(),
            })
          }
          continue
        }

        // IMMEDIATE transaction re-reads the dead owner's active rows, then
        // transitions each acquisition by its exact acquisitionId. A partial
        // update can never commit: count mismatches die inside the writer
        // transaction instead of splitting one acquisition's audit trail.
        const write = yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const live = yield* tx
                  .select()
                  .from(DirectoryMaintenanceGuardTable)
                  .where(
                    and(
                      eq(DirectoryMaintenanceGuardTable.owner_id, ownerID),
                      eq(DirectoryMaintenanceGuardTable.state, "active"),
                    ),
                  )
                  .all()
                  .pipe(Effect.orDie)
                const byAcquisition = new Map<string, Row[]>()
                for (const row of live) {
                  const group = byAcquisition.get(row.acquisition_id)
                  if (group) group.push(row)
                  else byAcquisition.set(row.acquisition_id, [row])
                }

                const now = Date.now()
                const result: Array<{
                  acquisitionId: AcquisitionID
                  ownerID: RuntimeOwner.ID
                  directories: DirectoryKey[]
                }> = []
                for (const acquisitionId of [...byAcquisition.keys()].sort()) {
                  const group = byAcquisition.get(acquisitionId)!
                  const updated = yield* tx
                    .update(DirectoryMaintenanceGuardTable)
                    .set({ state: "reconcile_required", updated_at: now })
                    .where(
                      and(
                        eq(DirectoryMaintenanceGuardTable.acquisition_id, acquisitionId),
                        eq(DirectoryMaintenanceGuardTable.owner_id, ownerID),
                        eq(DirectoryMaintenanceGuardTable.state, "active"),
                      ),
                    )
                    .returning({ directory: DirectoryMaintenanceGuardTable.directory })
                    .all()
                    .pipe(Effect.orDie)
                  if (updated.length !== group.length) {
                    return yield* Effect.die(
                      "Directory maintenance guard reconciliation lost exact acquisition identity",
                    )
                  }
                  result.push({
                    acquisitionId: acquisitionId as AcquisitionID,
                    ownerID: ownerID as RuntimeOwner.ID,
                    directories: updated.map((row) => row.directory as DirectoryKey).sort(),
                  })
                }
                return result
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
        reconciled.push(...write)
      }

      return { reconciled, blocked }
    })

    return Service.of({
      acquire,
      assertHealthy,
      release,
      resolveReconcileRequired,
      reconcile,
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, RuntimeOwner.node],
})
