export * as OxpActivity from "./activity"

import { and, eq, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { OxpActivity as OxpActivityContract } from "@opencode-ai/schema/oxp-activity"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { OxpActivitySchema } from "./schema"
import {
  OxpCorrelationRefTable,
  OxpInvocationLinkTable,
  OxpInvocationTable,
  OxpParentActivityTable,
} from "./sql"

const MAX_SAFE_SUMMARY_BYTES = 8 * 1024
const MAX_TOOL_BYTES = 256
const MAX_ACTION_BYTES = 256
const MAX_ROOT_ALIAS_BYTES = 64
const MAX_LINK_REF_BYTES = 512
const MAX_LINK_LABEL_BYTES = 512
const MAX_RELATION_BYTES = 128
const MAX_KNOWN_EPOCH_SEGMENTS = 4096

function bounded(value: string | undefined, max: number, label: string) {
  if (value === undefined) return
  if (!value || Buffer.byteLength(value, "utf8") > max)
    throw new Error(`Invalid OXP activity ${label}`)
  return value
}

function safeSummary(
  value: OxpActivitySchema.SafeSummary | undefined,
): OxpActivitySchema.SafeSummary | undefined {
  if (value === undefined) return
  const encoded = JSON.stringify(value)
  if (Buffer.byteLength(encoded, "utf8") > MAX_SAFE_SUMMARY_BYTES)
    throw new Error("OXP activity safe summary exceeds 8 KiB")
  return value
}

function failed(status: OxpActivitySchema.Status) {
  return status !== "success" && status !== "committed"
}

export interface BeginInput {
  readonly correlation: {
    readonly scheme: string
    readonly digest: string
    readonly scope: OxpActivitySchema.CorrelationScope
  }
  readonly hostRunID: string
  readonly observedEpoch?: number
  readonly plane: OxpActivitySchema.Plane
  readonly tool: string
  readonly action?: string
  readonly rootID?: string
  readonly rootAlias?: string
  readonly summary?: OxpActivitySchema.SafeSummary
  readonly startedAt?: number
}

export interface BeginResult {
  readonly activityID: OxpActivitySchema.ActivityID
  readonly invocationID: OxpActivitySchema.InvocationID
  readonly activityCreated: boolean
}

export interface SettleInput {
  readonly invocationID: OxpActivitySchema.InvocationID
  readonly status: Exclude<OxpActivitySchema.Status, "running">
  readonly errorCode?: string
  readonly mutationAttempted?: boolean
  readonly mutationCommitted?: boolean
  readonly summary?: OxpActivitySchema.SafeSummary
  readonly completedAt?: number
}

export interface LinkInput {
  readonly invocationID: OxpActivitySchema.InvocationID
  readonly kind: OxpActivitySchema.LinkKind
  readonly ref: string
  readonly relation: string
  readonly label?: string
}

export interface Interface {
  readonly begin: (input: BeginInput) => Effect.Effect<BeginResult>
  readonly settle: (input: SettleInput) => Effect.Effect<boolean>
  readonly link: (input: LinkInput) => Effect.Effect<void>
  /** Distinct host generations that still own running historical spans. */
  readonly runningHostRuns: () => Effect.Effect<readonly string[]>
  /** Settle only still-running spans owned by one proven-dead/gracefully-stopping host generation. */
  readonly interruptHostRun: (
    hostRunID: string,
    completedAt?: number,
  ) => Effect.Effect<number>
  readonly rename: (
    id: OxpActivitySchema.ActivityID,
    title: string | undefined,
  ) => Effect.Effect<boolean>
  readonly archive: (
    id: OxpActivitySchema.ActivityID,
    archived: boolean,
  ) => Effect.Effect<boolean>
  readonly deleteHistory: (
    id: OxpActivitySchema.ActivityID,
  ) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()(
  "@opencode/core/OxpActivity",
) {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    // Positive-only, bounded acceleration for the common case where many calls
    // land in the same observed parent-tool segment. A cache miss still proves
    // existence against SQLite, so eviction/restart/multi-process execution can
    // only add a read — never change durable counting semantics.
    const knownEpochSegments = new Set<string>()

    const epochSegmentKey = (
      activityID: OxpActivitySchema.ActivityID,
      hostRunID: string,
      observedEpoch: number,
    ) => activityID + "\\0" + hostRunID + "\\0" + observedEpoch

    const rememberEpochSegment = (key: string) => {
      if (knownEpochSegments.delete(key)) {
        knownEpochSegments.add(key)
        return
      }
      if (knownEpochSegments.size >= MAX_KNOWN_EPOCH_SEGMENTS) {
        const oldest = knownEpochSegments.values().next().value
        if (oldest !== undefined) knownEpochSegments.delete(oldest)
      }
      knownEpochSegments.add(key)
    }

    const emit = (label: string, effect: Effect.Effect<unknown>) =>
      effect.pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.logWarning("OXP activity live projection publish failed", {
            label,
            cause,
          }),
        ),
      )

    const begin = Effect.fn("OxpActivity.begin")(function* (input: BeginInput) {
      const now = input.startedAt ?? Date.now()
      const tool = bounded(input.tool, MAX_TOOL_BYTES, "tool")!
      const action = bounded(input.action, MAX_ACTION_BYTES, "action")
      const rootAlias = bounded(
        input.rootAlias,
        MAX_ROOT_ALIAS_BYTES,
        "root alias",
      )
      const summary = safeSummary(input.summary)
      bounded(input.correlation.scheme, 128, "correlation scheme")
      bounded(input.correlation.digest, 256, "correlation digest")
      bounded(input.hostRunID, 128, "host run ID")

      const result = yield* db.transaction(
        (tx) =>
          Effect.gen(function* () {
            // Existing-parent hot path: resolve the durable activity ID while
            // refreshing correlation observation metadata in one indexed write.
            // This replaces the previous SELECT + UPDATE pair without caching
            // authority in memory; a row deleted by another process simply
            // falls through to ordinary first-observation creation.
            const existing = yield* tx
              .update(OxpCorrelationRefTable)
              .set({
                last_seen_at: now,
                scope: input.correlation.scope,
              })
              .where(
                and(
                  eq(
                    OxpCorrelationRefTable.scheme,
                    input.correlation.scheme,
                  ),
                  eq(
                    OxpCorrelationRefTable.digest,
                    input.correlation.digest,
                  ),
                ),
              )
              .returning({ activityID: OxpCorrelationRefTable.activity_id })
              .get()
              .pipe(Effect.orDie)

            const activityID =
              existing?.activityID ?? OxpActivitySchema.nextActivityID()
            const activityCreated = existing === undefined

            if (!existing) {
              yield* tx
                .insert(OxpParentActivityTable)
                .values({
                  id: activityID,
                  first_seen_at: now,
                  last_seen_at: now,
                })
                .run()
                .pipe(Effect.orDie)
              yield* tx
                .insert(OxpCorrelationRefTable)
                .values({
                  scheme: input.correlation.scheme,
                  digest: input.correlation.digest,
                  activity_id: activityID,
                  scope: input.correlation.scope,
                  first_seen_at: now,
                  last_seen_at: now,
                })
                .run()
                .pipe(Effect.orDie)
            }

            const segmentKey =
              input.observedEpoch === undefined
                ? undefined
                : epochSegmentKey(
                    activityID,
                    input.hostRunID,
                    input.observedEpoch,
                  )
            const observedEpochIsNew =
              segmentKey === undefined
                ? false
                : activityCreated
                  ? true
                  : knownEpochSegments.has(segmentKey)
                    ? false
                    : (yield* tx
                        .select({ id: OxpInvocationTable.id })
                        .from(OxpInvocationTable)
                        .where(
                          and(
                            eq(OxpInvocationTable.activity_id, activityID),
                            eq(OxpInvocationTable.host_run_id, input.hostRunID),
                            eq(
                              OxpInvocationTable.observed_epoch,
                              input.observedEpoch!,
                            ),
                          ),
                        )
                        .limit(1)
                        .get()
                        .pipe(Effect.orDie)) === undefined

            const invocationID = OxpActivitySchema.nextInvocationID()
            yield* tx
              .insert(OxpInvocationTable)
              .values({
                id: invocationID,
                activity_id: activityID,
                host_run_id: input.hostRunID,
                observed_epoch: input.observedEpoch,
                plane: input.plane,
                tool,
                action,
                root_id: input.rootID,
                root_alias: rootAlias,
                safe_summary: summary,
                time_started: now,
              })
              .run()
              .pipe(Effect.orDie)

            yield* tx
              .update(OxpParentActivityTable)
              .set({
                last_seen_at: now,
                last_tool: tool,
                last_root_alias: rootAlias,
                call_count: sql`${OxpParentActivityTable.call_count} + 1`,
                augmentation_calls:
                  input.plane === "augmentation"
                    ? sql`${OxpParentActivityTable.augmentation_calls} + 1`
                    : OxpParentActivityTable.augmentation_calls,
                supervision_calls:
                  input.plane === "supervision"
                    ? sql`${OxpParentActivityTable.supervision_calls} + 1`
                    : OxpParentActivityTable.supervision_calls,
                delegation_calls:
                  input.plane === "delegation"
                    ? sql`${OxpParentActivityTable.delegation_calls} + 1`
                    : OxpParentActivityTable.delegation_calls,
                observed_epoch_count:
                  observedEpochIsNew
                    ? sql`${OxpParentActivityTable.observed_epoch_count} + 1`
                    : OxpParentActivityTable.observed_epoch_count,
              })
              .where(eq(OxpParentActivityTable.id, activityID))
              .run()
              .pipe(Effect.orDie)

            return {
              activityID,
              invocationID,
              activityCreated,
            } satisfies BeginResult
          }),
        { behavior: "immediate" },
      ).pipe(Effect.orDie)
      if (input.observedEpoch !== undefined) {
        rememberEpochSegment(
          epochSegmentKey(
            result.activityID,
            input.hostRunID,
            input.observedEpoch,
          ),
        )
      }
      if (result.activityCreated) {
        yield* emit(
          "created",
          events.publish(OxpActivityContract.Event.Created, {
            activityID: result.activityID,
          }),
        )
      } else {
        yield* emit(
          "updated",
          events.publish(OxpActivityContract.Event.Updated, {
            activityID: result.activityID,
          }),
        )
      }
      yield* emit(
        "invocation.started",
        events.publish(OxpActivityContract.Event.InvocationStarted, {
          activityID: result.activityID,
          invocationID: result.invocationID,
        }),
      )
      return result
    })

    const settle = Effect.fn("OxpActivity.settle")(function* (
      input: SettleInput,
    ) {
      const completedAt = input.completedAt ?? Date.now()
      const summary = safeSummary(input.summary)
      bounded(input.errorCode, 128, "error code")
      const settled = yield* db.transaction(
        (tx) =>
          Effect.gen(function* () {
            const row = yield* tx
              .select()
              .from(OxpInvocationTable)
              .where(eq(OxpInvocationTable.id, input.invocationID))
              .get()
              .pipe(Effect.orDie)
            if (!row || row.status !== "running") return undefined

            yield* tx
              .update(OxpInvocationTable)
              .set({
                status: input.status,
                error_code: input.errorCode,
                mutation_attempted: input.mutationAttempted ?? false,
                mutation_committed: input.mutationCommitted ?? false,
                ...(summary === undefined ? {} : { safe_summary: summary }),
                time_completed: completedAt,
              })
              .where(eq(OxpInvocationTable.id, input.invocationID))
              .run()
              .pipe(Effect.orDie)

            if (failed(input.status)) {
              yield* tx
                .update(OxpParentActivityTable)
                .set({
                  failure_count: sql`${OxpParentActivityTable.failure_count} + 1`,
                  last_seen_at: sql`MAX(${OxpParentActivityTable.last_seen_at}, ${completedAt})`,
                })
                .where(eq(OxpParentActivityTable.id, row.activity_id))
                .run()
                .pipe(Effect.orDie)
            } else {
              yield* tx
                .update(OxpParentActivityTable)
                .set({
                  last_seen_at: sql`MAX(${OxpParentActivityTable.last_seen_at}, ${completedAt})`,
                })
                .where(eq(OxpParentActivityTable.id, row.activity_id))
                .run()
                .pipe(Effect.orDie)
            }
            return row.activity_id
          }),
        { behavior: "immediate" },
      ).pipe(Effect.orDie)
      if (!settled) return false
      yield* emit(
        "updated",
        events.publish(OxpActivityContract.Event.Updated, {
          activityID: settled,
        }),
      )
      yield* emit(
        "invocation.settled",
        events.publish(OxpActivityContract.Event.InvocationSettled, {
          activityID: settled,
          invocationID: input.invocationID,
        }),
      )
      return true
    })

    const link = Effect.fn("OxpActivity.link")(function* (input: LinkInput) {
      const inserted = yield* db
        .insert(OxpInvocationLinkTable)
        .values({
          invocation_id: input.invocationID,
          kind: input.kind,
          ref: bounded(input.ref, MAX_LINK_REF_BYTES, "link ref")!,
          relation: bounded(
            input.relation,
            MAX_RELATION_BYTES,
            "link relation",
          )!,
          label: bounded(input.label, MAX_LINK_LABEL_BYTES, "link label"),
        })
        .onConflictDoNothing()
        .returning({ invocationID: OxpInvocationLinkTable.invocation_id })
        .get()
        .pipe(Effect.orDie)
      if (!inserted) return
      const row = yield* db
        .select({ activityID: OxpInvocationTable.activity_id })
        .from(OxpInvocationTable)
        .where(eq(OxpInvocationTable.id, input.invocationID))
        .get()
        .pipe(Effect.orDie)
      if (row) {
        yield* emit(
          "link.added",
          events.publish(OxpActivityContract.Event.LinkAdded, {
            activityID: row.activityID,
            invocationID: input.invocationID,
          }),
        )
      }
    })

    const runningHostRuns = Effect.fn("OxpActivity.runningHostRuns")(
      function* () {
        const rows = yield* db
          .selectDistinct({ hostRunID: OxpInvocationTable.host_run_id })
          .from(OxpInvocationTable)
          .where(eq(OxpInvocationTable.status, "running"))
          .all()
          .pipe(Effect.orDie)
        return rows.map((row) => row.hostRunID)
      },
    )

    const interruptHostRun = Effect.fn("OxpActivity.interruptHostRun")(
      function* (hostRunID: string, completedAt = Date.now()) {
        bounded(hostRunID, 128, "host run ID")
        const interrupted = yield* db.transaction(
          (tx) =>
            Effect.gen(function* () {
              const rows = yield* tx
                .select({
                  id: OxpInvocationTable.id,
                  activityID: OxpInvocationTable.activity_id,
                })
                .from(OxpInvocationTable)
                .where(
                  and(
                    eq(OxpInvocationTable.host_run_id, hostRunID),
                    eq(OxpInvocationTable.status, "running"),
                  ),
                )
                .all()
                .pipe(Effect.orDie)
              if (rows.length === 0) return rows

              yield* tx
                .update(OxpInvocationTable)
                .set({
                  status: "interrupted",
                  error_code: "OXP_HOST_INTERRUPTED",
                  time_completed: completedAt,
                })
                .where(
                  and(
                    eq(OxpInvocationTable.host_run_id, hostRunID),
                    eq(OxpInvocationTable.status, "running"),
                  ),
                )
                .run()
                .pipe(Effect.orDie)

              const counts = new Map<OxpActivitySchema.ActivityID, number>()
              for (const row of rows)
                counts.set(row.activityID, (counts.get(row.activityID) ?? 0) + 1)
              for (const [activityID, count] of counts) {
                yield* tx
                  .update(OxpParentActivityTable)
                  .set({
                    failure_count: sql`${OxpParentActivityTable.failure_count} + ${count}`,
                    last_seen_at: sql`MAX(${OxpParentActivityTable.last_seen_at}, ${completedAt})`,
                  })
                  .where(eq(OxpParentActivityTable.id, activityID))
                  .run()
                  .pipe(Effect.orDie)
              }
              return rows
            }),
          { behavior: "immediate" },
        ).pipe(Effect.orDie)

        const activities = new Set<OxpActivitySchema.ActivityID>()
        for (const row of interrupted) {
          activities.add(row.activityID)
          yield* emit(
            "invocation.interrupted",
            events.publish(OxpActivityContract.Event.InvocationSettled, {
              activityID: row.activityID,
              invocationID: row.id,
            }),
          )
        }
        for (const activityID of activities) {
          yield* emit(
            "updated",
            events.publish(OxpActivityContract.Event.Updated, { activityID }),
          )
        }
        return interrupted.length
      },
    )

    const rename = Effect.fn("OxpActivity.rename")(function* (
      id: OxpActivitySchema.ActivityID,
      title: string | undefined,
    ) {
      const next =
        title === undefined
          ? null
          : bounded(title.trim(), 256, "title") ?? null
      const changed = yield* db.transaction(
        (tx) =>
          Effect.gen(function* () {
            const row = yield* tx
              .select({ id: OxpParentActivityTable.id })
              .from(OxpParentActivityTable)
              .where(eq(OxpParentActivityTable.id, id))
              .get()
              .pipe(Effect.orDie)
            if (!row) return false
            yield* tx
              .update(OxpParentActivityTable)
              .set({ title: next })
              .where(eq(OxpParentActivityTable.id, id))
              .run()
              .pipe(Effect.orDie)
            return true
          }),
        { behavior: "immediate" },
      ).pipe(Effect.orDie)
      if (changed) {
        yield* emit(
          "renamed",
          events.publish(OxpActivityContract.Event.Updated, { activityID: id }),
        )
      }
      return changed
    })

    const archive = Effect.fn("OxpActivity.archive")(function* (
      id: OxpActivitySchema.ActivityID,
      archived: boolean,
    ) {
      const changed = yield* db.transaction(
        (tx) =>
          Effect.gen(function* () {
            const row = yield* tx
              .select({ id: OxpParentActivityTable.id })
              .from(OxpParentActivityTable)
              .where(eq(OxpParentActivityTable.id, id))
              .get()
              .pipe(Effect.orDie)
            if (!row) return false
            yield* tx
              .update(OxpParentActivityTable)
              .set({ time_archived: archived ? Date.now() : null })
              .where(eq(OxpParentActivityTable.id, id))
              .run()
              .pipe(Effect.orDie)
            return true
          }),
        { behavior: "immediate" },
      ).pipe(Effect.orDie)
      if (changed) {
        yield* emit(
          "archived",
          events.publish(OxpActivityContract.Event.Updated, { activityID: id }),
        )
      }
      return changed
    })

    const deleteHistory = Effect.fn("OxpActivity.deleteHistory")(function* (
      id: OxpActivitySchema.ActivityID,
    ) {
      const deleted = yield* db.transaction(
        (tx) =>
          Effect.gen(function* () {
            const row = yield* tx
              .select({ id: OxpParentActivityTable.id })
              .from(OxpParentActivityTable)
              .where(eq(OxpParentActivityTable.id, id))
              .get()
              .pipe(Effect.orDie)
            if (!row) return false
            yield* tx
              .delete(OxpParentActivityTable)
              .where(eq(OxpParentActivityTable.id, id))
              .run()
              .pipe(Effect.orDie)
            return true
          }),
        { behavior: "immediate" },
      ).pipe(Effect.orDie)
      if (deleted) {
        yield* emit(
          "removed",
          events.publish(OxpActivityContract.Event.Removed, { activityID: id }),
        )
      }
      return deleted
    })

    return Service.of({
      begin,
      settle,
      link,
      runningHostRuns,
      interruptHostRun,
      rename,
      archive,
      deleteHistory,
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node],
})

