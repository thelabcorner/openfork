export * as TurnCheckpoint from "./checkpoint"

import fs from "node:fs/promises"
import path from "path"
import { Effect, Fiber, Layer, Context, Clock, Scope, Schema, Semaphore, Schedule, Duration } from "effect"
import { and, eq, lt, desc, inArray } from "drizzle-orm"
import { randomUUID } from "crypto"
import { CodingActivity } from "@opencode-ai/core/coding-activity"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"
import { SessionCheckpointTable } from "@opencode-ai/core/session/sql"
import { Checkpoint } from "@opencode-ai/core/checkpoint"
import { define } from "@opencode-ai/schema/event"
import { Snapshot } from "@/snapshot"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { ProjectInventory } from "@opencode-ai/core/project-inventory"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import type { InstanceContext } from "@/project/instance-context"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Git } from "@/git"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type { SessionID } from "./schema"

/**
 * V1-runtime turn checkpoint wiring.
 *
 * The production turn loop lives in `packages/opencode` (SessionPrompt.runLoop)
 * and uses the V1-local `@/snapshot` service, whose shadow-repo layout is
 * identical to core's `Snapshot.Service` (same `Global.Path.data/snapshot/<project>/<worktree>`
 * gitdir and the same tree-hash space). This module bridges the V1 loop into the
 * durable `session_checkpoint` table owned by core, so the V2 HTTP API can read
 * per-turn checkpoints captured during real V1 execution.
 *
 * PERFORMANCE CONTRACT — the turn loop never waits on git:
 * - `begin()` performs only indexed SQLite reads/writes and FORKS the pre-turn
 *   tree capture (started before any tool executes, overlapping LLM streaming).
 * - `finish()` forks all heavy work (post-turn capture, diff, ref retention,
 *   final UPDATE) into a background fiber and returns immediately.
 * - `finishAborted()` implements t3 §47: a hard-interrupted turn still captures
 *   its after-state and finalizes with status `aborted` — a checkpoint is a
 *   record of reality, not an assertion that the model succeeded.
 * - A crashed finalize leaves a `capturing` row that self-heals to `error` on
 *   the session's next begin (once per process, not per turn).
 *
 * Events are defined LOCALLY (not in the schema package) so they stay out of
 * the Protocol/SDK surface — V1-only events per the schema package rules.
 */

/** Small additive payloads only — never diffs (t3 §38). */
const CheckpointEventSummary = {
  sessionID: Schema.String,
  checkpointID: Schema.String,
  ordinal: Schema.Number,
  kind: Schema.String,
  status: Schema.String,
  files: Schema.Number,
  additions: Schema.Number,
  deletions: Schema.Number,
}

export const Event = {
  Created: define({ type: "session.checkpoint.created", schema: CheckpointEventSummary }),
  Finalized: define({ type: "session.checkpoint.finalized", schema: CheckpointEventSummary }),
  Errored: define({ type: "session.checkpoint.errored", schema: CheckpointEventSummary }),
}

/**
 * Turn checkpoint handle. The pre-turn tree capture is FORKED at begin() —
 * before any tool can execute — and JOINED at finalize. The git work overlaps
 * LLM streaming instead of blocking turn start or turn completion.
 */
export interface Turn {
  readonly checkpointID: Checkpoint.ID
  readonly sessionID: SessionID
  readonly ordinal: number
  readonly beforeFiber: Fiber.Fiber<string | undefined>
  /** Last committed post-state retained while this logical row is reopened. */
  readonly previousAfterSnapshot?: string
  /**
   * True when a crashed/error checkpoint had no durable original baseline and
   * this resume had to capture the best-available current tree instead. The
   * resulting checkpoint is useful but cannot claim complete attribution.
   */
  readonly baselineRecovered?: boolean
}

export interface Interface {
  /** Insert a `capturing` row (SQLite-only, no blocking git). Returns undefined when snapshots are disabled. */
  readonly begin: (input: { sessionID: SessionID; userMessageID: string }) => Effect.Effect<Turn | undefined>
  /** Fork background finalize (status ready/partial); returns immediately. No-op for undefined turns. */
  readonly finish: (turn: Turn | undefined) => Effect.Effect<void>
  /** Finalize the session's active turn with status `aborted`, capturing after-state (t3 §47). */
  readonly finishAborted: (sessionID: SessionID) => Effect.Effect<void>
  /** CAS-mark a capturing row as error. No-op for undefined turns. */
  readonly fail: (turn: Turn | undefined, error: Checkpoint.CheckpointError) => Effect.Effect<void>
  /**
   * Record a pre-revert safety point: capture the CURRENT worktree as a ready
   * `pre-revert` checkpoint so an imminent restore stays undoable (t3 §40.2).
   * Returns undefined when snapshots are disabled.
   */
  readonly safetyPoint: (sessionID: SessionID) => Effect.Effect<{ checkpointID: Checkpoint.ID; ordinal: number; tree: string } | undefined>
  /**
   * Resolve once the session has no finalize in flight. Consumers about to
   * touch the shadow repo (tool restore preview/apply) must quiesce first —
   * otherwise their track()/read-tree can interleave with a finalize's
   * index transitions.
   */
  readonly quiesce: (sessionID: SessionID) => Effect.Effect<void>
  /**
   * Reconcile physical checkpoint retention refs against durable checkpoint
   * ownership. Production runs this as bounded background maintenance; exposed
   * here as an internal proof/test seam.
   */
  readonly reconcileRetention: () => Effect.Effect<{ readonly scanned: number; readonly released: number }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/TurnCheckpoint") {}

const STALE_MS = 60 * 60 * 1000
// Mirrors the V1 snapshot large-file rule (packages/opencode/src/snapshot: 2 MiB).
const SNAPSHOT_SIZE_LIMIT = 2 * 1024 * 1024
// Bounds the untracked-file scan for exclusion detection (background fiber only).
const MAX_EXCLUDED_REPORTED = 50
const MAX_EXCLUDED_SCANNED = 500
const RETENTION_ROOT = "refs/opencode/retained/"
const RETENTION_REF_PREFIX = `${RETENTION_ROOT}${Checkpoint.SNAPSHOT_RETENTION_PREFIX}`
const RETENTION_PAGE_SIZE = 128

// Per-process bookkeeping (cheap, bounded by open sessions):
// - healed: sessions whose stale-row sweep already ran this process
// - locks: per-session mutex serializing ordinal allocation + insert
// - active: sessionID → in-flight turn (for finishAborted on hard interrupts)
// - worktreeOwners: worktree key → owning session (contention detection, t3 §46.3)
const healed = new Set<string>()
const locks = new Map<string, Semaphore.Semaphore>()
const active = new Map<string, Turn>()
const worktreeOwners = new Map<string, string>()
// Sessions with a finalize fiber currently mutating the shadow repo.
const finalizing = new Set<string>()

const lock = (key: string) => {
  const hit = locks.get(key)
  if (hit) return hit
  const next = Semaphore.makeUnsafe(1)
  locks.set(key, next)
  return next
}

/**
 * The canonical absolute project root a turn checkpoint already holds.
 *
 * `worktree` is the instance root the checkpoint diff was captured against, so
 * it is the only directory these records may name. The `"/"` sentinel a
 * non-git instance carries names no directory and is never reported as one.
 * Nothing here consults cwd or the project display name, and stamping it is pure
 * O(1) metadata on a value already in memory — no filesystem discovery, no Git
 * call, and no per-turn cache.
 */
const checkpointRoot = (ctx: InstanceContext): string | undefined => {
  const base = ctx.worktree === "/" ? ctx.directory : ctx.worktree
  if (base.length === 0 || !path.isAbsolute(base)) return undefined
  // Same canonicalization the entity paths below use, so the folder and the
  // entities it contains always agree.
  return path.resolve(base)
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const snapshot = yield* Snapshot.Service
    const config = yield* Config.Service
    const database = yield* Database.Service
    const events = yield* EventV2Bridge.Service
    const locations = yield* LocationServiceMap.Service
    const git = yield* Git.Service
    const scope = yield* Scope.Scope
    const { db } = database

    const worktreeKey = Effect.fn("TurnCheckpoint.worktreeKey")(function* () {
      const ctx = yield* InstanceState.context
      return `${ctx.project.id}:${ctx.worktree}`
    })

    const epoch = Effect.fn("TurnCheckpoint.epoch")(function* () {
      const ctx = yield* InstanceState.context
      return Hash.fast(`${ctx.project.id}:${ctx.worktree}`)
    })

    const gitdir = Effect.fn("TurnCheckpoint.gitdir")(function* () {
      const ctx = yield* InstanceState.context
      return path.join(Global.Path.data, "snapshot", ctx.project.id, Hash.fast(ctx.worktree))
    })

    const retainTree = Effect.fn("TurnCheckpoint.retainTree")(function* (
      tree: string | undefined,
      checkpointID: Checkpoint.ID,
      slot: Checkpoint.SnapshotSlot,
    ) {
      if (!tree) return
      const ctx = yield* InstanceState.context
      const dir = path.join(Global.Path.data, "snapshot", ctx.project.id, Hash.fast(ctx.worktree))
      const ref = `refs/opencode/retained/${Checkpoint.snapshotRetentionKey(checkpointID, slot, tree)}`
      // Use the shared Git service even for the shadow repository. This keeps
      // checkpoint retention under the same deterministic EOL/process policy
      // as worktree Git and avoids direct Bun.$ calls inheriting host config.
      const commit = yield* git.run(
        [
          "-c",
          "user.name=opencode",
          "-c",
          "user.email=opencode@localhost",
          "--git-dir",
          dir,
          "commit-tree",
          tree,
          "-m",
          "checkpoint-retain",
        ],
        { cwd: ctx.worktree },
      )
      const hash = commit.exitCode === 0 ? commit.text().trim() : ""
      if (!hash) return
      yield* git.run(["--git-dir", dir, "update-ref", ref, hash], { cwd: ctx.worktree }).pipe(Effect.ignore)
    })

    const releaseTree = Effect.fn("TurnCheckpoint.releaseTree")(function* (
      tree: string | undefined,
      checkpointID: Checkpoint.ID,
      slot: Checkpoint.SnapshotSlot,
    ) {
      if (!tree) return
      const ctx = yield* InstanceState.context
      const dir = path.join(Global.Path.data, "snapshot", ctx.project.id, Hash.fast(ctx.worktree))
      const ref = `refs/opencode/retained/${Checkpoint.snapshotRetentionKey(checkpointID, slot, tree)}`
      yield* git.run(["--git-dir", dir, "update-ref", "-d", ref], { cwd: ctx.worktree }).pipe(Effect.ignore)
    })

    const reconcileRetentionFor = Effect.fn("TurnCheckpoint.reconcileRetentionFor")(function* (
      ctx: InstanceContext,
    ) {
      if ((yield* config.get()).snapshot === false) return { scanned: 0, released: 0 }
      const dir = path.join(Global.Path.data, "snapshot", ctx.project.id, Hash.fast(ctx.worktree))
      // The maintenance fiber owns this captured instance context. Derive the
      // epoch from that durable owner rather than consulting ambient InstanceRef
      // again on an hourly wakeup.
      const currentEpoch = Hash.fast(`${ctx.project.id}:${ctx.worktree}`)
      const exists = yield* Effect.tryPromise(() => fs.stat(path.join(dir, "HEAD"))).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      )
      if (!exists) return { scanned: 0, released: 0 }

      let scanned = 0
      let released = 0
      let cursor: string | undefined
      while (true) {
        const args = [
          "--git-dir",
          dir,
          "for-each-ref",
          `--count=${RETENTION_PAGE_SIZE}`,
          "--format=%(refname)",
          ...(cursor ? [`--start-after=${cursor}`] : []),
        ]
        const page = yield* git.run(args, { cwd: ctx.worktree })
        if (page.exitCode !== 0) break
        const rawRefs = page
          .text()
          .split(/\r?\n/)
          .map((value) => value.trim())
          .filter(Boolean)
        if (rawRefs.length === 0) break
        const refs = rawRefs.filter((ref) => ref.startsWith(RETENTION_REF_PREFIX))
        scanned += refs.length
        cursor = rawRefs[rawRefs.length - 1]

        const parsed = refs.map((ref) => {
          const key = ref.startsWith(RETENTION_ROOT) ? ref.slice(RETENTION_ROOT.length) : ref
          return { ref, key, parsed: Checkpoint.parseSnapshotRetentionKey(key) }
        })
        const ids = Array.from(
          new Set(parsed.flatMap((item) => (item.parsed ? [item.parsed.checkpointID] : []))),
        )
        const rows =
          ids.length === 0
            ? []
            : yield* db
                .select({
                  id: SessionCheckpointTable.id,
                  status: SessionCheckpointTable.status,
                  beforeSnapshot: SessionCheckpointTable.before_snapshot,
                  afterSnapshot: SessionCheckpointTable.after_snapshot,
                  epoch: SessionCheckpointTable.epoch,
                })
                .from(SessionCheckpointTable)
                .where(inArray(SessionCheckpointTable.id, ids))
                .all()
                .pipe(Effect.orDie)
        const byID = new Map(rows.map((row) => [row.id, row]))
        const stale = parsed.flatMap(({ ref, key, parsed }) => {
          if (!parsed) return [ref]
          return Checkpoint.ownsSnapshotRetention(byID.get(parsed.checkpointID), key, currentEpoch) ? [] : [ref]
        })
        yield* Effect.forEach(
          stale,
          (ref) =>
            git
              .run(["--git-dir", dir, "update-ref", "-d", ref], { cwd: ctx.worktree })
              .pipe(Effect.tap((result) => Effect.sync(() => {
                if (result.exitCode === 0) released++
              })), Effect.ignore),
          { concurrency: 4, discard: true },
        )
        if (rawRefs.length < RETENTION_PAGE_SIZE) break
      }
      return { scanned, released }
    })

    const reconcileRetention = Effect.fn("TurnCheckpoint.reconcileRetention")(function* () {
      return yield* reconcileRetentionFor(yield* InstanceState.context)
    })

    const retentionMaintenance = yield* InstanceState.make((ctx) =>
      Effect.gen(function* () {
        // Instance-owned maintenance: starts lazily on first checkpoint use and
        // is canceled when that project instance is disposed. Never retain an
        // InstanceRef in a global timer.
        yield* reconcileRetentionFor(ctx).pipe(
          Effect.catchCause((cause) => Effect.logWarning("checkpoint retention reconciliation failed", { cause })),
          Effect.repeat(Schedule.spaced(Duration.hours(1))),
          Effect.forkScoped,
        )
        return true
      }),
    )

    const publish = (event: (typeof Event)[keyof typeof Event], summary: {
      sessionID: string
      checkpointID: string
      ordinal: number
      kind: string
      status: string
      files: number
      additions: number
      deletions: number
    }) =>
      events.publish(event, summary).pipe(
        Effect.catch((err) => Effect.logWarning("checkpoint event publish failed", { error: String(err) })),
      )

    const waitForFinalize = Effect.fn("TurnCheckpoint.waitForFinalize")(function* (sessionID: SessionID) {
      for (let i = 0; i < 1500 && finalizing.has(sessionID); i++) {
        yield* Effect.sleep("20 millis")
      }
    })

    // Serialized per session: reconciliation + ordinal allocation + insert must
    // be atomic against a concurrent begin for a queued follow-up turn.
    const allocate = Effect.fn("TurnCheckpoint.allocate")(function* (input: {
      sessionID: SessionID
      userMessageID: string
    }) {
      const existing = yield* db
        .select()
        .from(SessionCheckpointTable)
        .where(
          and(
            eq(SessionCheckpointTable.session_id, input.sessionID),
            eq(SessionCheckpointTable.user_message_id, input.userMessageID),
          ),
        )
        .get()
        .pipe(Effect.orDie)

      if (existing) {
        const current = active.get(input.sessionID)
        if (existing.status === "capturing" && current?.checkpointID === existing.id) return current

        // A canonical worker root may legitimately re-enter after a user
        // verification/preemption cycle. The unique (session, user_message)
        // row is the logical rollback boundary, so reopen it instead of trying
        // to mint a duplicate checkpoint. Preserve the original baseline when
        // it exists; only terminal projections are reset for the new work.
        if (existing.status !== "capturing") {
          const reopened = yield* db
            .update(SessionCheckpointTable)
            .set({
              status: "capturing",
              // Keep the last successfully finalized post-state as a durable
              // recovery anchor until the replacement finalize commits. The
              // capturing status prevents callers from restoring it as current.
              assistant_message_id: null,
              diff: null,
              additions: 0,
              deletions: 0,
              files: 0,
              excluded: null,
              error: null,
              epoch_mismatch: 0,
              finalized_at: null,
            })
            .where(
              and(
                eq(SessionCheckpointTable.id, existing.id),
                eq(SessionCheckpointTable.status, existing.status),
              ),
            )
            .returning({ id: SessionCheckpointTable.id })
            .get()
            .pipe(Effect.orDie)
          if (!reopened) return yield* Effect.die(`Checkpoint ${existing.id} changed while reopening`)
        }

        const baselineRecovered = !existing.before_snapshot
        const beforeFiber = yield* (existing.before_snapshot
          ? Effect.succeed(existing.before_snapshot)
          : snapshot.track()
        ).pipe(Effect.forkIn(scope))
        return {
          checkpointID: Checkpoint.ID.make(existing.id),
          sessionID: input.sessionID,
          ordinal: existing.ordinal,
          beforeFiber,
          ...(existing.after_snapshot ? { previousAfterSnapshot: existing.after_snapshot } : {}),
          ...(baselineRecovered ? { baselineRecovered: true } : {}),
        } as Turn
      }

      // Start the pre-turn capture before any tool can execute, but do not wait
      // for Git. The fork overlaps provider/tool work exactly as before.
      const beforeFiber = yield* snapshot.track().pipe(Effect.forkIn(scope))

      const last = yield* db
        .select({ ordinal: SessionCheckpointTable.ordinal })
        .from(SessionCheckpointTable)
        .where(eq(SessionCheckpointTable.session_id, input.sessionID))
        .orderBy(desc(SessionCheckpointTable.ordinal))
        .limit(1)
        .get()
        .pipe(Effect.orDie)

      const id = Checkpoint.ID.make(randomUUID())
      const now = yield* Clock.currentTimeMillis
      const ep = yield* epoch()
      const ordinal = (last?.ordinal ?? 0) + 1
      yield* db
        .insert(SessionCheckpointTable)
        .values({
          id,
          session_id: input.sessionID,
          ordinal,
          kind: "turn",
          status: "capturing",
          // Deliberately NULL until the forked baseline capture lands (written
          // at finalize — performance contract, no blocking git on turn start).
          before_snapshot: null,
          after_snapshot: null,
          user_message_id: input.userMessageID,
          assistant_message_id: null,
          diff: null,
          additions: 0,
          deletions: 0,
          files: 0,
          excluded: null,
          error: null,
          epoch: ep,
          epoch_mismatch: 0,
          created_at: now,
          finalized_at: null,
        })
        .run()
        .pipe(Effect.orDie)

      // Fire-and-forget: created event never delays turn start.
      yield* publish(Event.Created, {
        sessionID: input.sessionID,
        checkpointID: id,
        ordinal,
        kind: "turn",
        status: "capturing",
        files: 0,
        additions: 0,
        deletions: 0,
      }).pipe(Effect.forkIn(scope))

      return { checkpointID: id, sessionID: input.sessionID, ordinal, beforeFiber } as Turn
    })

    const begin = Effect.fn("TurnCheckpoint.begin")(function* (input: {
      sessionID: SessionID
      userMessageID: string
    }) {
      if ((yield* config.get()).snapshot === false) return undefined
      // Lazy O(1) cache lookup after the first call; initialization only forks
      // bounded maintenance and never puts Git reconciliation on prompt latency.
      yield* InstanceState.get(retentionMaintenance)

      // Contention detection (t3 §46.3): v1 policy is detect-and-warn —
      // checkpoint accuracy is guaranteed only with one active mutating run
      // per worktree.
      const key = yield* worktreeKey()
      const owner = worktreeOwners.get(key)
      if (owner && owner !== input.sessionID) {
        yield* Effect.logWarning("concurrent checkpointed turns share one worktree; attribution may be imprecise", {
          worktree: key,
          ownerSession: owner,
          sessionID: input.sessionID,
        })
      }
      worktreeOwners.set(key, input.sessionID)

      // Stale-row sweep: once per session per process (crash recovery), never
      // per turn. Only rows older than STALE_MS are touched (t3 §36: never
      // clobber a legitimately in-flight capture).
      if (!healed.has(input.sessionID)) {
        healed.add(input.sessionID)
        const cutoff = (yield* Clock.currentTimeMillis) - STALE_MS
        yield* db
          .update(SessionCheckpointTable)
          .set({ status: "error", error: { code: "stuck", message: "turn never finalized" } })
          .where(
            and(
              eq(SessionCheckpointTable.session_id, input.sessionID),
              eq(SessionCheckpointTable.status, "capturing"),
              // Strictly older than the threshold.
              lt(SessionCheckpointTable.created_at, cutoff),
            ),
          )
          .run()
          .pipe(Effect.orDie)
      }

      // Serialize ordinal allocation + insert per session (in-memory mutex;
      // uncontended fast path is a Map lookup).
      // A previous logical-cycle finalize mutates the same shadow repository.
      // Wait only on that rare re-entry path; ordinary turn start remains a
      // SQLite + fork fast path and never blocks on Git.
      return yield* lock(input.sessionID).withPermits(1)(
        Effect.gen(function* () {
          // Finalization wait, row allocation/reopen, and process-local handle
          // registration are one ownership transition. Keeping active.set()
          // inside this critical section prevents a second begin from observing
          // the same capturing row before its authoritative handle is visible.
          yield* waitForFinalize(input.sessionID)
          const turn = yield* allocate(input)
          active.set(input.sessionID, turn)
          return turn
        }),
      )
    })

    /**
     * Oversized new untracked files absent from the captured tree (t3 §53).
     * Worktree-based and approximate; runs only on the background finalize
     * fiber. Read-only against the source repo — never touches the shadow index.
     */
    const detectExcluded = Effect.fn("TurnCheckpoint.detectExcluded")(function* (after: string) {
      const ctx = yield* InstanceState.context
      const dir = yield* gitdir()
      // The untracked set is a project-owned fact. Consume the canonical
      // inventory so N turns/sessions share one authoritative enumeration
      // instead of each running `git ls-files --others`. This path is
      // explicitly approximate (reporting only), so an unavailable inventory
      // falls back to a scoped Git read rather than failing the checkpoint.
      const inventory =
        ctx.project.vcs === "git" && ctx.worktree !== "/" && Watcher.hasActiveRoot(ctx.worktree)
          ? yield* Effect.gen(function* () {
              const projectInventory = yield* ProjectInventory.Service
              return yield* projectInventory.untracked()
            }).pipe(
              Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(ctx.worktree) }))),
              Effect.catch(() => Effect.succeed(undefined as readonly string[] | undefined)),
            )
          : undefined
      const others =
        inventory?.join("\0") ??
        (yield* git
          .run(["ls-files", "--others", "--exclude-standard", "-z"], { cwd: ctx.worktree })
          .pipe(Effect.map((result) => (result.exitCode === 0 ? result.text() : ""))))
      const candidates = others.split("\0").filter(Boolean)
      if (candidates.length === 0) return [] as Checkpoint.Excluded[]
      const listedResult = yield* git.run(["--git-dir", dir, "ls-tree", "-r", "--name-only", "-z", after], {
        cwd: ctx.worktree,
      })
      const listed = listedResult.exitCode === 0 ? listedResult.text() : ""
      const inTree = new Set(listed.split("\0").filter(Boolean))
      const result: Checkpoint.Excluded[] = []
      const scanned = Math.min(candidates.length, MAX_EXCLUDED_SCANNED)
      for (let i = 0; i < scanned && result.length < MAX_EXCLUDED_REPORTED; i++) {
        const rel = candidates[i]!
        if (inTree.has(rel.replaceAll("\\", "/"))) continue
        const size = yield* Effect.tryPromise(async () => (await fs.stat(path.join(ctx.worktree, rel))).size).pipe(
          Effect.catch(() => Effect.succeed(0)),
        )
        if (size > SNAPSHOT_SIZE_LIMIT) {
          result.push({ path: rel, reason: "exceeds snapshot size limit", size })
        }
      }
      return result
    })

    const quiesce = waitForFinalize

    const finalizeInner = Effect.fn("TurnCheckpoint.finalizeInner")(function* (turn: Turn, forced?: Checkpoint.Status) {
      // Join the pre-turn capture forked at begin. By quiescence it has long
      // completed, so this is instant; if the turn was very short we simply
      // wait out the remaining write-tree.
      const before = yield* Fiber.join(turn.beforeFiber)
      const after = yield* snapshot.track()

      if (!after) {
        yield* db
          .update(SessionCheckpointTable)
          .set({
            status: "error",
            error: { code: "capture", message: "post-turn snapshot failed" },
            before_snapshot: before ?? null,
          })
          .where(and(eq(SessionCheckpointTable.id, turn.checkpointID), eq(SessionCheckpointTable.status, "capturing")))
          .run()
          .pipe(Effect.orDie)
        yield* publish(Event.Errored, {
          sessionID: turn.sessionID,
          checkpointID: turn.checkpointID,
          ordinal: turn.ordinal,
          kind: "turn",
          status: "error",
          files: 0,
          additions: 0,
          deletions: 0,
        })
        return
      }

      // Checkpoint finalization owns compact durable metadata, not presentation
      // patches. Full patches are deterministically regenerable from the retained
      // immutable trees and are produced only when a caller explicitly requests
      // mode:"diff". Avoid blob reads + unified-patch synthesis on every turn.
      const diff = before
        ? yield* snapshot
            .diffSummary(before, after)
            .pipe(Effect.catch(() => Effect.succeed([] as Snapshot.FileDiff[])))
        : []

      const additions = diff.reduce((sum, f) => sum + (f.additions ?? 0), 0)
      const deletions = diff.reduce((sum, f) => sum + (f.deletions ?? 0), 0)
      const mapped = diff.map((f) => ({
        path: f.file ?? "",
        status: f.status ?? "modified",
        additions: f.additions ?? 0,
        deletions: f.deletions ?? 0,
        // Keep the persisted Revert.FileDiff shape compatible while making the
        // row a compact metadata projection. Patch bodies belong to on-demand
        // snapshot diff, not the durable checkpoint index.
        patch: "",
      }))

      const excluded = yield* detectExcluded(after).pipe(Effect.catch(() => Effect.succeed([] as Checkpoint.Excluded[])))
      // Forced status (aborted) wins; otherwise exclusions degrade to partial.
      const status = forced ?? (turn.baselineRecovered || excluded.length > 0 ? "partial" : "ready")

      // Pin both trees against GC pruning (git gc --prune=7.days). Concurrent,
      // best-effort: a failed pin only shortens how long this checkpoint stays
      // restorable, it never breaks the row.
      yield* Effect.all(
        [
          retainTree(before, turn.checkpointID, "before"),
          retainTree(after, turn.checkpointID, "after"),
        ],
        { concurrency: 2 },
      ).pipe(Effect.ignore)

      const finalizedAt = yield* Clock.currentTimeMillis
      // CAS: only the capturing owner finalizes; a fail()/reconcile race loses.
      const updated = yield* db
        .update(SessionCheckpointTable)
        .set({
          before_snapshot: before ?? null,
          after_snapshot: after,
          diff: mapped as any,
          additions,
          deletions,
          files: diff.length,
          excluded: excluded.length ? (excluded as any) : null,
          status,
          finalized_at: finalizedAt,
        })
        .where(and(eq(SessionCheckpointTable.id, turn.checkpointID), eq(SessionCheckpointTable.status, "capturing")))
        .returning({ id: SessionCheckpointTable.id })
        .get()
        .pipe(Effect.orDie)
      if (!updated) {
        // This finalize lost ownership. Do not retire a previously committed
        // owner ref; only discard the speculative new post-state when it cannot
        // be the durable row's current value.
        if (turn.previousAfterSnapshot !== after) {
          yield* releaseTree(after, turn.checkpointID, "after").pipe(Effect.ignore)
        }
        return
      }

      // Replacement is now durable. Only after the row commits may the prior
      // after-state owner ref be retired. Crash before here preserves both refs;
      // crash after the row commit but before cleanup is safe and only leaks the
      // stale owner ref until a later reconciliation.
      if (turn.previousAfterSnapshot && turn.previousAfterSnapshot !== after) {
        yield* releaseTree(turn.previousAfterSnapshot, turn.checkpointID, "after").pipe(Effect.ignore)
      }

      yield* publish(Event.Finalized, {
        sessionID: turn.sessionID,
        checkpointID: turn.checkpointID,
        ordinal: turn.ordinal,
        kind: "turn",
        status,
        files: diff.length,
        additions,
        deletions,
      })

      if (diff.length > 0) {
        const ctx = yield* InstanceState.context
        yield* Effect.gen(function* () {
          const branch = yield* git.branch(ctx.worktree)
          const project = ctx.project.name ?? (path.basename(ctx.worktree) || path.basename(ctx.directory))
          // The diff paths are worktree-relative and the entities resolve against
          // `ctx.worktree`, so that worktree is the folder this checkpoint proves.
          // `aiLineChanges` is already the signed net delta (additions minus
          // deletions), matching the edit/patch producers.
          const projectFolder = checkpointRoot(ctx)
          yield* Effect.forEach(
            mapped,
            (file) =>
              file.path
                ? CodingActivity.record({
                    entity: path.resolve(ctx.worktree, file.path),
                    kind: "write",
                    aiLineChanges: file.additions - file.deletions,
                    aiSession: turn.sessionID,
                    project,
                    ...(projectFolder === undefined ? {} : { projectFolder }),
                    branch,
                    source: "session",
                    sourceRef: turn.checkpointID,
                    replayToken: turn.checkpointID,
                  })
                : Effect.void,
            { discard: true },
          )
        }).pipe(Effect.ignore)
      }
    })

    const releaseWorktree = (sessionID: SessionID, key: string) => {
      if (worktreeOwners.get(key) === sessionID) worktreeOwners.delete(key)
    }

    const finish = Effect.fn("TurnCheckpoint.finish")(function* (turn: Turn | undefined) {
      if (!turn) return
      active.delete(turn.sessionID)
      releaseWorktree(turn.sessionID, yield* worktreeKey())
      // Performance contract: heavy work runs in a background fiber. The turn
      // result returns to the user immediately.
      // Mark finalization ownership before forking so a same-root re-entry cannot
      // slip between scheduling the finalizer and its first instruction.
      finalizing.add(turn.sessionID)
      yield* finalizeInner(turn).pipe(
        Effect.ensuring(Effect.sync(() => finalizing.delete(turn.sessionID))),
        Effect.catch((err) =>
          Effect.logWarning("turn checkpoint finalize failed", {
            "session.id": turn.sessionID,
            checkpointID: turn.checkpointID,
            error: String(err),
          }),
        ),
        Effect.forkIn(scope),
      )
    })

    const finishAborted = Effect.fn("TurnCheckpoint.finishAborted")(function* (sessionID: SessionID) {
      const turn = active.get(sessionID)
      if (!turn) return
      active.delete(sessionID)
      releaseWorktree(sessionID, yield* worktreeKey())
      // t3 §47: aborted turn + filesystem changed ⇒ capture after state,
      // status=aborted, diff remains reviewable/revertible. Forked so interrupt
      // teardown is never blocked.
      finalizing.add(sessionID)
      yield* finalizeInner(turn, "aborted").pipe(
        Effect.ensuring(Effect.sync(() => finalizing.delete(sessionID))),
        Effect.catch((err) =>
          Effect.logWarning("turn checkpoint aborted-finalize failed", {
            "session.id": sessionID,
            checkpointID: turn.checkpointID,
            error: String(err),
          }),
        ),
        Effect.forkIn(scope),
      )
    })

    const fail = Effect.fn("TurnCheckpoint.fail")(function* (turn: Turn | undefined, error: Checkpoint.CheckpointError) {
      if (!turn) return
      active.delete(turn.sessionID)
      releaseWorktree(turn.sessionID, yield* worktreeKey())
      yield* Fiber.interrupt(turn.beforeFiber).pipe(Effect.ignore)
      yield* db
        .update(SessionCheckpointTable)
        .set({ status: "error", error })
        .where(and(eq(SessionCheckpointTable.id, turn.checkpointID), eq(SessionCheckpointTable.status, "capturing")))
        .run()
        .pipe(Effect.orDie)
      yield* publish(Event.Errored, {
        sessionID: turn.sessionID,
        checkpointID: turn.checkpointID,
        ordinal: turn.ordinal,
        kind: "turn",
        status: "error",
        files: 0,
        additions: 0,
        deletions: 0,
      })
    })

    const safetyPoint = Effect.fn("TurnCheckpoint.safetyPoint")(function* (sessionID: SessionID) {
      if ((yield* config.get()).snapshot === false) return undefined
      const tree = yield* snapshot.track()
      if (!tree) return undefined
      const key = yield* worktreeKey()
      const last = yield* db
        .select({ ordinal: SessionCheckpointTable.ordinal })
        .from(SessionCheckpointTable)
        .where(eq(SessionCheckpointTable.session_id, sessionID))
        .orderBy(desc(SessionCheckpointTable.ordinal))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      const id = Checkpoint.ID.make(randomUUID())
      const ordinal = (last?.ordinal ?? 0) + 1
      const now = yield* Clock.currentTimeMillis
      yield* db
        .insert(SessionCheckpointTable)
        .values({
          id,
          session_id: sessionID,
          ordinal,
          kind: "pre-revert",
          status: "ready",
          before_snapshot: null,
          after_snapshot: tree,
          user_message_id: null,
          assistant_message_id: null,
          diff: null,
          additions: 0,
          deletions: 0,
          files: 0,
          excluded: null,
          error: null,
          epoch: yield* epoch(),
          epoch_mismatch: 0,
          created_at: now,
          finalized_at: now,
        })
        .run()
        .pipe(Effect.orDie)
      yield* retainTree(tree, id, "after").pipe(Effect.ignore)
      worktreeOwners.set(key, sessionID)
      yield* publish(Event.Finalized, {
        sessionID,
        checkpointID: id,
        ordinal,
        kind: "pre-revert",
        status: "ready",
        files: 0,
        additions: 0,
        deletions: 0,
      }).pipe(Effect.forkIn(scope))
      return { checkpointID: id, ordinal, tree }
    })

    return Service.of({ begin, finish, finishAborted, fail, safetyPoint, quiesce, reconcileRetention })
  }),
)

// Concrete fallback node for the canonical location map. Node identity is the
// service key, so the server's canonical map replaces this by name at the app
// boundary (see server.ts). Tests that compile this node directly still get a
// working (lazily-built) map.
const locationServiceMapNode = LayerNode.make({
  service: LocationServiceMap.Service,
  layer: locationServiceMapLayer,
  deps: [],
})

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Snapshot.node, Config.node, Database.node, EventV2Bridge.node, Git.node, locationServiceMapNode],
})
