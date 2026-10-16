export * as SessionAttachment from "./attachment"

import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm"
import { DateTime, Effect } from "effect"
import { createHash } from "node:crypto"
import { SessionAttachment as Contract } from "@opencode-ai/schema/session-attachment"
import { SessionID } from "@opencode-ai/schema/session-id"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { Database } from "../database/database"
import {
  SessionAttachmentBlobTable,
  SessionAttachmentGrantTable,
  SessionAttachmentStatusTable,
  SessionAttachmentTable,
} from "./attachment.sql"

type DB = Database.Interface["db"]
/** The transaction callback handle; nested helpers must accept exactly this. */
type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0]

/**
 * Canonical durable owner for user-uploaded attachments and their handoff grants.
 *
 * Ownership rules enforced here (never in a UI or a per-feature caller):
 *
 * - bytes live in an immutable, content-addressed blob and are deduplicated by
 *   hash **without** merging access rights;
 * - an upload is a logical identity owned by one parent Session turn/part and
 *   carries a server-stamped origin (only `user-upload` is handoff-eligible);
 * - a grant is one immutable edge for one exact recipient identity, keyed by an
 *   idempotency identity so retries never duplicate bytes or edges;
 * - every read re-checks live source ownership **and** an active grant;
 * - asset revocation cascades to descendant grants; unlinking/deleting a parent
 *   Session is not itself source revocation.
 *
 * This module deliberately depends on `Database` only. It is callable from the
 * V1 admission path and from Tier-3 child execution without bootstrapping a
 * workspace `Instance`.
 */

// ---------------------------------------------------------------------------
// Policy (bounded defaults; the plan's open decisions are centralized here)
// ---------------------------------------------------------------------------

export const Policy = {
  /** Eligible MIME allowlist. Extend only from measured provider limits. */
  eligibleMimes: new Set<string>([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "application/pdf",
    "text/plain",
  ]),
  maxPerFileBytes: 10 * 1024 * 1024,
  maxAggregateBytes: 32 * 1024 * 1024,
  maxPerSelection: 16,
  /** Grant metadata is retained while the child is resumable; bytes follow retention. */
  grantRetentionMs: 7 * 24 * 60 * 60 * 1000,
} as const

export type SelectableOrigin = Contract.Origin

/** Only a semantic user upload is ever eligible for handoff. */
export function isEligibleOrigin(origin: Contract.Origin): boolean {
  return origin === "user-upload"
}

export function classifyMime(mime: string): Contract.Eligibility {
  return Policy.eligibleMimes.has(mime) ? "eligible" : "unsupported-mime"
}

// ---------------------------------------------------------------------------
// Registration (trusted admission boundary)
// ---------------------------------------------------------------------------

export type RegisterUploadInput = {
  readonly sessionID: string
  readonly messageID: string
  readonly partID: string
  readonly origin: Contract.Origin
  readonly mime: string
  readonly filename?: string
  readonly bytes: Uint8Array
  readonly now?: number
}

/**
 * Register one user upload at the trusted V1 admission boundary.
 *
 * Deterministic per source part: re-admitting the exact same part is idempotent
 * and returns the existing logical upload. Bytes are content-addressed, so two
 * uploads with equal content share one blob row while retaining distinct
 * ownership, filenames, handles, and grants.
 */
export const registerUpload = Effect.fn("SessionAttachment.registerUpload")(function* (
  db: DB,
  input: RegisterUploadInput,
) {
  const now = input.now ?? Date.now()
  const byteLength = input.bytes.byteLength
  const contentHash = createHash("sha256").update(input.bytes).digest("hex")

  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const existing = yield* tx
          .select()
          .from(SessionAttachmentTable)
          .where(
            and(
              eq(SessionAttachmentTable.session_id, input.sessionID as never),
              eq(SessionAttachmentTable.message_id, input.messageID as never),
              eq(SessionAttachmentTable.part_id, input.partID),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        if (existing) return decodeUpload(existing)

        const blob =
          (yield* tx
            .select()
            .from(SessionAttachmentBlobTable)
            .where(eq(SessionAttachmentBlobTable.content_hash, contentHash))
            .get()
            .pipe(Effect.orDie)) ??
          (yield* tx
            .insert(SessionAttachmentBlobTable)
            .values({
              id: Contract.BlobID.create(),
              content_hash: contentHash,
              mime: input.mime,
              byte_length: byteLength,
              bytes: Buffer.from(input.bytes).toString("base64"),
              time_created: now,
            })
            .returning()
            .get()
            .pipe(Effect.orDie))

        const id = Contract.ID.create()
        const handle = yield* nextHandle(tx, input.sessionID)
        const row = yield* tx
          .insert(SessionAttachmentTable)
          .values({
            id,
            session_id: input.sessionID as never,
            message_id: input.messageID as never,
            part_id: input.partID,
            blob_id: blob.id,
            origin: input.origin,
            filename: input.filename ?? null,
            mime: input.mime,
            byte_length: byteLength,
            handle,
            time_created: now,
          })
          .returning()
          .get()
          .pipe(Effect.orDie)
        return decodeUpload(row)
      }),
    { behavior: "immediate" },
  )
})

/**
 * Allocate the next stable, human-readable symbolic handle for a Session.
 * Handles are per-session, monotonic, and never reused, so a compact manifest
 * can present `upload-N` without exposing opaque storage IDs.
 */
function nextHandle(tx: Tx, sessionID: string) {
  return Effect.gen(function* () {
    const row = yield* tx
      .select({ max: sql<number>`max(cast(substr(${SessionAttachmentTable.handle}, 8) as integer))` })
      .from(SessionAttachmentTable)
      .where(eq(SessionAttachmentTable.session_id, sessionID as never))
      .get()
      .pipe(Effect.orDie)
    const next = (row?.max ?? 0) + 1
    return Contract.Handle.make(`upload-${next}`)
  })
}

function decodeUpload(row: typeof SessionAttachmentTable.$inferSelect) {
  return {
    id: row.id,
    sessionID: row.session_id,
    messageID: row.message_id,
    partID: row.part_id,
    blobID: row.blob_id,
    origin: row.origin,
    filename: row.filename ?? undefined,
    mime: row.mime,
    byteLength: row.byte_length,
    handle: row.handle,
    tombstonedAt: row.tombstoned_at ?? undefined,
    timeCreated: row.time_created,
  }
}

export type Upload = ReturnType<typeof decodeUpload>

// ---------------------------------------------------------------------------
// Discovery (bounded; never scans transcript history)
// ---------------------------------------------------------------------------

/**
 * Uploads owned by one exact user turn. This is the only "current turn"
 * discovery path; it reads the durable upload index, never message history.
 */
export function currentTurnUploads(db: DB, sessionID: string, messageID: string) {
  return db
    .select()
    .from(SessionAttachmentTable)
    .where(
      and(
        eq(SessionAttachmentTable.session_id, sessionID as never),
        eq(SessionAttachmentTable.message_id, messageID as never),
        isNull(SessionAttachmentTable.tombstoned_at),
      ),
    )
    .orderBy(asc(SessionAttachmentTable.time_created), asc(SessionAttachmentTable.id))
    .all()
    .pipe(
      Effect.map((rows) => rows.map(decodeUpload)),
      Effect.orDie,
    )
}

export type IndexQuery = {
  readonly sessionID: string
  readonly cursor?: string
  readonly limit?: number
}

/**
 * Explicit paginated index of a Session's eligible uploads. O(k) in the
 * requested page and independent of transcript length. This is the only
 * previous-asset discovery path after compaction.
 */
export const indexPage = Effect.fn("SessionAttachment.indexPage")(function* (db: DB, input: IndexQuery) {
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 100)
  const cursorRow = input.cursor
    ? yield* db
        .select({ time: SessionAttachmentTable.time_created, id: SessionAttachmentTable.id })
        .from(SessionAttachmentTable)
        .where(eq(SessionAttachmentTable.id, input.cursor as never))
        .get()
        .pipe(Effect.orDie)
    : undefined
  const rows = yield* db
    .select()
    .from(SessionAttachmentTable)
    .where(
      and(
        eq(SessionAttachmentTable.session_id, input.sessionID as never),
        isNull(SessionAttachmentTable.tombstoned_at),
        eq(SessionAttachmentTable.origin, "user-upload"),
        cursorRow
          ? or(
              lt(SessionAttachmentTable.time_created, cursorRow.time),
              and(eq(SessionAttachmentTable.time_created, cursorRow.time), lt(SessionAttachmentTable.id, cursorRow.id)),
            )
          : undefined,
      ),
    )
    // Newest first: a request for older uploads starts at the most recent page.
    .orderBy(desc(SessionAttachmentTable.time_created), desc(SessionAttachmentTable.id))
    .limit(limit + 1)
    .all()
    .pipe(Effect.orDie)
  const page = rows.slice(0, limit)
  const nextCursor = rows.length > limit ? page[page.length - 1]?.id : undefined
  return {
    sessionID: input.sessionID as unknown as SessionID,
    items: page.map((row) => indexEntry(decodeUpload(row))),
    ...(nextCursor ? { nextCursor } : {}),
  } satisfies Contract.IndexPage
})

function indexEntry(upload: Upload): Contract.IndexEntry {
  return {
    handle: upload.handle,
    id: upload.id,
    ...(upload.filename ? { filename: upload.filename } : {}),
    mime: upload.mime,
    byteLength: upload.byteLength,
    eligibility: classifyMime(upload.mime),
    sourceMessageID: upload.messageID,
    sourcePartID: upload.partID,
    timeCreated: DateTime.makeUnsafe(upload.timeCreated),
  }
}

// ---------------------------------------------------------------------------
// Selection validation
// ---------------------------------------------------------------------------

export type SelectionScope =
  | { readonly kind: "current-turn"; readonly sessionID: string; readonly messageID: string }
  | { readonly kind: "index"; readonly sessionID: string }
  | { readonly kind: "active-grant"; readonly sessionID: string; readonly workerSessionID: string }

export type SelectedUpload = {
  readonly upload: Upload
  readonly sourceMessageID: string
  readonly sourcePartID: string
}

/**
 * Resolve symbolic handles to uploads, but only when each handle is authorized
 * for this caller. A handle resolves if and only if its upload belongs to the
 * exact triggering user turn, was returned by an explicit index lookup, or is
 * already covered by an active grant held by this worker. No filename match,
 * content hash, sibling session, or ancestor traversal can disclose an upload.
 */
export const resolveSelection = Effect.fn("SessionAttachment.resolveSelection")(function* (
  db: DB,
  input: { readonly handles: ReadonlyArray<string>; readonly scope: SelectionScope },
) {
  if (input.handles.length === 0) return [] as SelectedUpload[]
  const deduped = [...new Set(input.handles)]
  const uploads = yield* db
    .select()
    .from(SessionAttachmentTable)
    .where(
      and(
        eq(SessionAttachmentTable.session_id, input.scope.sessionID as never),
        inArray(SessionAttachmentTable.handle, deduped as never),
      ),
    )
    .all()
    .pipe(Effect.orDie)

  const allowed = new Map<string, SelectedUpload>()
  if (input.scope.kind === "current-turn") {
    for (const row of uploads) {
      if (row.tombstoned_at) continue
      if (row.message_id === input.scope.messageID) {
        allowed.set(row.handle, { upload: decodeUpload(row), sourceMessageID: row.message_id, sourcePartID: row.part_id })
      }
    }
  } else if (input.scope.kind === "index") {
    for (const row of uploads) {
      if (row.tombstoned_at || row.origin !== "user-upload") continue
      allowed.set(row.handle, { upload: decodeUpload(row), sourceMessageID: row.message_id, sourcePartID: row.part_id })
    }
  } else {
    const grantRows = yield* db
      .select()
      .from(SessionAttachmentGrantTable)
      .where(
        and(
          or(
            eq(SessionAttachmentGrantTable.target_child_session_id, input.scope.workerSessionID as never),
            eq(SessionAttachmentGrantTable.target_member_session_id, input.scope.workerSessionID as never),
          ),
          eq(SessionAttachmentGrantTable.state, "active"),
        ),
      )
      .all()
      .pipe(Effect.orDie)
    const grantedAttachmentIds = new Set(grantRows.map((grant) => grant.attachment_id))
    for (const row of uploads) {
      if (row.tombstoned_at) continue
      if (grantedAttachmentIds.has(row.id)) {
        allowed.set(row.handle, { upload: decodeUpload(row), sourceMessageID: row.message_id, sourcePartID: row.part_id })
      }
    }
  }

  return deduped.map((handle) => allowed.get(handle)).filter((value): value is SelectedUpload => value !== undefined)
})

// ---------------------------------------------------------------------------
// Grant lifecycle
// ---------------------------------------------------------------------------

export type CreateGrantInput = {
  readonly attachment: SelectedUpload
  readonly target: Contract.GrantTarget
  readonly idempotencyKey: string
  readonly parentGrantID?: Contract.GrantID
  readonly now?: number
}

function targetColumns(target: Contract.GrantTarget) {
  return target.kind === "task"
    ? {
        target_kind: "task" as const,
        target_child_session_id: target.childSessionID,
        target_tool_call_id: target.toolCallID,
        target_tool_part_id: target.toolPartID,
        target_assistant_message_id: target.assistantMessageID,
      }
    : {
        target_kind: "swarm" as const,
        target_task_id: target.taskID,
        target_run_id: target.runID,
        target_session_input_id: target.sessionInputID,
        target_member_session_id: target.memberSessionID,
      }
}

/**
 * Create (or reuse) one immutable grant edge for an exact recipient identity.
 *
 * Idempotent on `idempotencyKey`: a retry with the same delegation invocation or
 * task-run/admission identity returns the existing grant and never duplicates
 * bytes or edges. Access is never widened by this call: the attachment must have
 * been authorized for this caller's selection scope first.
 */
export const createGrant = Effect.fn("SessionAttachment.createGrant")(function* (
  db: DB,
  input: CreateGrantInput,
) {
  const now = input.now ?? Date.now()
  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const existing = yield* tx
          .select()
          .from(SessionAttachmentGrantTable)
          .where(eq(SessionAttachmentGrantTable.idempotency_key, input.idempotencyKey))
          .get()
          .pipe(Effect.orDie)
        if (existing) return decodeGrant(existing)

        const id = Contract.GrantID.create()
        const row = yield* tx
          .insert(SessionAttachmentGrantTable)
          .values({
            id,
            attachment_id: input.attachment.upload.id,
            source_session_id: input.attachment.upload.sessionID as never,
            source_message_id: input.attachment.sourceMessageID as never,
            source_part_id: input.attachment.sourcePartID,
            ...targetColumns(input.target),
            state: "active",
            idempotency_key: input.idempotencyKey,
            parent_grant_id: input.parentGrantID ?? null,
            time_created: now,
          })
          .returning()
          .get()
          .pipe(Effect.orDie)
        yield* tx
          .insert(SessionAttachmentStatusTable)
          .values({ grant_id: id, selected: true, authorized: true, time_updated: now })
          .onConflictDoNothing()
          .pipe(Effect.orDie)
        return decodeGrant(row)
      }),
    { behavior: "immediate" },
  )
})

function decodeGrant(row: typeof SessionAttachmentGrantTable.$inferSelect) {
  return {
    id: row.id,
    attachmentID: row.attachment_id,
    sourceSessionID: row.source_session_id as unknown as SessionID,
    sourceMessageID: row.source_message_id,
    sourcePartID: row.source_part_id,
    targetKind: row.target_kind,
    targetChildSessionID: row.target_child_session_id ?? undefined,
    targetRunID: row.target_run_id ?? undefined,
    targetMemberSessionID: row.target_member_session_id ?? undefined,
    state: row.state,
    reason: row.reason ?? undefined,
    idempotencyKey: row.idempotency_key,
    parentGrantID: row.parent_grant_id ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    timeCreated: row.time_created,
  }
}

export type Grant = ReturnType<typeof decodeGrant>

/**
 * Re-check a grant is live at read/dispatch time. A revoked, expired, or
 * tombstoned grant (or tombstoned upload) fails closed with an explicit reason.
 */
export const checkGrant = Effect.fn("SessionAttachment.checkGrant")(function* (
  db: DB,
  grantID: Contract.GrantID,
  now: number = Date.now(),
) {
  const grant = yield* db
    .select()
    .from(SessionAttachmentGrantTable)
    .where(eq(SessionAttachmentGrantTable.id, grantID))
    .get()
    .pipe(Effect.orDie)
  if (!grant) return { ok: false as const, reason: "no-active-grant" as Contract.RejectionReason }
  if (grant.state === "revoked") return { ok: false as const, reason: "revoked" as Contract.RejectionReason }
  if (grant.state === "tombstoned") return { ok: false as const, reason: "tombstoned" as Contract.RejectionReason }
  if (grant.state === "expired" || (grant.expires_at !== null && grant.expires_at <= now)) {
    return { ok: false as const, reason: "expired" as Contract.RejectionReason }
  }
  const upload = yield* db
    .select({ tombstoned: SessionAttachmentTable.tombstoned_at, origin: SessionAttachmentTable.origin })
    .from(SessionAttachmentTable)
    .where(eq(SessionAttachmentTable.id, grant.attachment_id))
    .get()
    .pipe(Effect.orDie)
  if (!upload) return { ok: false as const, reason: "tombstoned" as Contract.RejectionReason }
  if (upload.tombstoned !== null) return { ok: false as const, reason: "tombstoned" as Contract.RejectionReason }
  if (!isEligibleOrigin(upload.origin)) return { ok: false as const, reason: "unsupported-origin" as Contract.RejectionReason }
  return { ok: true as const, grant: decodeGrant(grant) }
})

/** Revoke one grant and every descendant grant; transcript order never matters. */
export const revokeGrant = Effect.fn("SessionAttachment.revokeGrant")(function* (
  db: DB,
  grantID: Contract.GrantID,
  reason: string,
  now: number = Date.now(),
) {
  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const revoked = yield* cascadeRevoke(tx, grantID, reason, now)
        return revoked
      }),
    { behavior: "immediate" },
  )
})

function cascadeRevoke(tx: Tx, root: Contract.GrantID, reason: string, now: number) {
  return Effect.gen(function* () {
    const ids = [root]
    const seen = new Set<string>(ids)
    // Breadth-first descendant revocation. Bounded by the number of descendant
    // grants, which is bounded by the delegation fan-out.
    while (ids.length > 0) {
      const frontier = ids.splice(0, ids.length)
      const children = yield* tx
        .select({ id: SessionAttachmentGrantTable.id })
        .from(SessionAttachmentGrantTable)
        .where(inArray(SessionAttachmentGrantTable.parent_grant_id, frontier as never))
        .all()
        .pipe(Effect.orDie)
      for (const child of children) {
        if (seen.has(child.id)) continue
        seen.add(child.id)
        ids.push(child.id)
      }
    }
    yield* tx
      .update(SessionAttachmentGrantTable)
      .set({ state: "revoked", reason, revoked_at: now })
      .where(and(inArray(SessionAttachmentGrantTable.id, [...seen] as never), eq(SessionAttachmentGrantTable.state, "active")))
      .run()
      .pipe(Effect.orDie)
    return seen.size
  })
}

/**
 * Asset-level revocation: tombstone the upload and cascade to **every** grant.
 * This is distinct from unlinking/deleting the parent Session, which must not
 * silently revoke a live child grant.
 */
export const revokeAsset = Effect.fn("SessionAttachment.revokeAsset")(function* (
  db: DB,
  attachmentID: Contract.ID,
  reason: string,
  now: number = Date.now(),
) {
  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        yield* tx
          .update(SessionAttachmentTable)
          .set({ tombstoned_at: now })
          .where(eq(SessionAttachmentTable.id, attachmentID))
          .run()
          .pipe(Effect.orDie)
        const grants = yield* tx
          .select({ id: SessionAttachmentGrantTable.id })
          .from(SessionAttachmentGrantTable)
          .where(eq(SessionAttachmentGrantTable.attachment_id, attachmentID))
          .all()
          .pipe(Effect.orDie)
        for (const grant of grants) yield* cascadeRevoke(tx, grant.id, reason, now)
        return grants.length
      }),
    { behavior: "immediate" },
  )
})

/** Release grants for a terminal child according to retention policy. */
export const releaseGrantsForChild = Effect.fn("SessionAttachment.releaseGrantsForChild")(function* (
  db: DB,
  childSessionID: string,
  now: number = Date.now(),
) {
  const rows = yield* db
    .select({ id: SessionAttachmentGrantTable.id })
    .from(SessionAttachmentGrantTable)
    .where(
      and(
        or(
          eq(SessionAttachmentGrantTable.target_child_session_id, childSessionID as never),
          eq(SessionAttachmentGrantTable.target_member_session_id, childSessionID as never),
        ),
        eq(SessionAttachmentGrantTable.state, "active"),
      ),
    )
    .all()
    .pipe(Effect.orDie)
  for (const row of rows) yield* revokeGrant(db, row.id, "child-terminal", now)
  return rows.length
})

// ---------------------------------------------------------------------------
// Status recording (selection / authorization / resolution / inclusion)
// ---------------------------------------------------------------------------

export type RecordInclusionInput = {
  readonly grantID: Contract.GrantID
  readonly resolved?: boolean
  readonly includedInProviderRequest?: boolean
  readonly providerID?: string
  readonly modelID?: string
  readonly accountID?: string
  readonly reason?: string
  readonly now?: number
}

/**
 * Record execution facts for one grant. Inclusion is the only fact that asserts
 * bytes were serialized into a provider request; it is never inferred from a
 * grant's existence.
 */
export const recordInclusion = Effect.fn("SessionAttachment.recordInclusion")(function* (
  db: DB,
  input: RecordInclusionInput,
) {
  const now = input.now ?? Date.now()
  yield* db
    .insert(SessionAttachmentStatusTable)
    .values({
      grant_id: input.grantID,
      selected: true,
      authorized: true,
      resolved: input.resolved ?? false,
      included_in_provider_request: input.includedInProviderRequest ?? false,
      recipient_provider_id: input.providerID ?? null,
      recipient_model_id: input.modelID ?? null,
      recipient_account_id: input.accountID ?? null,
      reason: input.reason ?? null,
      time_updated: now,
    })
    .onConflictDoUpdate({
      target: SessionAttachmentStatusTable.grant_id,
      set: {
        ...(input.resolved === undefined ? {} : { resolved: input.resolved }),
        ...(input.includedInProviderRequest === undefined
          ? {}
          : { included_in_provider_request: input.includedInProviderRequest }),
        recipient_provider_id: input.providerID ?? null,
        recipient_model_id: input.modelID ?? null,
        recipient_account_id: input.accountID ?? null,
        reason: input.reason ?? null,
        time_updated: now,
      },
    })
    .run()
    .pipe(Effect.orDie)
})

/** Compact statuses for one recipient, keyed by handle, safe to batch in a projection. */
export function recipientStatuses(db: DB, childSessionID: string) {
  return db
    .select({
      handle: SessionAttachmentTable.handle,
      status: SessionAttachmentStatusTable,
    })
    .from(SessionAttachmentGrantTable)
    .innerJoin(SessionAttachmentTable, eq(SessionAttachmentTable.id, SessionAttachmentGrantTable.attachment_id))
    .innerJoin(SessionAttachmentStatusTable, eq(SessionAttachmentStatusTable.grant_id, SessionAttachmentGrantTable.id))
    .where(
      or(
        eq(SessionAttachmentGrantTable.target_child_session_id, childSessionID as never),
        eq(SessionAttachmentGrantTable.target_member_session_id, childSessionID as never),
      ),
    )
    .all()
    .pipe(
      Effect.map((rows) =>
        rows.map((row) => ({
          handle: row.handle,
          status: {
            selected: row.status.selected,
            authorized: row.status.authorized,
            resolved: row.status.resolved,
            includedInProviderRequest: row.status.included_in_provider_request,
            ...(row.status.reason ? { reason: row.status.reason } : {}),
          },
        })),
      ),
      Effect.orDie,
    )
}

// ---------------------------------------------------------------------------
// Byte resolution (Tier-3 child execution only)
// ---------------------------------------------------------------------------

/**
 * Resolve selected attachment bytes for a provider request. Only live grants are
 * resolved; arbitrary paths and URLs are never fetched. Returns inline data URLs
 * (bounded compatibility backing) that the child compiler serializes into the
 * provider request.
 */
export const resolveBytes = Effect.fn("SessionAttachment.resolveBytes")(function* (
  db: DB,
  grantIDs: ReadonlyArray<Contract.GrantID>,
) {
  const resolved: Contract.Resolved[] = []
  for (const grantID of grantIDs) {
    const check = yield* checkGrant(db, grantID)
    if (!check.ok) continue
    const grant = check.grant
    const row = yield* db
      .select({
        id: SessionAttachmentTable.id,
        handle: SessionAttachmentTable.handle,
        mime: SessionAttachmentTable.mime,
        filename: SessionAttachmentTable.filename,
        byteLength: SessionAttachmentTable.byte_length,
        bytes: SessionAttachmentBlobTable.bytes,
      })
      .from(SessionAttachmentTable)
      .innerJoin(SessionAttachmentBlobTable, eq(SessionAttachmentBlobTable.id, SessionAttachmentTable.blob_id))
      .where(eq(SessionAttachmentTable.id, grant.attachmentID))
      .get()
      .pipe(Effect.orDie)
    if (!row) continue
    resolved.push({
      handle: row.handle,
      id: row.id,
      mime: row.mime,
      ...(row.filename ? { filename: row.filename } : {}),
      byteLength: row.byteLength,
      url: `data:${row.mime};base64,${row.bytes}`,
    })
  }
  return resolved
})

/** Active grants for an exact recipient child/member session. */
export function activeGrantsForChild(db: DB, childSessionID: string) {
  return db
    .select()
    .from(SessionAttachmentGrantTable)
    .where(
      and(
        eq(SessionAttachmentGrantTable.state, "active"),
        or(
          eq(SessionAttachmentGrantTable.target_child_session_id, childSessionID as never),
          eq(SessionAttachmentGrantTable.target_member_session_id, childSessionID as never),
        ),
      ),
    )
    .all()
    .pipe(
      Effect.map((rows) => rows.map(decodeGrant)),
      Effect.orDie,
    )
}

/**
 * Bounded orchestrator-visible manifest for one worker turn.
 *
 * `currentTurn` holds the eligible uploads of the exact triggering user turn
 * (only when that turn is user-owned); `activeGrants` holds uploads this worker
 * already has a live grant for. Older uploads are discoverable only through the
 * explicit paginated index. This reads the durable upload index only; it never
 * scans or hydrates transcript history.
 */
export const buildManifest = Effect.fn("SessionAttachment.buildManifest")(function* (
  db: DB,
  input: { readonly sessionID: string; readonly currentTurnMessageID?: string; readonly workerSessionID: string },
) {
  const limit = Policy.maxPerSelection
  const currentRows = input.currentTurnMessageID
    ? yield* currentTurnUploads(db, input.sessionID, input.currentTurnMessageID)
    : []
  const currentTurnUploadsEligible = currentRows.filter(
    (upload) => !upload.tombstonedAt && isEligibleOrigin(upload.origin),
  )
  const grantRows = yield* activeGrantEntries(db, input.workerSessionID)
  const currentTurn: Contract.ManifestEntry[] = currentTurnUploadsEligible.slice(0, limit).map((upload) => ({
    handle: upload.handle,
    id: upload.id,
    ...(upload.filename ? { filename: upload.filename } : {}),
    mime: upload.mime,
    byteLength: upload.byteLength,
    eligibility: classifyMime(upload.mime),
    availability: "available",
    sourceMessageID: upload.messageID,
    sourcePartID: upload.partID,
  }))
  const activeGrants: Contract.ManifestEntry[] = grantRows.slice(0, limit).map(({ upload, grantID }) => ({
    handle: upload.handle,
    id: upload.id,
    ...(upload.filename ? { filename: upload.filename } : {}),
    mime: upload.mime,
    byteLength: upload.byteLength,
    eligibility: classifyMime(upload.mime),
    availability: "available",
    sourceMessageID: upload.messageID,
    sourcePartID: upload.partID,
    grantID,
  }))
  const truncated = currentTurnUploadsEligible.length > limit || grantRows.length > limit
  return {
    sessionID: input.sessionID as unknown as SessionID,
    currentTurn,
    activeGrants,
    truncated,
  } satisfies Contract.Manifest
})

/**
 * Render a bounded, model-facing manifest. This is orchestration context, not
 * instruction authority: it lists symbolic handles the model may select and
 * never inlines bytes or storage identities.
 */
export function renderManifest(manifest: Contract.Manifest): string | undefined {
  if (manifest.currentTurn.length === 0 && manifest.activeGrants.length === 0) return undefined
  const line = (entry: Contract.ManifestEntry) =>
    `- ${entry.handle}: ${entry.filename ?? "(unnamed)"} (${entry.mime}, ${entry.byteLength} bytes, ${entry.availability})`
  return [
    "<attachments>",
    "User uploads eligible for delegation this turn. Select one or more by exact handle via the task tool's `attachments` argument; unsupported MIME or over-budget items fail visibly. Handles are not paths or URLs.",
    ...(manifest.currentTurn.length === 0
      ? []
      : ["Current turn uploads:", ...manifest.currentTurn.map(line)]),
    ...(manifest.activeGrants.length === 0
      ? []
      : ["Already granted to this worker:", ...manifest.activeGrants.map(line)]),
    ...(manifest.truncated ? ["(more eligible uploads omitted; use the session attachment index to page older uploads)"] : []),
    "</attachments>",
  ].join("\n")
}

/** Compact bounded manifest entries for the active grants a worker already holds. */
export function activeGrantEntries(db: DB, workerSessionID: string) {
  return db
    .select({ upload: SessionAttachmentTable, grant: SessionAttachmentGrantTable })
    .from(SessionAttachmentGrantTable)
    .innerJoin(SessionAttachmentTable, eq(SessionAttachmentTable.id, SessionAttachmentGrantTable.attachment_id))
    .where(
      and(
        or(
          eq(SessionAttachmentGrantTable.target_child_session_id, workerSessionID as never),
          eq(SessionAttachmentGrantTable.target_member_session_id, workerSessionID as never),
        ),
        eq(SessionAttachmentGrantTable.state, "active"),
        isNull(SessionAttachmentTable.tombstoned_at),
      ),
    )
    .all()
    .pipe(
      Effect.map((rows) =>
        rows.map((row) => ({
          upload: decodeUpload(row.upload),
          grantID: row.grant.id,
        })),
      ),
      Effect.orDie,
    )
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/** Expire grants whose retention window has elapsed; bytes remain until reclamation. */
export const expireStaleGrants = Effect.fn("SessionAttachment.expireStaleGrants")(function* (
  db: DB,
  now: number = Date.now(),
) {
  const cutoff = now - Policy.grantRetentionMs
  yield* db
    .update(SessionAttachmentGrantTable)
    .set({ state: "expired", reason: "retention" })
    .where(
      and(eq(SessionAttachmentGrantTable.state, "active"), lt(SessionAttachmentGrantTable.time_created, cutoff)),
    )
    .run()
    .pipe(Effect.orDie)
  const changed = yield* db.get<{ changes: number }>(sql`SELECT changes() AS changes`).pipe(Effect.orDie)
  return changed?.changes ?? 0
})

/** Persisted uploads for a Session (used by tests and projection work). */
export function listForSession(db: DB, sessionID: string) {
  return db
    .select()
    .from(SessionAttachmentTable)
    .where(eq(SessionAttachmentTable.session_id, sessionID as never))
    .orderBy(asc(SessionAttachmentTable.time_created), asc(SessionAttachmentTable.id))
    .all()
    .pipe(
      Effect.map((rows) => rows.map(decodeUpload)),
      Effect.orDie,
    )
}
