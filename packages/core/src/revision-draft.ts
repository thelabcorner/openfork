export * as RevisionDraft from "./revision-draft"

import { and, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { RevisionDraftClaimTable, RevisionDraftTable } from "./revision-draft.sql"

export const Kind = Schema.Literals(["prompt", "goal", "scheduled_task"])
export type Kind = typeof Kind.Type

export const Purpose = Schema.Literals(["prompt", "goal", "scheduled_task"])
export type Purpose = typeof Purpose.Type

export const Target = Schema.Struct({
  kind: Kind,
  key: Schema.String,
  sourceFingerprint: Schema.String,
})
export type Target = typeof Target.Type

export const Locator = Schema.Struct({
  kind: Kind,
  key: Schema.String,
})
export type Locator = typeof Locator.Type

export const Artifact = Schema.Struct({
  id: Schema.String,
  directory: Schema.String,
  kind: Kind,
  key: Schema.String,
  purpose: Purpose,
  sourceFingerprint: Schema.String,
  prompt: Schema.String,
  references: Schema.Array(Schema.Unknown),
  timeCreated: Schema.Number,
})
export type Artifact = typeof Artifact.Type

export interface PutInput {
  readonly claimID: string
  readonly directory: string
  readonly target: Target
  readonly purpose: Purpose
  readonly prompt: string
  readonly references: readonly unknown[]
  readonly now?: number
}

export interface Interface {
  /**
   * Claim the next generation for a target. Claiming is cheap and happens
   * before provider work so request ordering, not provider completion order,
   * determines which generation is allowed to become durable.
   */
  readonly claim: (input: { readonly target: Target; readonly now?: number }) => Effect.Effect<string>
  /** Atomically replace the single pending artifact for this target. */
  readonly put: (input: PutInput) => Effect.Effect<Artifact | undefined>
  /** O(log n) unique-index read. No Location/Instance/runtime services are involved. */
  readonly recover: (locator: Locator) => Effect.Effect<Artifact | undefined>
  /**
   * Generation-safe acknowledgement. Deleting by immutable artifact id means an
   * old renderer cannot consume a newer replacement for the same target.
   */
  readonly consume: (id: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/RevisionDraft") {}

function revisionKind(value: string): Kind {
  switch (value) {
    case "prompt":
    case "goal":
    case "scheduled_task":
      return value
    default:
      throw new Error(`Invalid persisted revision kind: ${value}`)
  }
}

function artifact(row: typeof RevisionDraftTable.$inferSelect): Artifact {
  return {
    id: row.id,
    directory: row.directory,
    kind: revisionKind(row.target_kind),
    key: row.target_key,
    purpose: revisionKind(row.purpose),
    sourceFingerprint: row.source_fingerprint,
    prompt: row.prompt,
    references: row.references,
    timeCreated: row.time_created,
  }
}

export const make = Effect.gen(function* () {
  const { db, readDb } = yield* Database.Service

  const claim = Effect.fn("RevisionDraft.claim")(function* (input: {
    readonly target: Target
    readonly now?: number
  }) {
    const claimID = `revision-draft-claim:${crypto.randomUUID()}`
    const now = input.now ?? Date.now()
    yield* db
      .insert(RevisionDraftClaimTable)
      .values({
        target_kind: input.target.kind,
        target_key: input.target.key,
        claim_id: claimID,
        source_fingerprint: input.target.sourceFingerprint,
        time_claimed: now,
      })
      .onConflictDoUpdate({
        target: [RevisionDraftClaimTable.target_kind, RevisionDraftClaimTable.target_key],
        set: {
          claim_id: claimID,
          source_fingerprint: input.target.sourceFingerprint,
          time_claimed: now,
        },
      })
      .run()
      .pipe(Effect.orDie)
    return claimID
  })

  const put = Effect.fn("RevisionDraft.put")(function* (input: PutInput) {
    const now = input.now ?? Date.now()
    const id = `revision-draft:${crypto.randomUUID()}`
    return yield* db
      .transaction(
        (tx) =>
          Effect.gen(function* () {
            const current = yield* tx
              .select({ claimID: RevisionDraftClaimTable.claim_id })
              .from(RevisionDraftClaimTable)
              .where(
                and(
                  eq(RevisionDraftClaimTable.target_kind, input.target.kind),
                  eq(RevisionDraftClaimTable.target_key, input.target.key),
                  eq(RevisionDraftClaimTable.claim_id, input.claimID),
                  eq(RevisionDraftClaimTable.source_fingerprint, input.target.sourceFingerprint),
                ),
              )
              .get()
              .pipe(Effect.orDie)
            if (!current) return undefined

            yield* tx
              .insert(RevisionDraftTable)
              .values({
                id,
                directory: input.directory,
                target_kind: input.target.kind,
                target_key: input.target.key,
                purpose: input.purpose,
                source_fingerprint: input.target.sourceFingerprint,
                prompt: input.prompt,
                references: [...input.references],
                time_created: now,
              })
              .onConflictDoUpdate({
                target: [RevisionDraftTable.target_kind, RevisionDraftTable.target_key],
                set: {
                  id,
                  directory: input.directory,
                  purpose: input.purpose,
                  source_fingerprint: input.target.sourceFingerprint,
                  prompt: input.prompt,
                  references: [...input.references],
                  time_created: now,
                },
              })
              .run()
              .pipe(Effect.orDie)

            yield* tx
              .delete(RevisionDraftClaimTable)
              .where(
                and(
                  eq(RevisionDraftClaimTable.target_kind, input.target.kind),
                  eq(RevisionDraftClaimTable.target_key, input.target.key),
                  eq(RevisionDraftClaimTable.claim_id, input.claimID),
                  eq(RevisionDraftClaimTable.source_fingerprint, input.target.sourceFingerprint),
                ),
              )
              .run()
              .pipe(Effect.orDie)

            return {
              id,
              directory: input.directory,
              kind: input.target.kind,
              key: input.target.key,
              purpose: input.purpose,
              sourceFingerprint: input.target.sourceFingerprint,
              prompt: input.prompt,
              references: [...input.references],
              timeCreated: now,
            } satisfies Artifact
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.orDie)
  })

  const recover = Effect.fn("RevisionDraft.recover")(function* (locator: Locator) {
    const row = yield* readDb
      .select()
      .from(RevisionDraftTable)
      .where(
        and(
          eq(RevisionDraftTable.target_kind, locator.kind),
          eq(RevisionDraftTable.target_key, locator.key),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    return row ? artifact(row) : undefined
  })

  const consume = Effect.fn("RevisionDraft.consume")(function* (id: string) {
    yield* db.delete(RevisionDraftTable).where(eq(RevisionDraftTable.id, id)).run().pipe(Effect.orDie)
  })

  return Service.of({ claim, put, recover, consume })
})

export const layer = Layer.effect(Service, make)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node],
})
