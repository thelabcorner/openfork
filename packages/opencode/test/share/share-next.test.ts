import { beforeEach, describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Layer, Option } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"

import { AccessToken, AccountID, OrgID, RefreshToken } from "../../src/account/schema"
import { AccountRepo } from "../../src/account/repo"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Session } from "@/session/session"
import { MessageID, type SessionID } from "../../src/session/schema"
import { ShareNext } from "@/share/share-next"
import { Provider } from "@/provider/provider"
import { ProviderTest } from "../fake/provider"
import { SessionTurnProvenance } from "@opencode-ai/core/v1/session-turn-provenance"
import { SessionShareTable } from "@opencode-ai/core/share/sql"
import { Database } from "@opencode-ai/core/database/database"
import { eq } from "drizzle-orm"
import { provideTmpdirInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { pollWithTimeout, testEffect } from "../lib/effect"

const env = LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node]))
const it = testEffect(env)

const json = (req: Parameters<typeof HttpClientResponse.fromWeb>[0], body: unknown, status = 200) =>
  HttpClientResponse.fromWeb(
    req,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  )

const none = HttpClient.make(() => Effect.die("unexpected http call"))

function requestLayer(client: HttpClient.HttpClient) {
  const replacement = [httpClient, Layer.succeed(HttpClient.HttpClient, client)] as const
  return LayerNode.compile(LayerNode.group([ShareNext.node, AccountRepo.node]), [replacement])
}

function integrationLayer(client: HttpClient.HttpClient, providerLayer?: Layer.Layer<Provider.Service>) {
  const replacement = [httpClient, Layer.succeed(HttpClient.HttpClient, client)] as const
  const group = LayerNode.group([
    ShareNext.node,
    EventV2Bridge.node,
    Session.node,
    SessionProjector.node,
    AccountRepo.node,
    Database.node,
  ])
  if (!providerLayer) return LayerNode.compile(group, [replacement])
  const providerReplacement = [Provider.node, providerLayer] as const
  return LayerNode.compile(group, [replacement, providerReplacement])
}

const share = (id: SessionID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select()
      .from(SessionShareTable)
      .where(eq(SessionShareTable.session_id, id))
      .get()
      .pipe(Effect.orDie)
  })

const seed = (url: string, org?: string) =>
  AccountRepo.Service.use((repo) =>
    repo.persistAccount({
      id: AccountID.make("account-1"),
      email: "user@example.com",
      url,
      accessToken: AccessToken.make("st_test_token"),
      refreshToken: RefreshToken.make("rt_test_token"),
      expiry: Date.now() + 10 * 60_000,
      orgID: org ? Option.some(OrgID.make(org)) : Option.none(),
    }),
  )

beforeEach(async () => {
  await resetDatabase()
})

describe("ShareNext", () => {
  it.live("shared prompts publish while background model metadata is blocked", () =>
    provideTmpdirInstance(() => Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let modelCalls = 0
      const seen: Array<{ data: Array<{ type: string; data: { id?: string } | unknown[] }> }> = []
      const client = HttpClient.make((request) => {
        if (request.url.endsWith("/sync") && request.body._tag === "Uint8Array") {
          seen.push(JSON.parse(new TextDecoder().decode(request.body.body)))
        }
        return Effect.succeed(json(request, { ok: true }))
      })
      const fakeProvider = ProviderTest.fake({
        getModel: Effect.fn("ShareNextTest.blockedModel")(function* (providerID, modelID) {
          modelCalls++
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
          return ProviderTest.model({ id: modelID, providerID })
        }),
      })
      yield* Effect.gen(function* () {
        const sharing = yield* ShareNext.Service
        const sessions = yield* Session.Service
        const info = yield* sessions.create({ title: "shared publication" })
        const { db } = yield* Database.Service
        yield* db.insert(SessionShareTable).values({
          session_id: info.id, id: "shr_blocked_model", secret: "sec_blocked_model",
          url: "https://legacy-share.example.com/share/blocked",
        }).run().pipe(Effect.orDie)
        yield* sharing.init()
        const publish = () => sessions.updateMessage({
          id: MessageID.ascending(), role: "user", sessionID: info.id,
          provenance: SessionTurnProvenance.user(SessionTurnProvenance.Source.Prompt),
          agent: "build", time: { created: Date.now() },
          model: { providerID: fakeProvider.model.providerID, modelID: fakeProvider.model.id },
        })
        const first = yield* publish()
        yield* Deferred.await(started)
        const second = yield* publish()
        expect(modelCalls).toBe(1)
        expect(seen).toHaveLength(0)
        yield* Deferred.succeed(release, undefined)
        yield* pollWithTimeout(Effect.sync(() => seen.length === 2 ? true : undefined),
          "background sharing did not drain", "5 seconds")
        expect(modelCalls).toBe(2)
        expect(seen.flatMap((batch) => batch.data.filter((item) => item.type === "message")
          .map((item) => (item.data as { id: string }).id))).toEqual([first.id, second.id])
        expect(seen.flatMap((batch) => batch.data).some((item) => item.type === "model_request")).toBe(false)
      }).pipe(Effect.provide(integrationLayer(client, fakeProvider.layer)))
    }), { config: { enterprise: { url: "https://legacy-share.example.com" } } }),
  )

  it.live("unshared worker prompts never resolve models for share projection", () =>
    provideTmpdirInstance(() => {
      let modelCalls = 0
      const fakeProvider = ProviderTest.fake({
        getModel: () => {
          modelCalls++
          return Effect.die("unshared prompt resolved a sharing model")
        },
      })
      return Effect.gen(function* () {
        const sharing = yield* ShareNext.Service
        const sessions = yield* Session.Service
        const info = yield* sessions.create({ title: "unshared prompt" })
        yield* sharing.init()
        yield* sessions.updateMessage({
          id: MessageID.ascending(), role: "user", sessionID: info.id,
          provenance: SessionTurnProvenance.user(SessionTurnProvenance.Source.Prompt),
          agent: "build", time: { created: Date.now() },
          model: { providerID: fakeProvider.model.providerID, modelID: fakeProvider.model.id },
        })
        expect(modelCalls).toBe(0)
        expect(yield* share(info.id)).toBeUndefined()
      }).pipe(Effect.provide(integrationLayer(none, fakeProvider.layer)))
    }, { config: { enterprise: { url: "https://legacy-share.example.com" } } }),
  )

  it.live("request uses legacy share API without active org account", () =>
    provideTmpdirInstance(
      () =>
        ShareNext.Service.use((svc) =>
          Effect.gen(function* () {
            const req = yield* svc.request()

            expect(req.api.create).toBe("/api/share")
            expect(req.api.sync("shr_123")).toBe("/api/share/shr_123/sync")
            expect(req.api.remove("shr_123")).toBe("/api/share/shr_123")
            expect(req.api.data("shr_123")).toBe("/api/share/shr_123/data")
            expect(req.baseUrl).toBe("https://legacy-share.example.com")
            expect(req.headers).toEqual({})
          }),
        ).pipe(Effect.provide(requestLayer(none))),
      { config: { enterprise: { url: "https://legacy-share.example.com" } } },
    ),
  )

  it.live("request uses default URL when no enterprise config", () =>
    provideTmpdirInstance(() =>
      ShareNext.Service.use((svc) =>
        Effect.gen(function* () {
          const req = yield* svc.request()

          expect(req.baseUrl).toBe("https://opncd.ai")
          expect(req.api.create).toBe("/api/share")
          expect(req.headers).toEqual({})
        }),
      ).pipe(Effect.provide(requestLayer(none))),
    ),
  )

  it.live("request uses org share API with auth headers when account is active", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* seed("https://control.example.com", "org-1")

        const req = yield* ShareNext.use.request()

        expect(req.api.create).toBe("/api/shares")
        expect(req.api.sync("shr_123")).toBe("/api/shares/shr_123/sync")
        expect(req.api.remove("shr_123")).toBe("/api/shares/shr_123")
        expect(req.api.data("shr_123")).toBe("/api/shares/shr_123/data")
        expect(req.baseUrl).toBe("https://control.example.com")
        expect(req.headers).toEqual({
          authorization: "Bearer st_test_token",
          "x-org-id": "org-1",
        })
      }).pipe(Effect.provide(requestLayer(none))),
    ),
  )

  it.live("create posts share, persists it, and returns the result", () =>
    provideTmpdirInstance(
      () => {
        const createRequests: HttpClientRequest.HttpClientRequest[] = []
        const client = HttpClient.make((req) => {
          if (req.url.endsWith("/api/share")) {
            createRequests.push(req)
            return Effect.succeed(
              json(req, {
                id: "shr_abc",
                url: "https://legacy-share.example.com/share/abc",
                secret: "sec_123",
              }),
            )
          }
          return Effect.succeed(json(req, { ok: true }))
        })
        return Effect.gen(function* () {
          const session = yield* (yield* Session.Service).create({ title: "test" })

          const result = yield* (yield* ShareNext.Service).create(session.id)

          expect(result.id).toBe("shr_abc")
          expect(result.url).toBe("https://legacy-share.example.com/share/abc")
          expect(result.secret).toBe("sec_123")

          const row = yield* share(session.id)
          expect(row?.id).toBe("shr_abc")
          expect(row?.url).toBe("https://legacy-share.example.com/share/abc")
          expect(row?.secret).toBe("sec_123")

          expect(createRequests).toHaveLength(1)
          expect(createRequests[0].method).toBe("POST")
          expect(createRequests[0].url).toBe("https://legacy-share.example.com/api/share")
        }).pipe(Effect.provide(integrationLayer(client)))
      },
      { config: { enterprise: { url: "https://legacy-share.example.com" } } },
    ),
  )

  it.live("remove deletes the persisted share and calls the delete endpoint", () =>
    provideTmpdirInstance(
      () => {
        const seen: HttpClientRequest.HttpClientRequest[] = []
        const client = HttpClient.make((req) => {
          seen.push(req)
          if (req.method === "POST") {
            return Effect.succeed(
              json(req, {
                id: "shr_abc",
                url: "https://legacy-share.example.com/share/abc",
                secret: "sec_123",
              }),
            )
          }
          return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(null, { status: 200 })))
        })
        return Effect.gen(function* () {
          const session = yield* (yield* Session.Service).create({ title: "test" })
          const service = yield* ShareNext.Service

          yield* service.create(session.id)
          yield* service.remove(session.id)

          expect(yield* share(session.id)).toBeUndefined()
          expect(seen.map((req) => [req.method, req.url])).toEqual([
            ["POST", "https://legacy-share.example.com/api/share"],
            ["DELETE", "https://legacy-share.example.com/api/share/shr_abc"],
          ])
        }).pipe(Effect.provide(integrationLayer(client)))
      },
      { config: { enterprise: { url: "https://legacy-share.example.com" } } },
    ),
  )

  it.live("create fails on a non-ok response and does not persist a share", () =>
    provideTmpdirInstance(() => {
      const client = HttpClient.make((req) => Effect.succeed(json(req, { error: "bad" }, 500)))
      return Effect.gen(function* () {
        const session = yield* (yield* Session.Service).create({ title: "test" })

        const exit = yield* ShareNext.Service.use((svc) => Effect.exit(svc.create(session.id)))

        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* share(session.id)).toBeUndefined()
      }).pipe(Effect.provide(integrationLayer(client)))
    }),
  )

  it.live("ShareNext coalesces rapid diff events into one delayed sync with latest data", () =>
    provideTmpdirInstance(
      () => {
        const seen: Array<{ url: string; body: string }> = []
        const client = HttpClient.make((req) => {
          if (req.url.endsWith("/sync") && req.body._tag === "Uint8Array") {
            seen.push({ url: req.url, body: new TextDecoder().decode(req.body.body) })
          }
          return Effect.succeed(json(req, { ok: true }))
        })

        return Effect.gen(function* () {
          const events = yield* EventV2Bridge.Service
          const share = yield* ShareNext.Service
          const session = yield* Session.Service

          const info = yield* session.create({ title: "first" })
          yield* share.init()
          yield* Effect.sleep(50)
          const { db } = yield* Database.Service
          yield* db
            .insert(SessionShareTable)
            .values({
              session_id: info.id,
              id: "shr_abc",
              url: "https://legacy-share.example.com/share/abc",
              secret: "sec_123",
            })
            .run()
            .pipe(Effect.orDie)

          yield* events.publish(Session.Event.Diff, {
            sessionID: info.id,
            diff: [
              {
                file: "a.ts",
                patch:
                  "Index: a.ts\n===================================================================\n--- a.ts\t\n+++ a.ts\t\n@@ -1,1 +1,1 @@\n-one\n\\ No newline at end of file\n+two\n\\ No newline at end of file\n",
                additions: 1,
                deletions: 1,
                status: "modified",
              },
            ],
          })
          yield* events.publish(Session.Event.Diff, {
            sessionID: info.id,
            diff: [
              {
                file: "b.ts",
                patch:
                  "Index: b.ts\n===================================================================\n--- b.ts\t\n+++ b.ts\t\n@@ -1,1 +1,1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n",
                additions: 2,
                deletions: 0,
                status: "modified",
              },
            ],
          })
          yield* pollWithTimeout(
            Effect.sync(() => (seen.length === 1 ? true : undefined)),
            "timed out waiting for share sync",
            "5 seconds",
          )

          expect(seen).toHaveLength(1)
          expect(seen[0].url).toBe("https://legacy-share.example.com/api/share/shr_abc/sync")

          const body = JSON.parse(seen[0].body) as {
            secret: string
            data: Array<{
              type: string
              data: Array<{
                file: string
                patch: string
                additions: number
                deletions: number
                status?: string
              }>
            }>
          }
          expect(body.secret).toBe("sec_123")
          expect(body.data).toHaveLength(1)
          expect(body.data[0].type).toBe("session_diff")
          expect(body.data[0].data).toEqual([
            {
              file: "b.ts",
              patch:
                "Index: b.ts\n===================================================================\n--- b.ts\t\n+++ b.ts\t\n@@ -1,1 +1,1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n",
              additions: 2,
              deletions: 0,
              status: "modified",
            },
          ])
        }).pipe(Effect.provide(integrationLayer(client)))
      },
      { config: { enterprise: { url: "https://legacy-share.example.com" } } },
    ),
  )

  it.live("syncs host state and continuations without resolving provider models", () =>
    provideTmpdirInstance(
      () => {
        const seen: Array<{ url: string; body: string }> = []
        const client = HttpClient.make((req) => {
          if (req.url.endsWith("/sync") && req.body._tag === "Uint8Array") {
            seen.push({ url: req.url, body: new TextDecoder().decode(req.body.body) })
          }
          return Effect.succeed(json(req, { ok: true }))
        })
        const modelCalls: Array<[string, string]> = []
        const fakeProvider = ProviderTest.fake({
          getModel: Effect.fn("ShareNextTest.getModel")((providerID, modelID) => {
            modelCalls.push([providerID, modelID])
            return Effect.succeed(ProviderTest.model({ id: modelID, providerID }))
          }),
        })

        return Effect.gen(function* () {
          const events = yield* EventV2Bridge.Service
          const shareService = yield* ShareNext.Service
          const sessions = yield* Session.Service
          const info = yield* sessions.create({ title: "provenance share" })
          const { db } = yield* Database.Service
          yield* db
            .insert(SessionShareTable)
            .values({
              session_id: info.id,
              id: "shr_provenance",
              url: "https://legacy-share.example.com/share/provenance",
              secret: "sec_provenance",
            })
            .run()
            .pipe(Effect.orDie)

          yield* shareService.init()
          yield* Effect.sleep(25)

          const state = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            provenance: SessionTurnProvenance.host(SessionTurnProvenance.Source.GoalProgress, {
              ref: `goal-state:v1:progress:gol_share:${"d".repeat(64)}`,
            }),
            sessionID: info.id,
            agent: "build",
            model: { providerID: fakeProvider.model.providerID, modelID: fakeProvider.model.id },
            time: { created: Date.now() },
          })
          const continuation = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            provenance: SessionTurnProvenance.host(SessionTurnProvenance.Source.GoalContinuation, {
              sourceMessageID: MessageID.make("msg_share_worker_root"),
              ref: "reservation-share",
            }),
            sessionID: info.id,
            agent: "build",
            model: { providerID: fakeProvider.model.providerID, modelID: fakeProvider.model.id },
            time: { created: Date.now() + 1 },
          })

          yield* pollWithTimeout(
            Effect.sync(() => (seen.length === 1 ? true : undefined)),
            "timed out waiting for provenance share sync",
            "5 seconds",
          )

          expect(modelCalls).toEqual([])
          const body = JSON.parse(seen[0]!.body) as {
            data: Array<{ type: string; data: { id?: string; provenance?: unknown } }>
          }
          const messages = body.data.filter((item) => item.type === "message")
          expect(messages.map((item) => item.data.id).sort()).toEqual([state.id, continuation.id].sort())
          expect(messages.find((item) => item.data.id === state.id)?.data.provenance).toEqual(state.provenance)
          expect(messages.find((item) => item.data.id === continuation.id)?.data.provenance).toEqual(
            continuation.provenance,
          )

          // Keep the event service live through the assertions; listener
          // delivery is what proves this test exercised ShareNext's subscriber.
          void events
        }).pipe(Effect.provide(integrationLayer(client, fakeProvider.layer)))
      },
      { config: { enterprise: { url: "https://legacy-share.example.com" } } },
    ),
  )
})
