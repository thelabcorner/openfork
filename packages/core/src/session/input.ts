export * as SessionInput from "./input"

import { and, asc, desc, eq, isNotNull, isNull, lt, lte } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import {
  AdmissionClass,
  Admitted,
  DelegatedTurnAuthority,
  Delivery,
  Entry,
  Item,
  Kind,
  RevocationReason,
  SyntheticAdmissionClass,
  SyntheticContent,
  SyntheticExecution,
  SyntheticItem,
  SyntheticOrigin,
  UserItem,
} from "@opencode-ai/schema/session-input"
import type { Database } from "../database/database"
import type { EventV2 } from "../event"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { Prompt } from "./prompt"
import { SessionSchema } from "./schema"
import { SessionInputTable, SessionMessageTable } from "./sql"
import { SessionTurnProvenance } from "./turn-provenance"

type DatabaseService = Database.Interface["db"]
type Row = typeof SessionInputTable.$inferSelect

export {
  AdmissionClass,
  Admitted,
  DelegatedTurnAuthority,
  Delivery,
  Entry,
  Item,
  Kind,
  RevocationReason,
  SyntheticAdmissionClass,
  SyntheticContent,
  SyntheticExecution,
  SyntheticItem,
  SyntheticOrigin,
  UserItem,
}

const decodePrompt = Schema.decodeUnknownSync(Prompt)
const encodePrompt = Schema.encodeSync(Prompt)
const decodeItem = Schema.decodeUnknownSync(Item)
const encodeItem = Schema.encodeSync(Item)

const itemFromRow = (row: Row): Item =>
  row.input === null ? UserItem.make({ type: "user", prompt: decodePrompt(row.prompt) }) : decodeItem(row.input)

const entryFromRow = (row: Row): Entry =>
  Entry.make({
    admittedSeq: row.admitted_seq,
    id: SessionMessage.ID.make(row.id),
    sessionID: SessionSchema.ID.make(row.session_id),
    kind: row.kind,
    admissionClass: row.admission_class,
    userPreemptible: row.user_preemptible,
    item: itemFromRow(row),
    delivery: row.delivery,
    timeCreated: DateTime.makeUnsafe(row.time_created),
    ...(row.promoted_seq === null ? {} : { promotedSeq: row.promoted_seq }),
    ...(row.revoked_seq === null ? {} : { revokedSeq: row.revoked_seq }),
    ...(row.revoked_reason === null ? {} : { revokedReason: row.revoked_reason }),
  })

const admittedFromRow = (row: Row): Admitted | undefined => {
  const item = itemFromRow(row)
  if (item.type !== "user") return undefined
  return Admitted.make({
    admittedSeq: row.admitted_seq,
    id: SessionMessage.ID.make(row.id),
    sessionID: SessionSchema.ID.make(row.session_id),
    prompt: item.prompt,
    delivery: row.delivery,
    ...(row.provenance === null ? {} : { provenance: row.provenance }),
    timeCreated: DateTime.makeUnsafe(row.time_created),
    ...(row.promoted_seq === null ? {} : { promotedSeq: row.promoted_seq }),
  })
}

const findRow = Effect.fnUntraced(function* (db: DatabaseService, id: SessionMessage.ID) {
  return yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.id, id)).get().pipe(Effect.orDie)
})

/** Compatibility view for genuine Prompt admissions. Generic consumers use findEntry. */
export const find = Effect.fn("SessionInput.find")(function* (db: DatabaseService, id: SessionMessage.ID) {
  const row = yield* findRow(db, id)
  return row === undefined ? undefined : admittedFromRow(row)
})

export const findEntry = Effect.fn("SessionInput.findEntry")(function* (db: DatabaseService, id: SessionMessage.ID) {
  const row = yield* findRow(db, id)
  return row === undefined ? undefined : entryFromRow(row)
})

export class LifecycleConflict extends Schema.TaggedErrorClass<LifecycleConflict>()("SessionInput.LifecycleConflict", {
  id: SessionMessage.ID,
}) {}

export class AdmissionFenceConflict extends Error {
  readonly _tag = "SessionInput.AdmissionFenceConflict"
  constructor(
    readonly sessionID: SessionSchema.ID,
    readonly expectedLatestUserSeq: number | undefined,
    readonly actualLatestUserSeq: number | undefined,
  ) {
    super(
      `Synthetic admission for ${sessionID} expected latest user sequence ${expectedLatestUserSeq ?? "none"}, found ${actualLatestUserSeq ?? "none"}`,
    )
  }
}

export class InvalidAdmissionPolicy extends Error {
  readonly _tag = "SessionInput.InvalidAdmissionPolicy"
}

/**
 * Exact turn-scoped delegated agent authority. Content is never consulted:
 * User authority comes only from typed Prompt agent attachments; Synthetic
 * authority comes only from the trusted delegated envelope.
 */
export function authorizedAgentNames(item: Item): ReadonlySet<string> {
  if (item.type === "user") return new Set((item.prompt.agents ?? []).map((agent) => agent.name))
  return new Set(item.delegated?.authorizedAgentNames ?? [])
}

const promptAdmissionClass = (provenance: SessionMessage.Provenance | undefined): AdmissionClass =>
  provenance?.owner === "host" ? "host" : "user"

/**
 * Existing Prompt lane. Public Session.prompt remains a genuine User API;
 * host-owned User-shaped rows are retained only for the current hostPrompt
 * compatibility seam while those producers migrate to admitSynthetic().
 */
export interface PromptAdmissionInput {
  readonly id: SessionMessage.ID
  readonly sessionID: SessionSchema.ID
  readonly prompt: Prompt
  readonly delivery: Delivery
  readonly provenance: SessionMessage.Provenance
}

/**
 * Admission plus idempotency state. Domain side effects that represent a new
 * human intervention (Goal automation cancellation/reactivation, etc.) must be
 * attached only to `created=true`; replaying an old message ID is not a new
 * user turn and must not acquire fresh authority over newer state.
 */
export const admitWithState = Effect.fn("SessionInput.admitWithState")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  input: PromptAdmissionInput,
) {
  const existingRow = yield* findRow(db, input.id)
  if (existingRow !== undefined) {
    const existing = admittedFromRow(existingRow)
    if (!existing) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
    return { admitted: existing, created: false as const }
  }
  const timestamp = yield* DateTime.now
  return yield* events
    .publish(SessionEvent.PromptAdmitted, {
      messageID: input.id,
      sessionID: input.sessionID,
      timestamp,
      prompt: input.prompt,
      delivery: input.delivery,
      provenance: input.provenance,
    })
    .pipe(
      Effect.flatMap((event) =>
        event.durable === undefined
          ? Effect.die("Prompt admission event is missing aggregate sequence")
          : Effect.succeed({
              admitted: Admitted.make({
                admittedSeq: event.durable.seq,
                id: input.id,
                sessionID: input.sessionID,
                prompt: input.prompt,
                delivery: input.delivery,
                provenance: input.provenance,
                timeCreated: timestamp,
              }),
              created: true as const,
            }),
      ),
      Effect.catchDefect((defect) =>
        find(db, input.id).pipe(
          Effect.flatMap((stored) =>
            stored ? Effect.succeed({ admitted: stored, created: true as const }) : Effect.die(defect),
          ),
        ),
      ),
    )
})

export const admit = Effect.fn("SessionInput.admit")((db: DatabaseService, events: EventV2.Interface, input: PromptAdmissionInput) =>
  admitWithState(db, events, input).pipe(Effect.map((result) => result.admitted)),
)

export const projectAdmitted = Effect.fn("SessionInput.projectAdmitted")(function* (
  db: DatabaseService,
  input: {
    readonly admittedSeq: number
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
    readonly provenance?: SessionMessage.Provenance
    readonly timeCreated: DateTime.Utc
  },
) {
  const message = yield* db
    .select({ id: SessionMessageTable.id })
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.id, input.id))
    .get()
    .pipe(Effect.orDie)
  if (message !== undefined) return yield* Effect.die(new LifecycleConflict({ id: input.id }))

  const admissionClass = promptAdmissionClass(input.provenance)
  const item = UserItem.make({ type: "user", prompt: input.prompt })
  const stored = yield* db
    .insert(SessionInputTable)
    .values({
      id: input.id,
      session_id: input.sessionID,
      kind: "user",
      admission_class: admissionClass,
      user_preemptible: false,
      input: item,
      admitted_seq: input.admittedSeq,
      prompt: encodePrompt(input.prompt),
      delivery: input.delivery,
      provenance: input.provenance ?? null,
      time_created: DateTime.toEpochMillis(input.timeCreated),
    })
    .onConflictDoNothing()
    .returning({ id: SessionInputTable.id })
    .get()
    .pipe(Effect.orDie)
  if (!stored) return yield* Effect.die(new LifecycleConflict({ id: input.id }))

  // Semantic User admission and retirement of older preemptible work share one
  // EventV2 IMMEDIATE transaction. There is no cancellation race to repair.
  if (admissionClass === "user") {
    yield* db
      .update(SessionInputTable)
      .set({ revoked_seq: input.admittedSeq, revoked_reason: "user_superseded" })
      .where(
        and(
          eq(SessionInputTable.session_id, input.sessionID),
          eq(SessionInputTable.user_preemptible, true),
          isNull(SessionInputTable.promoted_seq),
          isNull(SessionInputTable.revoked_seq),
          lt(SessionInputTable.admitted_seq, input.admittedSeq),
        ),
      )
      .run()
      .pipe(Effect.orDie)
  }
})

/**
 * V1 compatibility frontier for a genuine semantic User turn that is already
 * materialized in the mature legacy transcript. The transcript row is visible
 * immediately, but execution remains a pending SessionInput until the runner
 * promotes it at a safe provider-cycle boundary. This gives V1 the same durable
 * admission-vs-release fence as current execution instead of treating a newly
 * written user row as already consumed while another owner may still be running.
 */
export const projectLegacyUserAdmission = Effect.fn("SessionInput.projectLegacyUserAdmission")(function* (
  db: DatabaseService,
  input: {
    readonly seq: number
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly provenance: SessionMessage.Provenance
    readonly timeCreated: number
  },
) {
  const prompt = Prompt.make({ text: "" })
  const item = UserItem.make({ type: "user", prompt })
  const existing = yield* findRow(db, input.id)
  if (existing) {
    // Replaying the same durable V1 MessageUpdated event is idempotent even if
    // this admission has since been promoted by the runner. Promotion is a
    // monotonic later state; never require it to still be pending here.
    if (
      existing.session_id === input.sessionID &&
      existing.kind === "user" &&
      existing.admission_class === "user" &&
      existing.admitted_seq === input.seq &&
      existing.revoked_seq === null
    )
      return
    return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  }
  yield* db
    .insert(SessionInputTable)
    .values({
      id: input.id,
      session_id: input.sessionID,
      kind: "user",
      admission_class: "user",
      user_preemptible: false,
      input: item,
      prompt: encodePrompt(prompt),
      delivery: "steer",
      provenance: input.provenance,
      admitted_seq: input.seq,
      promoted_seq: null,
      time_created: input.timeCreated,
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .update(SessionInputTable)
    .set({ revoked_seq: input.seq, revoked_reason: "user_superseded" })
    .where(
      and(
        eq(SessionInputTable.session_id, input.sessionID),
        eq(SessionInputTable.user_preemptible, true),
        isNull(SessionInputTable.promoted_seq),
        isNull(SessionInputTable.revoked_seq),
        lt(SessionInputTable.admitted_seq, input.seq),
      ),
    )
    .run()
    .pipe(Effect.orDie)
})

export const projectPrompted = Effect.fn("SessionInput.projectPrompted")(function* (
  db: DatabaseService,
  input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
    readonly provenance?: SessionMessage.Provenance
    readonly timeCreated: DateTime.Utc
    readonly promotedSeq: number
  },
) {
  const updated = yield* db
    .update(SessionInputTable)
    .set({ promoted_seq: input.promotedSeq })
    .where(
      and(
        eq(SessionInputTable.id, input.id),
        eq(SessionInputTable.session_id, input.sessionID),
        isNull(SessionInputTable.promoted_seq),
        isNull(SessionInputTable.revoked_seq),
      ),
    )
    .returning()
    .get()
    .pipe(Effect.orDie)
  if (updated) {
    const stored = admittedFromRow(updated)
    if (!stored || !matchesProjection(stored, input)) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
    return
  }

  const storedRow = yield* findRow(db, input.id)
  if (storedRow) {
    const stored = admittedFromRow(storedRow)
    if (!stored || !matchesProjection(stored, input) || stored.promotedSeq !== input.promotedSeq)
      return yield* Effect.die(new LifecycleConflict({ id: input.id }))
    return
  }

  // Historical Prompted events predate admission. Preserve that replay seam;
  // new writers always emit PromptAdmitted first.
  const item = UserItem.make({ type: "user", prompt: input.prompt })
  yield* db
    .insert(SessionInputTable)
    .values({
      id: input.id,
      session_id: input.sessionID,
      kind: "user",
      admission_class: promptAdmissionClass(input.provenance),
      user_preemptible: false,
      input: item,
      prompt: encodePrompt(input.prompt),
      delivery: input.delivery,
      provenance: input.provenance ?? null,
      admitted_seq: input.promotedSeq,
      promoted_seq: input.promotedSeq,
      time_created: DateTime.toEpochMillis(input.timeCreated),
    })
    .run()
    .pipe(Effect.orDie)
})

export function provenanceForSynthetic(sessionID: SessionSchema.ID, item: SyntheticItem): SessionMessage.Provenance {
  const cause = item.origin.cause
  return SessionTurnProvenance.host(item.origin.producer, {
    ...(cause?.sessionID === sessionID ? { sourceMessageID: cause.messageID } : {}),
    ...(item.origin.ref === undefined ? {} : { ref: item.origin.ref }),
  })
}

function syntheticMirrorPrompt(item: SyntheticItem): Prompt {
  return Prompt.make({
    text: item.content.text,
    ...(item.content.files === undefined ? {} : { files: item.content.files }),
  })
}

function sameItem(actual: Item, expected: Item) {
  return JSON.stringify(encodeItem(actual)) === JSON.stringify(encodeItem(expected))
}

function equivalentEntry(
  actual: Entry,
  expected: {
    readonly sessionID: SessionSchema.ID
    readonly item: Item
    readonly delivery: Delivery
    readonly admissionClass: AdmissionClass
    readonly userPreemptible: boolean
  },
) {
  return (
    actual.sessionID === expected.sessionID &&
    actual.delivery === expected.delivery &&
    actual.admissionClass === expected.admissionClass &&
    actual.userPreemptible === expected.userPreemptible &&
    sameItem(actual.item, expected.item)
  )
}

export const latestUserSeq = Effect.fn("SessionInput.latestUserSeq")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const row = yield* db
    .select({ admittedSeq: SessionInputTable.admitted_seq })
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        eq(SessionInputTable.kind, "user"),
        eq(SessionInputTable.admission_class, "user"),
      ),
    )
    .orderBy(desc(SessionInputTable.admitted_seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return row?.admittedSeq
})

const verifyLatestUserSeq = (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  expectedLatestUserSeq: number | undefined,
) =>
  latestUserSeq(db, sessionID).pipe(
    Effect.flatMap((actualLatestUserSeq) =>
      actualLatestUserSeq === expectedLatestUserSeq
        ? Effect.void
        : Effect.die(new AdmissionFenceConflict(sessionID, expectedLatestUserSeq, actualLatestUserSeq)),
    ),
  )

export type SyntheticAdmission = {
  readonly id: SessionMessage.ID
  readonly sessionID: SessionSchema.ID
  readonly content: SyntheticContent
  readonly origin: SyntheticOrigin
  readonly delegated?: DelegatedTurnAuthority
  readonly execution?: SyntheticExecution
  readonly delivery?: Delivery
  /**
   * Trusted local side effect committed in the same durable Session event
   * transaction. This is intentionally not part of the serialized input model;
   * cross-domain producers use it to settle correlation/receipt state without a
   * crash window after Session admission.
   */
  readonly commit?: (seq: number) => Effect.Effect<void>
} & (
  | {
      readonly admissionClass: "host"
      readonly userPreemptible?: boolean
      /**
       * Optional optimistic human-focus fence. Presence is significant: an
       * explicit `undefined` means "there must still be no semantic User".
       */
      readonly expectedLatestUserSeq?: number | undefined
    }
  | {
      readonly admissionClass: "automatic"
      readonly userPreemptible?: true
      readonly expectedLatestUserSeq: number | undefined
    }
)

export const admitSynthetic = Effect.fn("SessionInput.admitSynthetic")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  input: SyntheticAdmission,
) {
  const delivery = input.delivery ?? "queue"
  if (input.admissionClass === "automatic" && delivery !== "queue")
    return yield* Effect.die(new InvalidAdmissionPolicy("Automatic Session input is queue-only"))
  const hasUserFence =
    input.admissionClass === "automatic" || Object.prototype.hasOwnProperty.call(input, "expectedLatestUserSeq")
  const userPreemptible = input.admissionClass === "automatic" ? true : (input.userPreemptible ?? false)
  const item = SyntheticItem.make({
    type: "synthetic",
    content: input.content,
    origin: input.origin,
    ...(input.delegated === undefined ? {} : { delegated: input.delegated }),
    ...(input.execution === undefined ? {} : { execution: input.execution }),
  })
  // Validate first-party provenance requirements (causal roots/correlation)
  // before attempting a durable write.
  provenanceForSynthetic(input.sessionID, item)
  const expected = {
    sessionID: input.sessionID,
    item,
    delivery,
    admissionClass: input.admissionClass,
    userPreemptible,
  } as const

  const existing = yield* findEntry(db, input.id)
  if (existing) {
    if (!equivalentEntry(existing, expected)) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
    return existing
  }

  const timestamp = yield* DateTime.now
  return yield* events
    .publish(
      SessionEvent.SyntheticAdmitted,
      {
        messageID: input.id,
        sessionID: input.sessionID,
        timestamp,
        content: input.content,
        origin: input.origin,
        ...(input.delegated === undefined ? {} : { delegated: input.delegated }),
        ...(input.execution === undefined ? {} : { execution: input.execution }),
        delivery,
        admissionClass: input.admissionClass,
        userPreemptible,
      },
      hasUserFence || input.commit
        ? {
            commit: (seq) =>
              Effect.gen(function* () {
                if (hasUserFence) yield* verifyLatestUserSeq(db, input.sessionID, input.expectedLatestUserSeq)
                if (input.commit) yield* input.commit(seq)
              }),
          }
        : undefined,
    )
    .pipe(
      Effect.flatMap((event) =>
        event.durable === undefined
          ? Effect.die("Synthetic admission event is missing aggregate sequence")
          : Effect.succeed(
              Entry.make({
                admittedSeq: event.durable.seq,
                id: input.id,
                sessionID: input.sessionID,
                kind: "synthetic",
                admissionClass: input.admissionClass,
                userPreemptible,
                item,
                delivery,
                timeCreated: timestamp,
              }),
            ),
      ),
      Effect.catchDefect((defect) =>
        findEntry(db, input.id).pipe(
          Effect.flatMap((stored) =>
            stored && equivalentEntry(stored, expected) ? Effect.succeed(stored) : Effect.die(defect),
          ),
        ),
      ),
    )
})

export const projectSyntheticAdmitted = Effect.fn("SessionInput.projectSyntheticAdmitted")(function* (
  db: DatabaseService,
  input: {
    readonly admittedSeq: number
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly content: SyntheticContent
    readonly origin: SyntheticOrigin
    readonly delegated?: DelegatedTurnAuthority
    readonly execution?: SyntheticExecution
    readonly delivery: Delivery
    readonly admissionClass: SyntheticAdmissionClass
    readonly userPreemptible: boolean
    readonly timeCreated: DateTime.Utc
  },
) {
  const message = yield* db
    .select({ id: SessionMessageTable.id })
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.id, input.id))
    .get()
    .pipe(Effect.orDie)
  if (message !== undefined) return yield* Effect.die(new LifecycleConflict({ id: input.id }))

  if (input.admissionClass === "automatic" && (input.delivery !== "queue" || !input.userPreemptible))
    return yield* Effect.die(new InvalidAdmissionPolicy("Invalid automatic Session input lifecycle event"))

  const item = SyntheticItem.make({
    type: "synthetic",
    content: input.content,
    origin: input.origin,
    ...(input.delegated === undefined ? {} : { delegated: input.delegated }),
    ...(input.execution === undefined ? {} : { execution: input.execution }),
  })
  const prompt = syntheticMirrorPrompt(item)
  const stored = yield* db
    .insert(SessionInputTable)
    .values({
      id: input.id,
      session_id: input.sessionID,
      kind: "synthetic",
      admission_class: input.admissionClass,
      user_preemptible: input.userPreemptible,
      input: item,
      prompt: encodePrompt(prompt),
      delivery: input.delivery,
      provenance: provenanceForSynthetic(input.sessionID, item),
      admitted_seq: input.admittedSeq,
      time_created: DateTime.toEpochMillis(input.timeCreated),
    })
    .onConflictDoNothing()
    .returning({ id: SessionInputTable.id })
    .get()
    .pipe(Effect.orDie)
  if (!stored) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
})

function matchesSyntheticProjection(
  entry: Entry,
  input: {
    readonly sessionID: SessionSchema.ID
    readonly content: SyntheticContent
    readonly origin: SyntheticOrigin
    readonly delegated?: DelegatedTurnAuthority
    readonly execution?: SyntheticExecution
    readonly delivery: Delivery
    readonly admissionClass: SyntheticAdmissionClass
    readonly userPreemptible: boolean
    readonly timeCreated: DateTime.Utc
  },
) {
  const item = SyntheticItem.make({
    type: "synthetic",
    content: input.content,
    origin: input.origin,
    ...(input.delegated === undefined ? {} : { delegated: input.delegated }),
    ...(input.execution === undefined ? {} : { execution: input.execution }),
  })
  return (
    equivalentEntry(entry, {
      sessionID: input.sessionID,
      item,
      delivery: input.delivery,
      admissionClass: input.admissionClass,
      userPreemptible: input.userPreemptible,
    }) && DateTime.toEpochMillis(entry.timeCreated) === DateTime.toEpochMillis(input.timeCreated)
  )
}

export const projectSyntheticPromoted = Effect.fn("SessionInput.projectSyntheticPromoted")(function* (
  db: DatabaseService,
  input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly content: SyntheticContent
    readonly origin: SyntheticOrigin
    readonly delegated?: DelegatedTurnAuthority
    readonly execution?: SyntheticExecution
    readonly delivery: Delivery
    readonly admissionClass: SyntheticAdmissionClass
    readonly userPreemptible: boolean
    readonly timeCreated: DateTime.Utc
    readonly promotedSeq: number
  },
) {
  const updated = yield* db
    .update(SessionInputTable)
    .set({ promoted_seq: input.promotedSeq })
    .where(
      and(
        eq(SessionInputTable.id, input.id),
        eq(SessionInputTable.session_id, input.sessionID),
        eq(SessionInputTable.kind, "synthetic"),
        isNull(SessionInputTable.promoted_seq),
        isNull(SessionInputTable.revoked_seq),
      ),
    )
    .returning()
    .get()
    .pipe(Effect.orDie)
  if (updated) {
    const entry = entryFromRow(updated)
    if (!matchesSyntheticProjection(entry, input)) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
    return
  }

  const stored = yield* findEntry(db, input.id)
  if (
    stored &&
    stored.promotedSeq === input.promotedSeq &&
    stored.revokedSeq === undefined &&
    matchesSyntheticProjection(stored, input)
  )
    return
  // A stale selected row that lost to revocation must abort this event. The
  // publisher classifies the durable row and reports staleRevoked without ever
  // committing a false SyntheticPromoted fact.
  return yield* Effect.die(new LifecycleConflict({ id: input.id }))
})

export const projectSyntheticRevoked = Effect.fn("SessionInput.projectSyntheticRevoked")(function* (
  db: DatabaseService,
  input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly revokedSeq: number
    readonly reason: RevocationReason
  },
) {
  const updated = yield* db
    .update(SessionInputTable)
    .set({ revoked_seq: input.revokedSeq, revoked_reason: input.reason })
    .where(
      and(
        eq(SessionInputTable.id, input.id),
        eq(SessionInputTable.session_id, input.sessionID),
        eq(SessionInputTable.kind, "synthetic"),
        isNull(SessionInputTable.promoted_seq),
        isNull(SessionInputTable.revoked_seq),
      ),
    )
    .returning({ id: SessionInputTable.id })
    .get()
    .pipe(Effect.orDie)
  if (updated) return

  const stored = yield* findEntry(db, input.id)
  if (stored?.revokedSeq === input.revokedSeq && stored.revokedReason === input.reason) return
  return yield* Effect.die(new LifecycleConflict({ id: input.id }))
})

export type RevokeResult =
  | { readonly state: "revoked"; readonly revokedSeq: number; readonly reason: RevocationReason }
  | { readonly state: "already-revoked"; readonly revokedSeq: number; readonly reason: RevocationReason }
  | { readonly state: "too-late"; readonly promotedSeq: number }
  | { readonly state: "not-found" }
  | { readonly state: "not-revocable" }

function classifyRevoke(entry: Entry | undefined): RevokeResult {
  if (!entry) return { state: "not-found" }
  if (entry.kind !== "synthetic") return { state: "not-revocable" }
  if (entry.promotedSeq !== undefined) return { state: "too-late", promotedSeq: entry.promotedSeq }
  if (entry.revokedSeq !== undefined)
    return {
      state: "already-revoked",
      revokedSeq: entry.revokedSeq,
      reason: entry.revokedReason ?? "cancelled",
    }
  return { state: "not-found" }
}

export const revokeSynthetic = Effect.fn("SessionInput.revokeSynthetic")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  input: {
    readonly sessionID: SessionSchema.ID
    readonly id: SessionMessage.ID
    readonly reason: RevocationReason
  },
) {
  const current = yield* findEntry(db, input.id)
  if (!current) return { state: "not-found" }
  if (current.kind !== "synthetic") return { state: "not-revocable" }
  if (current.promotedSeq !== undefined) return { state: "too-late", promotedSeq: current.promotedSeq }
  if (current.revokedSeq !== undefined)
    return {
      state: "already-revoked",
      revokedSeq: current.revokedSeq,
      reason: current.revokedReason ?? input.reason,
    }

  const outcome = yield* events
    .publish(SessionEvent.SyntheticRevoked, {
      sessionID: input.sessionID,
      messageID: input.id,
      reason: input.reason,
      timestamp: yield* DateTime.now,
    })
    .pipe(
      Effect.map((event) => ({ type: "event" as const, event })),
      Effect.catchDefect((defect) =>
        defect instanceof LifecycleConflict
          ? findEntry(db, input.id).pipe(
              Effect.map((entry) => ({ type: "result" as const, result: classifyRevoke(entry) })),
            )
          : Effect.die(defect),
      ),
    )
  if (outcome.type === "result") return outcome.result
  if (outcome.event.durable === undefined)
    return yield* Effect.die("Synthetic revocation event is missing aggregate sequence")
  return { state: "revoked" as const, revokedSeq: outcome.event.durable.seq, reason: input.reason }
})

export const hasPending = Effect.fn("SessionInput.hasPending")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  delivery: Delivery,
) {
  const row = yield* db
    .select({ id: SessionInputTable.id })
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        isNull(SessionInputTable.revoked_seq),
        eq(SessionInputTable.delivery, delivery),
      ),
    )
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return row !== undefined
})

export interface PendingLane {
  readonly admissionClass: AdmissionClass
  readonly delivery: Delivery
}

const pendingLaneOrder: readonly PendingLane[] = [
  { admissionClass: "user", delivery: "steer" },
  { admissionClass: "user", delivery: "queue" },
  { admissionClass: "host", delivery: "steer" },
  { admissionClass: "host", delivery: "queue" },
  { admissionClass: "automatic", delivery: "queue" },
]

export const hasPendingLane = Effect.fn("SessionInput.hasPendingLane")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  lane: PendingLane,
) {
  const row = yield* db
    .select({ id: SessionInputTable.id })
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        eq(SessionInputTable.admission_class, lane.admissionClass),
        eq(SessionInputTable.delivery, lane.delivery),
        isNull(SessionInputTable.promoted_seq),
        isNull(SessionInputTable.revoked_seq),
      ),
    )
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return row !== undefined
})

export const firstPendingEntry = Effect.fn("SessionInput.firstPendingEntry")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  lane: PendingLane,
) {
  const row = yield* db
    .select()
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        eq(SessionInputTable.admission_class, lane.admissionClass),
        eq(SessionInputTable.delivery, lane.delivery),
        isNull(SessionInputTable.promoted_seq),
        isNull(SessionInputTable.revoked_seq),
      ),
    )
    .orderBy(asc(SessionInputTable.admitted_seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return row === undefined ? undefined : entryFromRow(row)
})

/**
 * Fixed five-lane priority as short-circuit indexed point lookups. This keeps
 * the authority ordering explicit and avoids an opaque numeric priority column.
 */
export const nextPendingLane = Effect.fn("SessionInput.nextPendingLane")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  for (const lane of pendingLaneOrder) if (yield* hasPendingLane(db, sessionID, lane)) return lane
  return undefined
})

export const hasHigherPriorityPending = Effect.fn("SessionInput.hasHigherPriorityPending")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  admissionClass: AdmissionClass,
) {
  if (admissionClass === "user") return false
  const next = yield* nextPendingLane(db, sessionID)
  if (!next) return false
  if (admissionClass === "host") return next.admissionClass === "user"
  return next.admissionClass !== "automatic"
})

/**
 * Source class of the newest committed SessionInput promotion. This is the
 * durable fallback for explicit resume/recovery when no new inbox row needs
 * promotion.
 */
export const latestPromotedAdmissionClass = Effect.fn("SessionInput.latestPromotedAdmissionClass")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const row = yield* db
    .select({ admissionClass: SessionInputTable.admission_class })
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNotNull(SessionInputTable.promoted_seq),
        isNull(SessionInputTable.revoked_seq),
      ),
    )
    .orderBy(desc(SessionInputTable.promoted_seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return row?.admissionClass
})

export const equivalent = (
  input: Admitted,
  expected: {
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
    readonly provenance?: SessionMessage.Provenance
  },
) =>
  input.delivery === expected.delivery &&
  matchesPrompt(input, expected) &&
  equivalentProvenance(input.provenance, expected.provenance)

const equivalentProvenance = (
  actual: SessionMessage.Provenance | undefined,
  expected: SessionMessage.Provenance | undefined,
) => {
  if (actual === undefined || expected === undefined) {
    // Historical current/V2 prompt admissions had no origin field. They were
    // produced by the prompt lane, so an exact retry may upgrade that missing
    // origin only to the canonical user prompt source. Never infer host authority.
    const present = actual ?? expected
    return (
      present === undefined ||
      (present.owner === "user" && present.source === SessionMessage.ProvenanceSource.Prompt)
    )
  }
  return (
    actual.owner === expected.owner &&
    actual.source === expected.source &&
    (actual.owner !== "host" ||
      (expected.owner === "host" &&
        actual.sourceMessageID === expected.sourceMessageID &&
        actual.ref === expected.ref))
  )
}

const matchesPrompt = (input: Admitted, expected: { readonly sessionID: SessionSchema.ID; readonly prompt: Prompt }) =>
  input.sessionID === expected.sessionID &&
  JSON.stringify(encodePrompt(input.prompt)) === JSON.stringify(encodePrompt(expected.prompt))

const matchesProjection = (
  input: Admitted,
  expected: {
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
    readonly provenance?: SessionMessage.Provenance
    readonly timeCreated: DateTime.Utc
  },
) =>
  equivalent(input, expected) &&
  DateTime.toEpochMillis(input.timeCreated) === DateTime.toEpochMillis(expected.timeCreated)

export interface PromoteResult {
  readonly selected: number
  readonly promoted: number
  readonly staleRevoked: number
}

const emptyPromoteResult = (): PromoteResult => ({ selected: 0, promoted: 0, staleRevoked: 0 })
const combinePromoteResult = (left: PromoteResult, right: PromoteResult): PromoteResult => ({
  selected: left.selected + right.selected,
  promoted: left.promoted + right.promoted,
  staleRevoked: left.staleRevoked + right.staleRevoked,
})

const publishRows = Effect.fn("SessionInput.publishRows")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  rows: ReadonlyArray<Row>,
) {
  const result = { selected: rows.length, promoted: 0, staleRevoked: 0 }
  for (const row of rows) {
    const id = SessionMessage.ID.make(row.id)
    const item = itemFromRow(row)
    const publish =
      item.type === "user"
        ? events
            .publish(SessionEvent.Prompted, {
              sessionID,
              timestamp: DateTime.makeUnsafe(row.time_created),
              messageID: id,
              prompt: item.prompt,
              delivery: row.delivery,
              ...(row.provenance === null ? {} : { provenance: row.provenance }),
            })
            .pipe(Effect.asVoid)
        : row.admission_class === "user"
          ? Effect.die(new LifecycleConflict({ id }))
          : (() => {
              const admissionClass = row.admission_class
              return DateTime.now.pipe(
                Effect.flatMap((promotedAt) =>
                  events.publish(SessionEvent.SyntheticPromoted, {
                    sessionID,
                    timestamp: DateTime.makeUnsafe(row.time_created),
                    promotedAt,
                    messageID: id,
                    content: item.content,
                    origin: item.origin,
                    ...(item.delegated === undefined ? {} : { delegated: item.delegated }),
                    ...(item.execution === undefined ? {} : { execution: item.execution }),
                    delivery: row.delivery,
                    admissionClass,
                    userPreemptible: row.user_preemptible,
                  }),
                ),
                Effect.asVoid,
              )
            })()
    const outcome = yield* publish.pipe(
      Effect.as("promoted" as const),
      Effect.catchDefect((defect) =>
        defect instanceof LifecycleConflict
          ? findEntry(db, id).pipe(
              Effect.flatMap((stored) => {
                if (stored?.revokedSeq !== undefined) return Effect.succeed("stale-revoked" as const)
                if (stored?.promotedSeq !== undefined) return Effect.succeed("already-promoted" as const)
                return Effect.die(defect)
              }),
            )
          : Effect.die(defect),
      ),
    )
    if (outcome === "promoted") result.promoted++
    if (outcome === "stale-revoked") result.staleRevoked++
  }
  return result satisfies PromoteResult
})

function pendingWhere(sessionID: SessionSchema.ID, lane: PendingLane) {
  return and(
    eq(SessionInputTable.session_id, sessionID),
    eq(SessionInputTable.admission_class, lane.admissionClass),
    eq(SessionInputTable.delivery, lane.delivery),
    isNull(SessionInputTable.promoted_seq),
    isNull(SessionInputTable.revoked_seq),
  )
}

export const promoteLane = Effect.fn("SessionInput.promoteLane")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  lane: PendingLane,
  cutoff: number,
) {
  if (lane.admissionClass === "automatic" && lane.delivery !== "queue")
    return yield* Effect.die(new InvalidAdmissionPolicy("Automatic Session input is queue-only"))

  if (lane.delivery === "steer") {
    const rows = yield* db
      .select()
      .from(SessionInputTable)
      .where(and(pendingWhere(sessionID, lane), lte(SessionInputTable.admitted_seq, cutoff)))
      .orderBy(asc(SessionInputTable.admitted_seq))
      .all()
      .pipe(Effect.orDie)
    return yield* publishRows(db, events, sessionID, rows)
  }

  const queue = yield* db
    .select()
    .from(SessionInputTable)
    .where(and(pendingWhere(sessionID, lane), lte(SessionInputTable.admitted_seq, cutoff)))
    .orderBy(asc(SessionInputTable.admitted_seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  let result = queue ? yield* publishRows(db, events, sessionID, [queue]) : emptyPromoteResult()

  const steerLane = { admissionClass: lane.admissionClass, delivery: "steer" } as const
  const steers = yield* db
    .select()
    .from(SessionInputTable)
    .where(and(pendingWhere(sessionID, steerLane), lte(SessionInputTable.admitted_seq, cutoff)))
    .orderBy(asc(SessionInputTable.admitted_seq))
    .all()
    .pipe(Effect.orDie)
  if (steers.length) result = combinePromoteResult(result, yield* publishRows(db, events, sessionID, steers))
  return result
})

/**
 * Compatibility promotion helpers retained for focused tests/import utilities.
 * The runtime uses promoteLane() so provider cycles never mix source classes.
 */
export const promoteSteers = Effect.fn("SessionInput.promoteSteers")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  cutoff: number,
) {
  const rows = yield* db
    .select()
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        isNull(SessionInputTable.revoked_seq),
        eq(SessionInputTable.delivery, "steer"),
        lte(SessionInputTable.admitted_seq, cutoff),
      ),
    )
    .orderBy(asc(SessionInputTable.admitted_seq))
    .all()
    .pipe(Effect.orDie)
  return (yield* publishRows(db, events, sessionID, rows)).promoted
})

export const promoteNextQueued = Effect.fn("SessionInput.promoteNextQueued")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
) {
  for (const admissionClass of ["user", "host", "automatic"] as const) {
    const lane = { admissionClass, delivery: "queue" } as const
    const row = yield* db
      .select()
      .from(SessionInputTable)
      .where(pendingWhere(sessionID, lane))
      .orderBy(asc(SessionInputTable.admitted_seq))
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    if (!row) continue
    return (yield* publishRows(db, events, sessionID, [row])).promoted > 0
  }
  return false
})
