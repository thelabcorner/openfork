export * as Credential from "./credential"

import { and, asc, eq, sql } from "drizzle-orm"
import { Context, Effect, Layer, PubSub, Schema, Stream } from "effect"
import { Credential } from "@opencode-ai/schema/credential"
import { Integration } from "@opencode-ai/schema/integration"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { CredentialTable } from "./credential/sql"

export const ID = Credential.ID
export type ID = Credential.ID

export const OAuth = Credential.OAuth
export type OAuth = Credential.OAuth

export const Key = Credential.Key
export type Key = Credential.Key

export const Value = Credential.Value
export type Value = Credential.Value

export class Info extends Schema.Class<Info>("Credential.Info")({
  id: ID,
  integrationID: Integration.ID,
  label: Schema.String,
  value: Value,
  active: Schema.optional(Schema.Boolean),
  revision: Schema.Number,
}) {}

export interface Interface {
  /** Secret-free notification emitted after a credential write commits. */
  readonly changes: Stream.Stream<{ readonly integrationID: Integration.ID }>
  /** Returns every stored credential. */
  readonly all: () => Effect.Effect<Info[]>
  /** Returns stored credentials belonging to one integration. */
  readonly list: (integrationID: Integration.ID) => Effect.Effect<Info[]>
  /** Returns one stored credential by ID. */
  readonly get: (id: ID) => Effect.Effect<Info | undefined>
  /** Replaces any credential for an integration and returns the new record. */
  readonly create: (input: {
    readonly integrationID: Integration.ID
    readonly value: Value
    readonly label?: string
  }) => Effect.Effect<Info>
  /** Adds a new credential for an integration without removing existing ones. */
  readonly add: (input: {
    readonly integrationID: Integration.ID
    readonly value: Value
    readonly label?: string
  }) => Effect.Effect<Info>
  /** Updates the label or secret value of a stored credential. */
  readonly update: (id: ID, updates: Partial<Pick<Info, "label" | "value">>) => Effect.Effect<void>
  /**
   * Replaces secret material only when the caller still owns the observed
   * revision. A successful write increments the trusted secret revision and
   * returns the committed row; a stale/deleted row returns undefined.
   */
  readonly compareAndSwapValue: (id: ID, revision: number, value: Value) => Effect.Effect<Info | undefined>
  /** Marks one credential as the active selection for its integration, clearing any other. */
  readonly select: (id: ID) => Effect.Effect<void>
  /** Removes a stored credential. */
  readonly remove: (id: ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Credential") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db, readDb } = yield* Database.Service
    const changes = yield* PubSub.sliding<{ readonly integrationID: Integration.ID }>(128)
    const decode = Schema.decodeUnknownSync(Value)
    const stored = (row: typeof CredentialTable.$inferSelect) => {
      if (!row.integration_id) return
      return new Info({
        id: row.id,
        integrationID: row.integration_id,
        label: row.label,
        value: decode(row.value),
        active: row.active ?? undefined,
        revision: row.revision,
      })
    }

    return Service.of({
      changes: Stream.fromPubSub(changes),
      all: Effect.fn("Credential.all")(function* () {
        return (yield* readDb
          .select()
          .from(CredentialTable)
          .orderBy(asc(CredentialTable.time_created))
          .all()
          .pipe(Effect.orDie)).flatMap((row) => {
          const credential = stored(row)
          return credential ? [credential] : []
        })
      }),
      list: Effect.fn("Credential.list")(function* (integrationID) {
        return (yield* readDb
          .select()
          .from(CredentialTable)
          .where(eq(CredentialTable.integration_id, integrationID))
          .orderBy(asc(CredentialTable.time_created))
          .all()
          .pipe(Effect.orDie)).flatMap((row) => {
          const credential = stored(row)
          return credential ? [credential] : []
        })
      }),
      get: Effect.fn("Credential.get")(function* (id) {
        const row = yield* readDb
          .select()
          .from(CredentialTable)
          .where(eq(CredentialTable.id, id))
          .get()
          .pipe(Effect.orDie)
        return row ? stored(row) : undefined
      }),
      create: Effect.fn("Credential.create")(function* (input) {
        const credential = new Info({
          id: ID.create(),
          integrationID: input.integrationID,
          label: input.label ?? "default",
          value: input.value,
          revision: 1,
        })
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .delete(CredentialTable)
                .where(eq(CredentialTable.integration_id, credential.integrationID))
                .run()
              yield* tx
                .insert(CredentialTable)
                .values({
                  id: credential.id,
                  integration_id: credential.integrationID,
                  label: credential.label,
                  value: credential.value,
                })
                .run()
            }),
          )
          .pipe(Effect.orDie)
        yield* PubSub.publish(changes, { integrationID: credential.integrationID })
        return credential
      }),
      add: Effect.fn("Credential.add")(function* (input) {
        const credential = new Info({
          id: ID.create(),
          integrationID: input.integrationID,
          label: input.label ?? "default",
          value: input.value,
          revision: 1,
        })
        yield* db
          .insert(CredentialTable)
          .values({
            id: credential.id,
            integration_id: credential.integrationID,
            label: credential.label,
            value: credential.value,
          })
          .run()
          .pipe(Effect.orDie)
        yield* PubSub.publish(changes, { integrationID: credential.integrationID })
        return credential
      }),
      update: Effect.fn("Credential.update")(function* (id, updates) {
        if (!updates.label && !updates.value) return
        const prior = yield* db
          .select({ integration_id: CredentialTable.integration_id })
          .from(CredentialTable)
          .where(eq(CredentialTable.id, id))
          .get()
          .pipe(Effect.orDie)
        const secret = updates.value !== undefined
        yield* db
          .update(CredentialTable)
          .set({
            label: updates.label,
            value: updates.value,
            ...(secret ? { revision: sql`${CredentialTable.revision} + 1` } : {}),
          })
          .where(eq(CredentialTable.id, id))
          .run()
          .pipe(Effect.orDie)
        if (prior?.integration_id) yield* PubSub.publish(changes, { integrationID: prior.integration_id })
      }),
      compareAndSwapValue: Effect.fn("Credential.compareAndSwapValue")(function* (id, revision, value) {
        const row = yield* db
          .update(CredentialTable)
          .set({
            value,
            revision: sql`${CredentialTable.revision} + 1`,
          })
          .where(and(eq(CredentialTable.id, id), eq(CredentialTable.revision, revision)))
          .returning()
          .get()
          .pipe(Effect.orDie)
        if (row?.integration_id) yield* PubSub.publish(changes, { integrationID: row.integration_id })
        return row ? stored(row) : undefined
      }),
      select: Effect.fn("Credential.select")(function* (id) {
        const row = yield* db.select().from(CredentialTable).where(eq(CredentialTable.id, id)).get().pipe(Effect.orDie)
        const integrationID = row?.integration_id
        if (!integrationID) return
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .update(CredentialTable)
                .set({ active: null })
                .where(eq(CredentialTable.integration_id, integrationID))
                .run()
              yield* tx.update(CredentialTable).set({ active: true }).where(eq(CredentialTable.id, id)).run()
            }),
          )
          .pipe(Effect.orDie)
      }),
      remove: Effect.fn("Credential.remove")(function* (id) {
        const row = yield* db
          .select({ integration_id: CredentialTable.integration_id })
          .from(CredentialTable)
          .where(eq(CredentialTable.id, id))
          .get()
          .pipe(Effect.orDie)
        yield* db.delete(CredentialTable).where(eq(CredentialTable.id, id)).run().pipe(Effect.orDie)
        if (row?.integration_id) yield* PubSub.publish(changes, { integrationID: row.integration_id })
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
