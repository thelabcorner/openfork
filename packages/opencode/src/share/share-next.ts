import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import type * as SDK from "@opencode-ai/sdk/v2"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Effect, Exit, Layer, Option, Schema, Scope, Context, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Account } from "@/account/account"
import { AccountID } from "@/account/schema"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { Provider } from "@/provider/provider"

import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import type { SessionID } from "@/session/schema"
import { Database } from "@opencode-ai/core/database/database"
import { and, eq, notInArray, sql } from "drizzle-orm"
import { Config } from "@/config/config"
import { SessionShareTable, ShareCleanupTable } from "@opencode-ai/core/share/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionTurnProvenance } from "@opencode-ai/core/v1/session-turn-provenance"

const disabled = process.env["OPENCODE_DISABLE_SHARE"] === "true" || process.env["OPENCODE_DISABLE_SHARE"] === "1"

export type Api = {
  create: string
  sync: (shareID: string) => string
  remove: (shareID: string) => string
  data: (shareID: string) => string
}

export type Req = {
  headers: Record<string, string>
  api: Api
  baseUrl: string
  apiFamily: "share" | "shares"
  accountID?: string
  orgID?: string
}

const ShareSchema = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  secret: Schema.String,
})
export type Share = typeof ShareSchema.Type

type State = {
  queue: Map<SessionID, Map<string, Data>>
  scope: Scope.Closeable
  shared: Map<SessionID, Share | null>
  flushing: Set<SessionID>
  cleanupDraining: boolean
  cleanupRequested: boolean
  closed: boolean
}

type Data =
  | {
      type: "session"
      data: SDK.Session
    }
  | {
      type: "message"
      data: SDK.Message
    }
  | {
      type: "part"
      data: SDK.Part
    }
  | {
      type: "session_diff"
      data: SDK.SnapshotFileDiff[]
    }
  | {
      type: "model"
      data: SDK.Model[]
    }
  | {
      type: "model_request"
      data: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
    }

export interface Interface {
  readonly init: () => Effect.Effect<void, unknown>
  readonly url: () => Effect.Effect<string, unknown>
  readonly request: () => Effect.Effect<Req, unknown>
  readonly create: (sessionID: SessionID) => Effect.Effect<Share, unknown>
  readonly remove: (sessionID: SessionID) => Effect.Effect<void, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ShareNext") {}

export const use = serviceUse(Service)

function api(resource: string): Api {
  return {
    create: `/api/${resource}`,
    sync: (shareID) => `/api/${resource}/${shareID}/sync`,
    remove: (shareID) => `/api/${resource}/${shareID}`,
    data: (shareID) => `/api/${resource}/${shareID}/data`,
  }
}

const legacyApi = api("share")
const consoleApi = api("shares")

function key(item: Data) {
  switch (item.type) {
    case "session":
      return "session"
    case "message":
      return `message/${item.data.id}`
    case "part":
      return `part/${item.data.messageID}/${item.data.id}`
    case "session_diff":
      return "session_diff"
    case "model":
    case "model_request":
      return "model"
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const account = yield* Account.Service
    const events = yield* EventV2Bridge.Service
    const cfg = yield* Config.Service
    const { db } = yield* Database.Service
    const http = yield* HttpClient.HttpClient
    const httpOk = HttpClient.filterStatusOk(http)
    const provider = yield* Provider.Service
    const session = yield* Session.Service

    function sync(sessionID: SessionID, data: Data[] | (() => Data[])) {
      return Effect.gen(function* () {
        if (disabled) return
        const share = yield* getCached(sessionID)
        if (!share) return
        // Optional sharing must not copy live content for unshared sessions.
        const items = typeof data === "function" ? data() : data

        const s = yield* InstanceState.get(state)
        const existing = s.queue.get(sessionID)
        if (existing) {
          for (const item of items) {
            existing.set(key(item), item)
          }
          return
        }

        const next = new Map(items.map((item) => [key(item), item]))
        s.queue.set(sessionID, next)
        yield* scheduleFlush(sessionID, s)
      })
    }

    function scheduleFlush(sessionID: SessionID, s: State): Effect.Effect<void> {
      return Effect.sync(() => {
        if (s.closed || s.flushing.has(sessionID) || !s.queue.has(sessionID)) return false
        s.flushing.add(sessionID)
        return true
      }).pipe(Effect.flatMap((start) => start
        ? Effect.gen(function* () {
            while (!s.closed && s.queue.has(sessionID)) yield* flush(sessionID)
          }).pipe(
            Effect.delay(1000),
            Effect.catchCause((cause) => Effect.logError("share flush failed", { sessionID, cause })),
            Effect.ensuring(Effect.sync(() => s.flushing.delete(sessionID)).pipe(
              Effect.andThen(Effect.suspend(() => scheduleFlush(sessionID, s))),
            )),
            Effect.forkIn(s.scope),
            Effect.asVoid,
          )
        : Effect.void))
    }

    const state: InstanceState.InstanceState<State> = yield* InstanceState.make<State>(
      Effect.fn("ShareNext.state")(function* (_ctx) {
        const cache: State = {
          queue: new Map(), scope: yield* Scope.make(), shared: new Map(), flushing: new Set(), cleanupDraining: false, cleanupRequested: false, closed: false,
        }

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => { cache.closed = true; cache.queue.clear() }).pipe(
            Effect.andThen(Scope.close(cache.scope, Exit.void)),
            Effect.andThen(
              Effect.sync(() => {
                cache.queue.clear()
                cache.shared.clear()
                cache.flushing.clear()
                cache.cleanupDraining = false
                cache.cleanupRequested = false
              }),
            ),
          ),
        )

        if (disabled) return cache

        const watch = <D extends EventV2.Definition>(
          def: D,
          fn: (data: EventV2.Data<D>) => Effect.Effect<void, unknown>,
        ) =>
          Effect.gen(function* () {
            // Share state is per project. Keep it off the process-global event
            // fanout, and—critically—bind the subscription lifetime to this
            // InstanceState scope. The old helper returned an unsubscribe
            // effect that every caller discarded, leaking FIVE listeners for
            // every project ever initialized in the process.
            const unsubscribe = yield* events.listenDirectory(def, _ctx.directory, (event) =>
              fn(event.data as EventV2.Data<D>).pipe(
                Effect.catchCause((cause) =>
                  Effect.logError("share subscriber failed", { type: def.type, cause: cause }),
                ),
              ),
            )
            yield* Effect.addFinalizer(() => unsubscribe)
          })

        yield* watch(Session.Event.Updated, (data) =>
          Effect.gen(function* () {
            const info = data.info
            yield* sync(info.id, () => [{ type: "session", data: structuredClone(info) as SDK.Session }])
          }),
        )
        yield* watch(MessageV2.Event.Updated, (data) =>
          Effect.gen(function* () {
            const info = data.info
            yield* sync(info.sessionID, () => [{ type: "message", data: structuredClone(info) as SDK.Message }])
            // A V1 provider-user message is not necessarily a worker prompt.
            // Goal/compaction/recovery continuations still sync as messages, but
            // they must not trigger redundant Provider model resolution/model
            // sync. Keep incremental behavior aligned with full(), which uses
            // the same V2-backed worker-prompt provenance contract.
            if (!SessionTurnProvenance.isWorkerPromptInfo(info) || info.role !== "user") return
            // Model projection belongs to an existing share. An ordinary
            // prompt must not initialize providers for optional sharing.
            if (!(yield* getCached(info.sessionID))) return
            // Resolve optional share model metadata in the existing background
            // flush owner, never in the session's publication path.
            yield* sync(info.sessionID, [{ type: "model_request", data: info.model }])
          }),
        )
        yield* watch(MessageV2.Event.PartUpdated, (data) =>
          sync(data.part.sessionID, () => [{ type: "part", data: structuredClone(data.part) as SDK.Part }]),
        )
        yield* watch(Session.Event.Diff, (data) =>
          sync(data.sessionID, () => [{ type: "session_diff", data: structuredClone(data.diff) as SDK.SnapshotFileDiff[] }]),
        )
        yield* watch(Session.Event.Deleted, (data) =>
          Effect.gen(function* () {
            const s = yield* InstanceState.get(state)
            s.shared.delete(data.sessionID)
            s.queue.delete(data.sessionID)
            yield* db.update(ShareCleanupTable).set({ ready: 1 })
              .where(eq(ShareCleanupTable.session_id, data.sessionID)).run().pipe(Effect.orDie)
            yield* scheduleCleanupDrain()
          }),
        )

        return cache
      }),
    )

    // Cleanup rows are independent of Session lifetime. Keep the worker owned
    // by the ShareNext instance scope, but leave failed rows durable so a later
    // init/retry can resume after shutdown. Each drain handles at most 100 rows
    // and retries each at most three times with bounded backoff.
    const scheduleCleanupDrain: () => Effect.Effect<void> = Effect.fn("ShareNext.scheduleCleanupDrain")(function* () {
      const s = yield* InstanceState.get(state)
      if (s.closed) return
      if (s.cleanupDraining) {
        s.cleanupRequested = true
        return
      }
      const pending = yield* db.select({ id: ShareCleanupTable.share_id }).from(ShareCleanupTable)
        .where(eq(ShareCleanupTable.ready, 1)).limit(1).get().pipe(Effect.orDie)
      if (!pending) return
      s.cleanupDraining = true
      yield* Effect.gen(function* () {
        // Cap each worker turn at 100 rows to bound foreground-adjacent work.
        const processed = new Set<string>()
        for (let batch = 0; batch < 5; batch++) {
          const rows = yield* db.select().from(ShareCleanupTable)
            .where(and(
              eq(ShareCleanupTable.ready, 1),
              processed.size ? notInArray(ShareCleanupTable.share_id, [...processed]) : undefined,
            ))
            .limit(20)
            .pipe(Effect.orDie)
          if (rows.length === 0) break
          for (const row of rows) {
            processed.add(row.share_id)
            let removed = false
            let lastError: unknown
            for (let attempt = 0; attempt < 3 && !removed; attempt++) {
              if (attempt > 0) yield* Effect.sleep(attempt * 250)
              const result = yield* Effect.exit(Effect.gen(function* () {
                const req = yield* Effect.gen(function* () {
                  if (row.api_family === "shares") {
                    if (!row.account_id || !row.org_id || !row.base_url) {
                      return yield* Effect.fail(new Error("captured share route is incomplete"))
                    }
                    const token = yield* account.token(AccountID.make(row.account_id))
                    if (Option.isNone(token)) {
                      return yield* Effect.fail(new Error("captured share account token is unavailable"))
                    }
                    return {
                      baseUrl: row.base_url,
                      api: consoleApi,
                      headers: { authorization: `Bearer ${token.value}`, "x-org-id": row.org_id },
                    }
                  }
                  if (row.api_family !== "share") {
                    return yield* Effect.fail(new Error("captured share API family is unavailable"))
                  }
                  if (!row.base_url) return yield* Effect.fail(new Error("captured share endpoint is unavailable"))
                  return { baseUrl: row.base_url, api: legacyApi, headers: {} }
                })
                const res = yield* HttpClientRequest.delete(`${req.baseUrl}${req.api.remove(row.share_id)}`).pipe(
                  HttpClientRequest.setHeaders(req.headers),
                  HttpClientRequest.bodyJson({ secret: row.secret }),
                  Effect.flatMap((r) => http.execute(r)),
                )
                if (res.status >= 400 && res.status !== 404) {
                  return yield* Effect.fail(new Error(`share DELETE returned ${res.status}`))
                }
                yield* db.delete(ShareCleanupTable).where(eq(ShareCleanupTable.share_id, row.share_id)).run().pipe(Effect.orDie)
                return true
              }))
              if (Exit.isSuccess(result)) {
                removed = true
              } else {
                lastError = result.cause
              }
            }
            if (!removed) {
              yield* db.update(ShareCleanupTable).set({
                attempts: row.attempts + 3,
                last_error: String(lastError),
              }).where(eq(ShareCleanupTable.share_id, row.share_id)).run().pipe(Effect.orDie)
              yield* Effect.logWarning("remote share cleanup deferred after retries", {
                sessionID: row.session_id,
                shareID: row.share_id,
                cause: lastError,
              })
            }
          }
        }
      }).pipe(
        Effect.catchCause((cause) => Effect.logError("share cleanup drain failed", { cause })),
        Effect.ensuring(Effect.sync(() => { s.cleanupDraining = false }).pipe(
          Effect.andThen(Effect.suspend(() => {
            if (!s.cleanupRequested) return Effect.void
            s.cleanupRequested = false
            return scheduleCleanupDrain()
          })),
        )),
        Effect.forkIn(s.scope),
        Effect.asVoid,
      )
    })

    const recoverCleanup = Effect.fn("ShareNext.recoverCleanup")(function* () {
      const prepared = yield* db.select().from(ShareCleanupTable)
        .where(eq(ShareCleanupTable.ready, 0))
        .limit(100)
        .pipe(Effect.orDie)
      for (const row of prepared) {
        const session = yield* db.get<{ id: string }>(sql`SELECT id FROM session WHERE id = ${row.session_id}`)
          .pipe(Effect.orDie)
        if (!session) {
          yield* db.update(ShareCleanupTable).set({ ready: 1 })
            .where(eq(ShareCleanupTable.share_id, row.share_id)).run().pipe(Effect.orDie)
        }
      }
    })

    const request = Effect.fn("ShareNext.request")(function* () {
      const headers: Record<string, string> = {}
      const active = yield* account.active()
      if (Option.isNone(active) || !active.value.active_org_id) {
        const baseUrl = (yield* cfg.get()).enterprise?.url ?? "https://opncd.ai"
        return { headers, api: legacyApi, baseUrl, apiFamily: "share" } satisfies Req
      }

      const token = yield* account.token(active.value.id)
      if (Option.isNone(token)) {
        throw new Error("No active account token available for sharing")
      }

      headers.authorization = `Bearer ${token.value}`
      headers["x-org-id"] = active.value.active_org_id
      return {
        headers,
        api: consoleApi,
        baseUrl: active.value.url,
        apiFamily: "shares",
        accountID: active.value.id,
        orgID: active.value.active_org_id,
      } satisfies Req
    })

    const get = Effect.fnUntraced(function* (sessionID: SessionID) {
      const row = yield* db
        .select()
        .from(SessionShareTable)
        .where(eq(SessionShareTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return
      return { id: row.id, secret: row.secret, url: row.url } satisfies Share
    })

    const getCached = Effect.fnUntraced(function* (sessionID: SessionID) {
      const s = yield* InstanceState.get(state)
      if (s.shared.has(sessionID)) {
        const cached = s.shared.get(sessionID)
        return cached === null ? undefined : cached
      }

      const share = yield* get(sessionID)
      s.shared.set(sessionID, share ?? null)
      return share
    })

    const flush = Effect.fn("ShareNext.flush")(function* (sessionID: SessionID) {
      if (disabled) return
      const s = yield* InstanceState.get(state)
      const queued = s.queue.get(sessionID)
      if (!queued) return

      s.queue.delete(sessionID)

      const share = yield* getCached(sessionID)
      if (!share) return

      const data = yield* Effect.forEach([...queued.values()], (item) => item.type === "model_request"
        ? provider.getModel(item.data.providerID, item.data.modelID).pipe(
            Effect.map((model) => ({ type: "model" as const, data: [model] })),
          )
        : Effect.succeed(item))
      const req = yield* request()
      const res = yield* HttpClientRequest.post(`${req.baseUrl}${req.api.sync(share.id)}`).pipe(
        HttpClientRequest.setHeaders(req.headers),
        HttpClientRequest.bodyJson({ secret: share.secret, data }),
        Effect.flatMap((r) => http.execute(r)),
      )

      if (res.status >= 400) {
        yield* Effect.logWarning("failed to sync share", {
          sessionID: sessionID,
          shareID: share.id,
          status: res.status,
        })
      }
    })

    const full = Effect.fn("ShareNext.full")(function* (sessionID: SessionID) {
      yield* Effect.logInfo("full sync", { sessionID: sessionID })
      const info = yield* session.get(sessionID)
      const diffs = yield* session.diff(sessionID)
      const messages = yield* session.messages({ sessionID })
      const models = yield* Effect.forEach(
        Array.from(
          new Map(
            messages
              .filter(SessionTurnProvenance.isWorkerPromptTurn)
              .map((msg) => (msg.info as SDK.UserMessage).model)
              .map((item) => [`${item.providerID}/${item.modelID}`, item] as const),
          ).values(),
        ),
        (item) => provider.getModel(ProviderV2.ID.make(item.providerID), ModelV2.ID.make(item.modelID)),
        { concurrency: 8 },
      )

      yield* sync(sessionID, [
        { type: "session", data: info },
        ...messages.map((item) => ({ type: "message" as const, data: item.info })),
        ...messages.flatMap((item) => item.parts.map((part) => ({ type: "part" as const, data: part }))),
        { type: "session_diff", data: diffs },
        { type: "model", data: models },
      ])
    })

    const init = Effect.fn("ShareNext.init")(function* () {
      if (disabled) return
      yield* InstanceState.get(state)
      yield* recoverCleanup()
      yield* scheduleCleanupDrain()
    })

    const url = Effect.fn("ShareNext.url")(function* () {
      return (yield* request()).baseUrl
    })

    const create = Effect.fn("ShareNext.create")(function* (sessionID: SessionID) {
      if (disabled) return { id: "", url: "", secret: "" }
      yield* Effect.logInfo("creating share", { sessionID: sessionID })
      const req = yield* request()
      const result = yield* HttpClientRequest.post(`${req.baseUrl}${req.api.create}`).pipe(
        HttpClientRequest.setHeaders(req.headers),
        HttpClientRequest.bodyJson({ sessionID }),
        Effect.flatMap((r) => httpOk.execute(r)),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(ShareSchema)),
      )
      yield* db
        .insert(SessionShareTable)
        .values({
          session_id: sessionID,
          id: result.id,
          secret: result.secret,
          url: result.url,
          delete_base_url: req.baseUrl,
          delete_api_family: req.apiFamily,
          delete_account_id: req.accountID,
          delete_org_id: req.orgID,
        })
        .onConflictDoUpdate({
          target: SessionShareTable.session_id,
          set: {
            id: result.id,
            secret: result.secret,
            url: result.url,
            delete_base_url: req.baseUrl,
            delete_api_family: req.apiFamily,
            delete_account_id: req.accountID,
            delete_org_id: req.orgID,
          },
        })
        .run()
        .pipe(Effect.orDie)
      const s = yield* InstanceState.get(state)
      s.shared.set(sessionID, result)
      yield* full(sessionID).pipe(
        Effect.catchCause((cause) => Effect.logError("share full sync failed", { sessionID: sessionID, cause: cause })),
        Effect.forkIn(s.scope),
      )
      return result
    })

    const remove = Effect.fn("ShareNext.remove")(function* (sessionID: SessionID) {
      if (disabled) return
      yield* Effect.logInfo("removing share", { sessionID: sessionID })
      const s = yield* InstanceState.get(state)
      const share = yield* getCached(sessionID)
      if (!share) {
        s.shared.delete(sessionID)
        s.queue.delete(sessionID)
        return
      }

      const req = yield* request()
      yield* HttpClientRequest.delete(`${req.baseUrl}${req.api.remove(share.id)}`).pipe(
        HttpClientRequest.setHeaders(req.headers),
        HttpClientRequest.bodyJson({ secret: share.secret }),
        Effect.flatMap((r) => httpOk.execute(r)),
      )

      yield* db.delete(SessionShareTable).where(eq(SessionShareTable.session_id, sessionID)).run().pipe(Effect.orDie)
      s.shared.delete(sessionID)
      s.queue.delete(sessionID)
    })

    return Service.of({ init, url, request, create, remove })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Account.node, EventV2Bridge.node, Config.node, Database.node, httpClient, Provider.node, Session.node],
})

export * as ShareNext from "./share-next"
