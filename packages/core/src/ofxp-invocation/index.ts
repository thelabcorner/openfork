export { OfxpInvocationSchema } from "./schema"

import { and, desc, eq, gte, inArray, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { OfxpInvocationSchema } from "./schema"
import { OfxpInvocationReceiptTable } from "./sql"

export const RETENTION_MS = 24 * 60 * 60 * 1000
export const MAX_RECEIPTS = 4_096
export const RECENT_DEFAULT_LIMIT = 20
export const RECENT_MAX_LIMIT = 100
export const RECENT_BATCH_MAX_PEERS = 256
export const RECENT_BATCH_DEFAULT_PER_PEER = 5
export const RECENT_BATCH_MAX_PER_PEER = 20
const DIGEST = /^sha256:[0-9a-f]{64}$/

export interface AdmitInput {
  readonly invocationID: Ofxp.InvocationID
  readonly sourcePeerID: Ofxp.PeerID
  readonly operation: string
  readonly commitClass: Ofxp.CommitClass
  readonly requestDigest: string
  readonly targetRef?: string
  readonly resultDigest?: string
  readonly now?: number
}

export interface AdmitResult {
  readonly fresh: boolean
  readonly receipt: Ofxp.InvocationReceipt
}

export interface SettleInput {
  readonly invocationID: Ofxp.InvocationID
  readonly state: Exclude<Ofxp.ReceiptState, "admitted" | "started">
  readonly targetRef?: string
  readonly resultDigest?: string
  readonly now?: number
}

export interface PrepareInput {
  readonly invocationID: Ofxp.InvocationID
  readonly targetRef: string
  readonly resultDigest?: string
  readonly now?: number
}

export interface RecentInput {
  readonly sourcePeerID?: Ofxp.PeerID
  readonly limit?: number
  readonly now?: number
}

export interface RecentBatchInput {
  readonly sourcePeerIDs: ReadonlyArray<Ofxp.PeerID>
  readonly perPeerLimit?: number
  readonly now?: number
}

export interface RecentPeerActivity {
  readonly sourcePeerID: Ofxp.PeerID
  readonly receipts: ReadonlyArray<Ofxp.InvocationReceipt>
}

export interface Interface {
  readonly admit: (
    input: AdmitInput,
  ) => Effect.Effect<AdmitResult, OfxpInvocationSchema.CollisionError | OfxpInvocationSchema.ValidationError>
  readonly get: (
    sourcePeerID: Ofxp.PeerID,
    invocationID: Ofxp.InvocationID,
  ) => Effect.Effect<Ofxp.InvocationReceipt, OfxpInvocationSchema.NotFoundError>
  /**
   * Tier-0 bounded activity projection over the durable receipt ledger.
   * Never hydrate Sessions/workspaces or reconstruct activity from transcripts.
   */
  readonly recent: (input?: RecentInput) => Effect.Effect<ReadonlyArray<Ofxp.InvocationReceipt>>
  /**
   * Single-query Tier-0 activity projection for dense peer settings surfaces.
   * The durable ledger is globally bounded, so grouping retained rows in memory
   * is cheaper and safer than issuing one query/request per peer.
   */
  readonly recentByPeer: (input: RecentBatchInput) => Effect.Effect<ReadonlyArray<RecentPeerActivity>>
  readonly prepare: (
    input: PrepareInput,
  ) => Effect.Effect<
    Ofxp.InvocationReceipt,
    | OfxpInvocationSchema.NotFoundError
    | OfxpInvocationSchema.InvalidTransitionError
    | OfxpInvocationSchema.CollisionError
    | OfxpInvocationSchema.ValidationError
  >
  readonly settle: (
    input: SettleInput,
  ) => Effect.Effect<
    Ofxp.InvocationReceipt,
    OfxpInvocationSchema.NotFoundError | OfxpInvocationSchema.InvalidTransitionError | OfxpInvocationSchema.ValidationError
  >
}

export class Service extends Context.Service<Service, Interface>()("@opencode/core/OfxpInvocation") {}

function receipt(row: typeof OfxpInvocationReceiptTable.$inferSelect): Ofxp.InvocationReceipt {
  return {
    invocationID: row.invocation_id,
    sourcePeerID: row.source_peer_id,
    operation: row.operation,
    commitClass: row.commit_class,
    state: row.state,
    ...(row.target_ref === null ? {} : { targetRef: row.target_ref }),
    ...(row.result_digest === null ? {} : { resultDigest: row.result_digest }),
    createdAt: row.created_at,
    ...(row.settled_at === null ? {} : { settledAt: row.settled_at }),
  }
}

function validDigest(value: string | undefined) {
  return value === undefined || DIGEST.test(value)
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db, readDb } = yield* Database.Service

    const get = Effect.fn("OfxpInvocation.get")(function* (sourcePeerID: Ofxp.PeerID, invocationID: Ofxp.InvocationID) {
      const row = yield* readDb
        .select()
        .from(OfxpInvocationReceiptTable)
        .where(
          and(
            eq(OfxpInvocationReceiptTable.invocation_id, invocationID),
            eq(OfxpInvocationReceiptTable.source_peer_id, sourcePeerID),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new OfxpInvocationSchema.NotFoundError({ invocationID })
      return receipt(row)
    })

    const recent = Effect.fn("OfxpInvocation.recent")(function* (input: RecentInput = {}) {
      const now = input.now ?? Date.now()
      const requested = input.limit ?? RECENT_DEFAULT_LIMIT
      const limit = Number.isFinite(requested)
        ? Math.min(Math.max(Math.trunc(requested), 1), RECENT_MAX_LIMIT)
        : RECENT_DEFAULT_LIMIT
      const cutoff = now - RETENTION_MS
      const withinRetention = gte(OfxpInvocationReceiptTable.created_at, cutoff)
      const rows = yield* readDb
        .select()
        .from(OfxpInvocationReceiptTable)
        .where(
          input.sourcePeerID
            ? and(eq(OfxpInvocationReceiptTable.source_peer_id, input.sourcePeerID), withinRetention)
            : withinRetention,
        )
        .orderBy(desc(OfxpInvocationReceiptTable.created_at), desc(OfxpInvocationReceiptTable.invocation_id))
        .limit(limit)
        .all()
        .pipe(Effect.orDie)
      return rows.map(receipt)
    })

    const recentByPeer = Effect.fn("OfxpInvocation.recentByPeer")(function* (input: RecentBatchInput) {
      const sourcePeerIDs = [...new Set(input.sourcePeerIDs)].slice(0, RECENT_BATCH_MAX_PEERS)
      if (sourcePeerIDs.length === 0) return []
      const now = input.now ?? Date.now()
      const requested = input.perPeerLimit ?? RECENT_BATCH_DEFAULT_PER_PEER
      const perPeerLimit = Number.isFinite(requested)
        ? Math.min(Math.max(Math.trunc(requested), 1), RECENT_BATCH_MAX_PER_PEER)
        : RECENT_BATCH_DEFAULT_PER_PEER
      const rows = yield* readDb
        .select()
        .from(OfxpInvocationReceiptTable)
        .where(
          and(
            inArray(OfxpInvocationReceiptTable.source_peer_id, sourcePeerIDs),
            gte(OfxpInvocationReceiptTable.created_at, now - RETENTION_MS),
          ),
        )
        .orderBy(desc(OfxpInvocationReceiptTable.created_at), desc(OfxpInvocationReceiptTable.invocation_id))
        .limit(MAX_RECEIPTS)
        .all()
        .pipe(Effect.orDie)

      const buckets = new Map<Ofxp.PeerID, Ofxp.InvocationReceipt[]>()
      for (const row of rows) {
        const bucket = buckets.get(row.source_peer_id)
        if (bucket?.length === perPeerLimit) continue
        if (bucket) bucket.push(receipt(row))
        else buckets.set(row.source_peer_id, [receipt(row)])
      }
      return sourcePeerIDs.flatMap((sourcePeerID) => {
        const receipts = buckets.get(sourcePeerID)
        return receipts ? [{ sourcePeerID, receipts }] : []
      })
    })

    const admit = Effect.fn("OfxpInvocation.admit")(function* (input: AdmitInput) {
      const now = input.now ?? Date.now()
      const operation = input.operation.trim()
      if (!operation || operation.length > 128 || /[\x00-\x1f\x7f]/.test(operation)) {
        return yield* new OfxpInvocationSchema.ValidationError({ reason: "operation is invalid" })
      }
      if (!DIGEST.test(input.requestDigest)) {
        return yield* new OfxpInvocationSchema.ValidationError({ reason: "request digest is invalid" })
      }
      if (input.targetRef !== undefined && input.targetRef.length > 4096) {
        return yield* new OfxpInvocationSchema.ValidationError({ reason: "target reference is too large" })
      }
      if (!validDigest(input.resultDigest)) {
        return yield* new OfxpInvocationSchema.ValidationError({ reason: "result digest is invalid" })
      }

      const fresh = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.run(sql`DELETE FROM ofxp_invocation_receipt WHERE created_at < ${now - RETENTION_MS}`)
            const inserted = yield* tx
              .insert(OfxpInvocationReceiptTable)
              .values({
                invocation_id: input.invocationID,
                source_peer_id: input.sourcePeerID,
                operation,
                commit_class: input.commitClass,
                request_digest: input.requestDigest,
                state: "admitted",
                target_ref: input.targetRef ?? null,
                result_digest: input.resultDigest ?? null,
                created_at: now,
                settled_at: null,
                time_updated: now,
              })
              .onConflictDoNothing()
              .returning({ id: OfxpInvocationReceiptTable.invocation_id })
              .get()
            yield* tx.run(sql`
              DELETE FROM ofxp_invocation_receipt
              WHERE invocation_id IN (
                SELECT invocation_id
                FROM ofxp_invocation_receipt
                ORDER BY created_at DESC, invocation_id DESC
                LIMIT -1 OFFSET ${MAX_RECEIPTS}
              )
            `)
            return !!inserted
          }),
        )
        .pipe(Effect.orDie)

      const row = yield* readDb
        .select()
        .from(OfxpInvocationReceiptTable)
        .where(eq(OfxpInvocationReceiptTable.invocation_id, input.invocationID))
        .get()
        .pipe(Effect.orDie)
      if (!row) {
        return yield* new OfxpInvocationSchema.CollisionError({
          invocationID: input.invocationID,
          reason: "receipt was evicted during admission",
        })
      }
      if (
        row.source_peer_id !== input.sourcePeerID ||
        row.operation !== operation ||
        row.commit_class !== input.commitClass ||
        row.request_digest !== input.requestDigest
      ) {
        return yield* new OfxpInvocationSchema.CollisionError({
          invocationID: input.invocationID,
          reason: "the invocation ID was already bound to a different request",
        })
      }
      return { fresh, receipt: receipt(row) }
    })

    const settle = Effect.fn("OfxpInvocation.settle")(function* (input: SettleInput) {
      const now = input.now ?? Date.now()
      if (input.targetRef !== undefined && input.targetRef.length > 4096) {
        return yield* new OfxpInvocationSchema.ValidationError({ reason: "target reference is too large" })
      }
      if (!validDigest(input.resultDigest)) {
        return yield* new OfxpInvocationSchema.ValidationError({ reason: "result digest is invalid" })
      }
      const existing = yield* readDb
        .select()
        .from(OfxpInvocationReceiptTable)
        .where(eq(OfxpInvocationReceiptTable.invocation_id, input.invocationID))
        .get()
        .pipe(Effect.orDie)
      if (!existing) return yield* new OfxpInvocationSchema.NotFoundError({ invocationID: input.invocationID })
      if (existing.state !== "admitted" && existing.state !== "started" && existing.state !== input.state) {
        return yield* new OfxpInvocationSchema.InvalidTransitionError({
          invocationID: input.invocationID,
          from: existing.state,
          to: input.state,
        })
      }
      const updated = yield* db
        .update(OfxpInvocationReceiptTable)
        .set({
          state: input.state,
          target_ref: input.targetRef ?? existing.target_ref,
          result_digest: input.resultDigest ?? existing.result_digest,
          settled_at: existing.settled_at ?? now,
          time_updated: now,
        })
        .where(eq(OfxpInvocationReceiptTable.invocation_id, input.invocationID))
        .returning()
        .get()
        .pipe(Effect.orDie)
      return receipt(updated!)
    })

    const prepare = Effect.fn("OfxpInvocation.prepare")(function* (input: PrepareInput) {
      const now = input.now ?? Date.now()
      if (!input.targetRef || input.targetRef.length > 4096) {
        return yield* new OfxpInvocationSchema.ValidationError({ reason: "target reference is invalid" })
      }
      if (!validDigest(input.resultDigest)) {
        return yield* new OfxpInvocationSchema.ValidationError({ reason: "result digest is invalid" })
      }
      const existing = yield* readDb
        .select()
        .from(OfxpInvocationReceiptTable)
        .where(eq(OfxpInvocationReceiptTable.invocation_id, input.invocationID))
        .get()
        .pipe(Effect.orDie)
      if (!existing) return yield* new OfxpInvocationSchema.NotFoundError({ invocationID: input.invocationID })
      if (existing.state !== "admitted" && existing.state !== "started") {
        return yield* new OfxpInvocationSchema.InvalidTransitionError({
          invocationID: input.invocationID,
          from: existing.state,
          to: "started",
        })
      }
      if (
        (existing.target_ref !== null && existing.target_ref !== input.targetRef) ||
        (existing.result_digest !== null && existing.result_digest !== (input.resultDigest ?? existing.result_digest))
      ) {
        return yield* new OfxpInvocationSchema.CollisionError({
          invocationID: input.invocationID,
          reason: "prepared mutation target or result digest changed",
        })
      }
      const updated = yield* db
        .update(OfxpInvocationReceiptTable)
        .set({
          state: "started",
          target_ref: input.targetRef,
          result_digest: input.resultDigest ?? existing.result_digest,
          time_updated: now,
        })
        .where(eq(OfxpInvocationReceiptTable.invocation_id, input.invocationID))
        .returning()
        .get()
        .pipe(Effect.orDie)
      return receipt(updated!)
    })

    return Service.of({ admit, get, recent, recentByPeer, prepare, settle })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })

