export * as SavedCodeAdmission from "./admission"

import { and, eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { SavedCodeAdmissionTable } from "./admission.sql"

export type ScopeKind = "project" | "global"
export type Origin = "code-save" | "operator"

export type Key = {
  readonly scopeKind: ScopeKind
  readonly scopeKey: string
  readonly savedID: string
  readonly revision: string
}

export type Info = Key & {
  readonly sourceHash: string
  readonly origin: Origin
  readonly originRunID?: string
  readonly admittedAt: number
}

export type AdmitInput = Key & {
  readonly sourceHash: string
  readonly origin: Origin
  readonly originRunID?: string
}

export class IntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SavedCodeAdmissionIntegrityError"
  }
}

export interface Interface {
  readonly get: (key: Key) => Effect.Effect<Info | undefined>
  readonly list: (scope: Pick<Key, "scopeKind" | "scopeKey">) => Effect.Effect<readonly Info[]>
  /**
   * Idempotently admit one exact executable revision.
   *
   * First-admission provenance is durable. A later save of the same exact
   * revision may come from another run and simply returns the existing row.
   * The same executable revision resolving to different source bytes is an
   * integrity failure and never rewrites trust.
   */
  readonly admit: (input: AdmitInput) => Effect.Effect<Info, IntegrityError>
  readonly revoke: (key: Key) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/core/SavedCodeAdmission") {}

const whereKey = (key: Key) =>
  and(
    eq(SavedCodeAdmissionTable.scope_kind, key.scopeKind),
    eq(SavedCodeAdmissionTable.scope_key, key.scopeKey),
    eq(SavedCodeAdmissionTable.saved_id, key.savedID),
    eq(SavedCodeAdmissionTable.revision, key.revision),
  )

const decode = (row: typeof SavedCodeAdmissionTable.$inferSelect): Info => ({
  scopeKind: row.scope_kind,
  scopeKey: row.scope_key,
  savedID: row.saved_id,
  revision: row.revision,
  sourceHash: row.source_hash,
  origin: row.origin,
  ...(row.origin_run_id ? { originRunID: row.origin_run_id } : {}),
  admittedAt: row.time_admitted,
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db, readDb } = yield* Database.Service

    const get: Interface["get"] = Effect.fn("SavedCodeAdmission.get")(function* (key) {
      const row = yield* readDb
        .select()
        .from(SavedCodeAdmissionTable)
        .where(whereKey(key))
        .get()
        .pipe(Effect.orDie)
      return row ? decode(row) : undefined
    })

    const list: Interface["list"] = Effect.fn("SavedCodeAdmission.list")(function* (scope) {
      const rows = yield* readDb
        .select()
        .from(SavedCodeAdmissionTable)
        .where(
          and(
            eq(SavedCodeAdmissionTable.scope_kind, scope.scopeKind),
            eq(SavedCodeAdmissionTable.scope_key, scope.scopeKey),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      return rows.map(decode)
    })

    const admit: Interface["admit"] = Effect.fn("SavedCodeAdmission.admit")(function* (input) {
      yield* db
        .insert(SavedCodeAdmissionTable)
        .values({
          scope_kind: input.scopeKind,
          scope_key: input.scopeKey,
          saved_id: input.savedID,
          revision: input.revision,
          source_hash: input.sourceHash,
          origin: input.origin,
          origin_run_id: input.originRunID ?? null,
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)

      // Read from the primary writer connection: a dedicated query-only reader
      // may still observe an older WAL snapshot immediately after our insert.
      const row = yield* db
        .select()
        .from(SavedCodeAdmissionTable)
        .where(whereKey(input))
        .get()
        .pipe(Effect.orDie)

      if (!row) {
        return yield* Effect.die(new Error("Saved Code admission insert committed without a readable row."))
      }
      if (row.source_hash !== input.sourceHash) {
        return yield* Effect.fail(
          new IntegrityError(
            `Saved Code revision ${input.revision} for ${input.scopeKind}:${input.savedID} is already admitted with a different source hash.`,
          ),
        )
      }
      return decode(row)
    })

    const revoke: Interface["revoke"] = Effect.fn("SavedCodeAdmission.revoke")(function* (key) {
      yield* db.delete(SavedCodeAdmissionTable).where(whereKey(key)).run().pipe(Effect.orDie)
    })

    return Service.of({ get, list, admit, revoke })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
