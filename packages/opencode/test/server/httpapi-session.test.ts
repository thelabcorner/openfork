import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { afterEach, describe, expect, spyOn } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import * as AppBackgroundJob from "../../src/background/job"
import * as SessionMetadataOwnership from "@opencode-ai/core/session/metadata-ownership"
import { GoalAutomation } from "@opencode-ai/core/goal/automation"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Cause, Config, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Flag } from "@opencode-ai/core/flag/flag"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { registerAdapter } from "../../src/control-plane/adapters"
import type { WorkspaceAdapter } from "../../src/control-plane/types"
import { Workspace } from "../../src/control-plane/workspace"

import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import * as HttpSessionError from "../../src/server/routes/instance/httpapi/handlers/session-errors"
import { ExperimentalPaths } from "../../src/server/routes/instance/httpapi/groups/experimental"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { SessionReadPaths } from "../../src/server/routes/instance/httpapi/groups/session-read"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { SessionOperatorRecovery } from "@/session/operator-stop"
import { PendingResponseRegistry } from "@/server/pending-response-registry"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Question } from "@/question"
import { Permission } from "@/permission"
import * as AutoAcceptPolicy from "@/permission/auto-accept-policy"
import { QuestionID } from "@/question/schema"
import { MessageID, PartID, SessionID, type SessionID as SessionIDType } from "../../src/session/schema"
import { Database } from "@opencode-ai/core/database/database"
import { PartTable, SessionInputTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionHistory } from "@opencode-ai/core/session/history"
import { SessionTelemetry } from "@opencode-ai/core/session/telemetry"
import { SessionLimitRecovery as Recovery } from "@opencode-ai/core/session/limit-recovery"
import * as CurrentParts from "@opencode-ai/core/session/current-parts"
import { SessionTurnProvenance as CurrentSessionTurnProvenance } from "@opencode-ai/core/session/turn-provenance"
import { SessionTurnProvenance as V1SessionTurnProvenance } from "@opencode-ai/core/v1/session-turn-provenance"
import { SessionTitle } from "@opencode-ai/core/session/title"
import { SpecialAgentSession } from "@opencode-ai/core/special-agent-session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import * as DateTime from "effect/DateTime"
import { eq } from "drizzle-orm"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, provideInstanceEffect, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { TestLLMServer, reply, httpError } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { pollWithTimeout, awaitWithTimeout, testEffect } from "../lib/effect"

const originalWorkspaces = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES
const noopBootstrapLayer = Layer.succeed(
  InstanceBootstrapService.Service,
  InstanceBootstrapService.Service.of({ gate: Effect.void, warmup: Effect.void }),
)
const appLayer = AppNodeBuilder.build(
  LayerNode.group([
    InstanceStore.node,
    Project.node,
    Session.node,
    Workspace.node,
    Database.node,
    SessionTelemetry.node,
    SessionExecutionOwner.node,
    GoalAutomation.node,
    SessionRunState.node,
    SessionOperatorRecovery.node,
    PendingResponseRegistry.node,
    Permission.node,
    EventV2Bridge.node,
    AppBackgroundJob.node,
    CurrentParts.node,
    Ripgrep.node,
  ]),
  [[InstanceStore.bootstrapNode, noopBootstrapLayer]],
)
const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  {
    disableListenLog: true,
    disableLogger: true,
  },
)
const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const it = testEffect(Layer.mergeAll(appLayer, httpApiLayer))

function pathFor(path: string, params: Record<string, string>) {
  return Object.entries(params).reduce((result, [key, value]) => result.replace(`:${key}`, value), path)
}

function createSession(input?: Session.CreateInput) {
  return Session.use.create(input)
}

function createTextMessage(sessionID: SessionIDType, text: string) {
  return Effect.gen(function* () {
    const svc = yield* Session.Service
    const info = yield* svc.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      time: { created: Date.now() },
    })
    const part = yield* svc.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: info.id,
      type: "text",
      text,
    })
    return { info, part }
  })
}

const localAdapter = (directory: string): WorkspaceAdapter => ({
  name: "Local Test",
  description: "Create a local test workspace",
  configure: (info) => ({ ...info, name: "local-test", directory }),
  create: async () => {
    await mkdir(directory, { recursive: true })
  },
  async remove() {},
  target: () => ({ type: "local" as const, directory }),
})

const createLocalWorkspace = (input: { projectID: Project.Info["id"]; type: string; directory: string }) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      registerAdapter(input.projectID, input.type, localAdapter(input.directory))
      return yield* Workspace.Service.use((svc) =>
        svc.create({
          type: input.type,
          branch: null,
          extra: null,
          projectID: input.projectID,
        }),
      )
    }),
    (info) => Workspace.use.remove(info.id).pipe(Effect.ignore),
  )

const insertLegacyAssistantMessage = (sessionID: SessionIDType, seq = 1, time = seq) =>
  Effect.gen(function* () {
    const message = SessionMessage.Assistant.make({
      id: SessionMessage.ID.create(),
      type: "assistant",
      agent: "build",
      model: {
        id: ModelV2.ID.make("model"),
        providerID: ProviderV2.ID.make("provider"),
        variant: ModelV2.VariantID.make("default"),
      },
      time: { created: DateTime.makeUnsafe(time) },
      content: [],
    })
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionMessageTable)
      .values([
        {
          id: message.id,
          session_id: sessionID,
          type: message.type,
          seq,
          time_created: time,
          data: {
            time: { created: time },
            agent: message.agent,
            model: message.model,
            content: message.content,
          } as NonNullable<(typeof SessionMessageTable.$inferInsert)["data"]>,
        },
      ])
      .run()
      .pipe(Effect.orDie)
    return message
  })

const insertCorruptV2Message = (sessionID: SessionIDType, time = 1) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionMessageTable)
      .values([
        {
          id: SessionMessage.ID.create(),
          session_id: sessionID,
          type: "assistant",
          seq: time,
          time_created: time,
          data: {} as NonNullable<(typeof SessionMessageTable.$inferInsert)["data"]>,
        },
      ])
      .run()
      .pipe(Effect.orDie)
  })

const setLegacySummaryDiff = (sessionID: SessionIDType) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .update(SessionTable)
      .set({
        summary_additions: 1,
        summary_deletions: 0,
        summary_files: 1,
        summary_diffs: [{ additions: 1, deletions: 0 }],
      })
      .where(eq(SessionTable.id, sessionID))
      .run()
      .pipe(Effect.orDie)
  })

const getWorkspaceID = (sessionID: SessionIDType) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select({ workspaceID: SessionTable.workspace_id })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
      .pipe(Effect.orDie)
  })

const clearSessionPath = (sessionID: SessionIDType) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.update(SessionTable).set({ path: null }).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
  })

function request(path: string, init?: RequestInit) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url, init)).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
  )
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  if (response.status !== 200) return response.text.pipe(Effect.flatMap((text) => Effect.die(new Error(text))))
  return response.json.pipe(Effect.map((value) => value as T))
}

function responseJson(response: HttpClientResponse.HttpClientResponse) {
  return response.json
}

function requestJson<T>(path: string, init?: RequestInit) {
  return request(path, init).pipe(Effect.flatMap(json<T>))
}

afterEach(async () => {
  Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = originalWorkspaces
  await disposeAllInstances()
  await resetDatabase()
})

describe("session HttpApi", () => {
  it.instance(
    "serves bootstrap-free generation-fenced limit recovery and publishes fork events",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession({ title: "limit recovery API" })
        const store = yield* InstanceStore.Service
        const load = spyOn(store, "load").mockImplementation(() => Effect.never as never)
        const { db } = yield* Database.Service
        const recovery = yield* Recovery.observeFailure(db, {
          sessionID: session.id,
          sourceAssistantMessageID: "msg_limit_api",
          providerID: "provider-test",
          modelID: "model-test",
          failureClass: "account-quota",
          resetAt: Date.now() + 60_000,
          resetSource: "retry-after",
          now: Date.now(),
        })
        const seen: string[] = []
        const events = yield* EventV2Bridge.Service
        const unsubscribe = yield* events.listen((event) =>
          Effect.sync(() => {
            seen.push(event.type)
          }),
        )
        yield* Effect.addFinalizer(() => unsubscribe)
        const path = `/session/${session.id}/limit-recovery`
        const snapshot = yield* requestJson<{ generation: number; autoResume: boolean }>(path)
        expect(snapshot).toMatchObject({ generation: recovery!.generation, autoResume: false })

        const auto = yield* request(`${path}/auto-resume`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ generation: recovery!.generation, enabled: true }),
        })
        expect(auto.status).toBe(200)
        expect(yield* responseJson(auto)).toMatchObject({ autoResume: true })

        const stale = yield* request(`${path}/wake`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ generation: recovery!.generation + 1 }),
        })
        expect(stale.status).toBe(409)

        const snooze = yield* request(`${path}/snooze-until-reset`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ generation: recovery!.generation }),
        })
        expect(snooze.status).toBe(200)
        const wake = yield* request(`${path}/wake`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ generation: recovery!.generation }),
        })
        expect(wake.status).toBe(200)
        const resume = yield* request(`${path}/resume`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ generation: recovery!.generation }),
        })
        expect(resume.status).toBe(200)
        expect(yield* responseJson(resume)).toMatchObject({ manualResume: true, autoResume: false })
        const cancel = yield* request(path, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ generation: recovery!.generation }),
        })
        expect(cancel.status).toBe(204)
        expect(yield* Recovery.get(db, session.id)).toBeUndefined()
        expect(seen).toContain("session.limit_recovery.updated")
        expect(seen).toContain("session.limit_recovery.cleared")
        expect(load).not.toHaveBeenCalled()
        load.mockRestore()
      }),
    { git: true, config: { formatter: false, lsp: false } },
    15_000,
  )

  it.live("admits V1 sessions for 1, 3, and 6 concurrent creates without loading an Instance", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ config: { share: "disabled" } })
      const store = yield* InstanceStore.Service
      const load = spyOn(store, "load").mockImplementation(() => Effect.never as never)
      let start = 0
      const created: Session.Info[] = []
      for (const count of [1, 3, 6]) {
        const results = yield* Effect.forEach(
          Array.from({ length: count }, (_, index) => index),
          (index) =>
            requestJson<Session.Info>(SessionPaths.create, {
              method: "POST",
              headers: {
                "x-opencode-directory": directory,
                "content-type": "application/json",
              },
              body: JSON.stringify({ title: `parallel admission ${start + index}` }),
            }),
          { concurrency: count },
        )
        expect(results.every((session) => session.id)).toBe(true)
        created.push(...results)
        start += count
      }
      expect(new Set(created.map((session) => session.id)).size).toBe(10)
      expect(load).not.toHaveBeenCalled()
      load.mockRestore()
    }),
  )

  it.live(
    "includes an in-flight V1 run in the process-wide active snapshot",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        yield* llm.hang

        const config = testProviderConfig(llm.url)
        const directory = yield* tmpdirScoped({ git: true, config })
        const session = yield* createSession({ title: "legacy active snapshot" }).pipe(provideInstanceEffect(directory))
        const headers = { "x-opencode-directory": directory }
        const prompt = yield* request(
          `${pathFor(SessionPaths.prompt, { sessionID: session.id })}?directory=${encodeURIComponent(directory)}`,
          {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({
              agent: "build",
              model: { providerID: "test", modelID: "test-model" },
              parts: [{ type: "text", text: "stay in flight" }],
            }),
          },
        ).pipe(Effect.forkChild)

        // The legacy processor has entered the provider stream, but this test
        // has never opened/hydrated the session through the renderer path.
        yield* llm.wait(1)

        const active = yield* requestJson<{
          data: Record<string, { type: "running" | "paused" }>
        }>("/api/session/active")
        expect(active.data[session.id]).toEqual({ type: "running" })

        // Cleanly terminate the deliberately hung provider request.
        const pause = yield* request(pathFor(SessionPaths.pause, { sessionID: session.id }), {
          method: "POST",
          headers,
        })
        expect(pause.status).toBe(204)
        yield* awaitWithTimeout(Fiber.await(prompt), "legacy prompt did not stop after pause", "10 seconds")
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
    30_000,
  )

  it.effect("maps busy sessions to public session busy errors", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.descending()
      const exit = yield* HttpSessionError.mapBusy(Effect.fail(new Session.BusyError({ sessionID }))).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({
          _tag: "SessionBusyError",
          sessionID,
          message: `Session is busy: ${sessionID}`,
        })
      }
    }),
  )

  it.instance(
    "returns declared not found errors for read routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const missingSession = SessionID.descending()
        const missingSessionBody = {
          name: "NotFoundError",
          data: { message: `Session not found: ${missingSession}` },
        }

        const get = yield* request(pathFor(SessionPaths.get, { sessionID: missingSession }), { headers })
        expect(get.status).toBe(404)
        expect(yield* responseJson(get)).toEqual(missingSessionBody)

        const children = yield* request(pathFor(SessionPaths.children, { sessionID: missingSession }), { headers })
        expect(children.status).toBe(404)
        expect(yield* responseJson(children)).toEqual(missingSessionBody)

        const todo = yield* request(pathFor(SessionPaths.todo, { sessionID: missingSession }), { headers })
        expect(todo.status).toBe(404)
        expect(yield* responseJson(todo)).toEqual(missingSessionBody)

        const messages = yield* request(pathFor(SessionPaths.messages, { sessionID: missingSession }), { headers })
        expect(messages.status).toBe(404)
        expect(yield* responseJson(messages)).toEqual(missingSessionBody)

        const remove = yield* request(pathFor(SessionPaths.remove, { sessionID: missingSession }), {
          headers,
          method: "DELETE",
        })
        expect(remove.status).toBe(404)
        expect(yield* responseJson(remove)).toEqual(missingSessionBody)

        const prompt = yield* request(pathFor(SessionPaths.prompt, { sessionID: missingSession }), {
          headers: { ...headers, "content-type": "application/json" },
          method: "POST",
          body: JSON.stringify({ agent: "build", noReply: true, parts: [{ type: "text", text: "hello" }] }),
        })
        expect(prompt.status).toBe(404)
        expect(yield* responseJson(prompt)).toEqual(missingSessionBody)

        const abort = yield* request(pathFor(SessionPaths.abort, { sessionID: missingSession }), {
          headers,
          method: "POST",
        })
        expect(abort.status).toBe(200)
        expect(yield* responseJson(abort)).toBe(true)

        const session = yield* createSession({ title: "missing message" })
        const missingMessage = MessageID.ascending()
        const message = yield* request(
          pathFor(SessionPaths.message, { sessionID: session.id, messageID: missingMessage }),
          { headers },
        )
        expect(message.status).toBe(404)
        expect(yield* responseJson(message)).toEqual({
          name: "NotFoundError",
          data: { message: `Message not found: ${missingMessage}` },
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves read routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const parent = yield* createSession({ title: "parent" })
        const child = yield* createSession({ title: "child", parentID: parent.id })
        const message = yield* createTextMessage(parent.id, "hello")
        yield* createTextMessage(parent.id, "world")

        const listed = yield* requestJson<Session.Info[]>(`${SessionPaths.list}?roots=true`, { headers })
        expect(listed.map((item) => item.id)).toContain(parent.id)
        expect(Object.hasOwn(listed[0]!, "parentID")).toBe(false)

        const v2RootPageResponse = yield* request(
          `/api/session?${new URLSearchParams({
            directory: test.directory,
            roots: "true",
            order: "desc",
            limit: "10",
          })}`,
          { headers },
        )
        expect(v2RootPageResponse.status).toBe(200)
        const v2RootPage = yield* json<{ data: Session.Info[]; cursor: { next?: string } }>(v2RootPageResponse)
        expect(v2RootPage.data.map((item) => item.id)).toContain(parent.id)
        expect(v2RootPage.data.map((item) => item.id)).not.toContain(child.id)
        expect(v2RootPage.data.every((item) => !item.parentID)).toBe(true)
        expect(v2RootPage.cursor.next).toBeTruthy()
        expect(JSON.parse(Buffer.from(v2RootPage.cursor.next!, "base64url").toString("utf8"))).toMatchObject({
          directory: test.directory,
          // Opaque cursors preserve the encoded query representation; parsing
          // the cursor through SessionsCursor decodes this back to boolean true.
          roots: "true",
          order: "desc",
        })

        expect(yield* requestJson<Record<string, unknown>>(SessionPaths.status, { headers })).toEqual({})

        expect(
          yield* requestJson<Session.Info>(pathFor(SessionPaths.get, { sessionID: parent.id }), { headers }),
        ).toMatchObject({ id: parent.id, title: "parent" })

        expect(
          (yield* requestJson<Session.Info[]>(pathFor(SessionPaths.children, { sessionID: parent.id }), {
            headers,
          })).map((item) => item.id),
        ).toEqual([child.id])

        expect(
          yield* requestJson<unknown[]>(pathFor(SessionPaths.todo, { sessionID: parent.id }), { headers }),
        ).toEqual([])

        expect(
          yield* requestJson<unknown[]>(pathFor(SessionPaths.diff, { sessionID: parent.id }), { headers }),
        ).toEqual([])

        const messages = yield* request(`${pathFor(SessionPaths.messages, { sessionID: parent.id })}?limit=1`, {
          headers,
        })
        const messagePage = yield* json<SessionV1.WithParts[]>(messages)
        const nextCursor = messages.headers["x-next-cursor"]
        expect(nextCursor).toBeTruthy()
        expect(messagePage[0]?.parts[0]).toMatchObject({ type: "text" })

        expect(
          (yield* request(`${pathFor(SessionPaths.messages, { sessionID: parent.id })}?before=${nextCursor}`, {
            headers,
          })).status,
        ).toBe(400)
        expect(
          (yield* request(`${pathFor(SessionPaths.messages, { sessionID: parent.id })}?limit=1&before=invalid`, {
            headers,
          })).status,
        ).toBe(400)

        expect(
          yield* requestJson<SessionV1.WithParts>(
            pathFor(SessionPaths.message, { sessionID: parent.id, messageID: message.info.id }),
            { headers },
          ),
        ).toMatchObject({ info: { id: message.info.id } })

        yield* insertLegacyAssistantMessage(parent.id)

        expect(
          (yield* requestJson<{ data: SessionMessage.Message[] }>(`/api/session/${parent.id}/message`, {
            headers,
          })).data,
        ).toMatchObject([{ type: "assistant" }])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.live("uses the persisted session directory for prompt requests", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      yield* llm.text("ok", { usage: { input: 1, output: 1 } })

      const config = testProviderConfig(llm.url)
      const sessionDirectory = yield* tmpdirScoped({ git: true, config })
      const requestDirectory = yield* tmpdirScoped({ git: true, config })
      const session = yield* createSession({ title: "directory regression" }).pipe(
        provideInstanceEffect(sessionDirectory),
      )

      const response = yield* request(
        `${pathFor(SessionPaths.prompt, { sessionID: session.id })}?directory=${encodeURIComponent(requestDirectory)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "which directory?" }],
          }),
        },
      )

      expect(response.status).toBe(200)
      yield* responseJson(response)

      const messages = yield* Session.use
        .messages({ sessionID: session.id })
        .pipe(provideInstanceEffect(sessionDirectory), Effect.orDie)
      const assistant = messages.find((message) => message.info.role === "assistant")
      expect(assistant?.info.role === "assistant" ? assistant.info.path : undefined).toEqual({
        cwd: sessionDirectory,
        root: sessionDirectory,
      })
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
  )

  it.live("persists validated agent and model selection through session PATCH without creating a prompt", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const config = testProviderConfig(llm.url)
      const directory = yield* tmpdirScoped({ git: true, config })
      const session = yield* createSession({ title: "selection patch" }).pipe(provideInstanceEffect(directory))
      const headers = { "x-opencode-directory": directory, "content-type": "application/json" }
      const path = pathFor(SessionPaths.update, { sessionID: session.id })

      const updated = yield* request(path, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          agent: "build",
          model: { providerID: "test", id: "test-model", variant: "default" },
        }),
      })
      expect(updated.status).toBe(200)
      const selected = (yield* responseJson(updated)) as Session.Info
      expect(selected.agent).toBe("build")
      expect(selected.model).toEqual({
        providerID: ProviderV2.ID.make("test"),
        id: ModelV2.ID.make("test-model"),
        variant: ModelV2.VariantID.make("default"),
      })

      // Selection is session state, not a synthetic conversation turn.
      expect(
        yield* Session.use.messages({ sessionID: session.id }).pipe(provideInstanceEffect(directory), Effect.orDie),
      ).toHaveLength(0)

      const invalid = yield* request(path, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          model: { providerID: "test", id: "missing-model", variant: "default" },
        }),
      })
      expect(invalid.status).toBe(400)

      const fetched = yield* request(pathFor(SessionPaths.get, { sessionID: session.id }), { headers })
      expect(fetched.status).toBe(200)
      const after = (yield* responseJson(fetched)) as Session.Info
      expect(after.agent).toBe("build")
      expect(after.model).toEqual({
        providerID: ProviderV2.ID.make("test"),
        id: ModelV2.ID.make("test-model"),
        variant: ModelV2.VariantID.make("default"),
      })
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
  )

  it.instance(
    "returns v2 public request errors for cursor and workspace query failures",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const session = yield* createSession({ title: "v2 cursor" })
        const firstMessage = yield* insertLegacyAssistantMessage(session.id, 1, 2)
        const secondMessage = yield* insertLegacyAssistantMessage(session.id, 2, 1)

        const sessionPage = yield* request(
          `/api/session?${new URLSearchParams({
            limit: "1",
            order: "asc",
            directory: test.directory,
            search: "v2",
          })}`,
          { headers },
        )
        const sessionCursor = (yield* json<{ data: Session.Info[]; cursor: { next?: string } }>(sessionPage)).cursor
          .next
        expect(sessionCursor).toBeTruthy()
        expect(JSON.parse(Buffer.from(sessionCursor!, "base64url").toString("utf8"))).toMatchObject({
          order: "asc",
          directory: test.directory,
          search: "v2",
          anchor: { id: session.id, direction: "next" },
        })

        const sessionNextPage = yield* request(`/api/session?cursor=${sessionCursor}`, { headers })
        expect(sessionNextPage.status).toBe(200)

        const invalidSessionCursor = yield* request(`/api/session?cursor=invalid`, { headers })
        expect(invalidSessionCursor.status).toBe(400)
        expect(yield* responseJson(invalidSessionCursor)).toMatchObject({
          _tag: "InvalidCursorError",
          message: "Invalid cursor",
        })

        const invalidWorkspace = yield* request(`/api/session?workspace=bad`, { headers })
        expect(invalidWorkspace.status).toBe(400)
        expect(yield* responseJson(invalidWorkspace)).toMatchObject({
          _tag: "InvalidRequestError",
          kind: "Query",
        })

        const messagePage = yield* request(`/api/session/${session.id}/message?limit=1`, { headers })
        const messageBody = yield* json<{ data: SessionMessage.Message[]; cursor: { next?: string } }>(messagePage)
        const messageCursor = messageBody.cursor.next
        expect(messageCursor).toBeTruthy()
        expect(messageBody.data.map((message) => message.id)).toEqual([secondMessage.id])
        expect(JSON.parse(Buffer.from(messageCursor!, "base64url").toString("utf8"))).toEqual({
          id: secondMessage.id,
          order: "desc",
          direction: "next",
        })

        const nextMessagePage = yield* request(`/api/session/${session.id}/message?cursor=${messageCursor}`, {
          headers,
        })
        expect(
          (yield* json<{ data: SessionMessage.Message[] }>(nextMessagePage)).data.map((message) => message.id),
        ).toEqual([firstMessage.id])

        const legacyMessageCursor = Buffer.from(
          JSON.stringify({ id: secondMessage.id, time: 1, order: "desc", direction: "next" }),
        ).toString("base64url")
        const legacyMessagePage = yield* request(`/api/session/${session.id}/message?cursor=${legacyMessageCursor}`, {
          headers,
        })
        expect(
          (yield* json<{ data: SessionMessage.Message[] }>(legacyMessagePage)).data.map((message) => message.id),
        ).toEqual([firstMessage.id])

        const messageCursorWithOrder = yield* request(
          `/api/session/${session.id}/message?cursor=${messageCursor}&order=asc`,
          { headers },
        )
        expect(messageCursorWithOrder.status).toBe(400)
        expect(yield* responseJson(messageCursorWithOrder)).toMatchObject({
          _tag: "InvalidCursorError",
          message: "Cursor cannot be combined with order",
        })

        const invalidMessageCursor = yield* request(`/api/session/${session.id}/message?cursor=invalid`, { headers })
        expect(invalidMessageCursor.status).toBe(400)
        expect(yield* responseJson(invalidMessageCursor)).toMatchObject({
          _tag: "InvalidCursorError",
          message: "Invalid cursor",
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "returns v2 public not found errors for missing sessions",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const missing = SessionID.descending()
        const expected = {
          _tag: "SessionNotFoundError",
          sessionID: missing,
          message: `Session not found: ${missing}`,
        }

        const messages = yield* request(`/api/session/${missing}/message`, { headers })
        expect(messages.status).toBe(404)
        expect(yield* responseJson(messages)).toEqual(expected)

        const context = yield* request(`/api/session/${missing}/context`, { headers })
        expect(context.status).toBe(404)
        expect(yield* responseJson(context)).toEqual(expected)

        const compact = yield* request(`/api/session/${missing}/compact`, { method: "POST", headers })
        expect(compact.status).toBe(404)
        expect(yield* responseJson(compact)).toEqual(expected)

        const wait = yield* request(`/api/session/${missing}/wait`, { method: "POST", headers })
        expect(wait.status).toBe(404)
        expect(yield* responseJson(wait)).toEqual(expected)

        const prompt = yield* request(`/api/session/${missing}/prompt`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ prompt: { text: "hello" } }),
        })
        expect(prompt.status).toBe(404)
        expect(yield* responseJson(prompt)).toEqual(expected)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "durably records one v2 prompt for exact message-ID retries",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const session = yield* createSession({ title: "v2 prompt recording" })

        const recordPrompt = () =>
          request(`/api/session/${session.id}/prompt`, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ id: "msg_http_prompt", prompt: { text: "hello" }, resume: false }),
          })
        const first = yield* recordPrompt()
        const retried = yield* recordPrompt()
        type PromptBody = { id: string; prompt: { text: string }; delivery: string; promotedSeq?: number }
        const firstBody = yield* json<{ data: PromptBody }>(first)
        const retriedBody = yield* json<{ data: PromptBody }>(retried)
        expect(first.status).toBe(200)
        expect(retried.status).toBe(200)
        expect(retriedBody).toEqual(firstBody)
        expect(firstBody).toMatchObject({
          data: { id: "msg_http_prompt", prompt: { text: "hello" }, delivery: "steer" },
        })

        const messages = yield* requestJson<{ data: PromptBody[] }>(`/api/session/${session.id}/message`, {
          headers,
        })
        expect(messages.data).toHaveLength(0)
        const admitted = yield* Database.Service.use(({ db }) =>
          db
            .select()
            .from(SessionInputTable)
            .where(eq(SessionInputTable.id, SessionMessage.ID.make("msg_http_prompt")))
            .get()
            .pipe(Effect.orDie),
        )
        expect(admitted).toMatchObject({
          id: "msg_http_prompt",
          session_id: session.id,
          delivery: "steer",
          promoted_seq: null,
        })
        const conflict = yield* request(`/api/session/${session.id}/prompt`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ id: "msg_http_prompt", prompt: { text: "goodbye" } }),
        })
        expect(conflict.status).toBe(409)
        expect(yield* responseJson(conflict)).toEqual({
          _tag: "ConflictError",
          message: "Prompt message ID conflicts with an existing durable record: msg_http_prompt",
          resource: "msg_http_prompt",
        })

        const wakeID = SessionMessage.ID.make("msg_http_wake")
        const wake = yield* request(`/api/session/${session.id}/prompt`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ id: wakeID, prompt: { text: "hello again" } }),
        })
        expect(wake.status).toBe(200)
        const message = yield* pollWithTimeout(
          requestJson<{ data: SessionMessage.Message[] }>(`/api/session/${session.id}/message`, { headers }).pipe(
            Effect.map(({ data }) => data.find((message) => message.id === wakeID)),
          ),
          "V2 prompt was not promoted after wake",
          "10 seconds",
        )
        expect(message).toMatchObject({ id: wakeID, type: "user" })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "returns v2 public unavailable errors for unfinished session mutations",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const session = yield* createSession({ title: "v2 unavailable" })

        const compact = yield* request(`/api/session/${session.id}/compact`, { method: "POST", headers })
        expect(compact.status).toBe(503)
        expect(yield* responseJson(compact)).toEqual({
          _tag: "ServiceUnavailableError",
          message: "Session compact is not available yet",
          service: "session.compact",
        })

        const wait = yield* request(`/api/session/${session.id}/wait`, { method: "POST", headers })
        expect(wait.status).toBe(503)
        expect(yield* responseJson(wait)).toEqual({
          _tag: "ServiceUnavailableError",
          message: "Session wait is not available yet",
          service: "session.wait",
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "keeps V1 producer-owned Sessions outside the current public mutation and control surface",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const owned = yield* createSession({
          title: "cross-generation scheduled run",
          metadata: { scheduledTaskID: "stk_v2_fence", scheduledTaskRunID: "str_v2_fence" },
        })
        const seeded = yield* createTextMessage(owned.id, "producer-owned transcript")

        // Current/Core deliberately does not surface the V1 compatibility
        // metadata bag, but the public mutation boundary must still consume its
        // canonical producer-ownership projection from the shared durable row.
        const readable = yield* request(`/api/session/${owned.id}`, { headers })
        expect(readable.status).toBe(200)
        const currentInfo = (yield* responseJson(readable)) as { data: Record<string, unknown> }
        expect(currentInfo.data).toMatchObject({ id: owned.id, title: "cross-generation scheduled run" })
        expect(Object.hasOwn(currentInfo.data, "metadata")).toBe(false)

        const blocked = [
          { name: "switchAgent", path: `/api/session/${owned.id}/agent`, body: { agent: "build" } },
          {
            name: "switchModel",
            path: `/api/session/${owned.id}/model`,
            body: { model: { providerID: "test", id: "test-model" } },
          },
          {
            name: "prompt",
            path: `/api/session/${owned.id}/prompt`,
            body: { prompt: { text: "public takeover" }, resume: false },
          },
          { name: "compact", path: `/api/session/${owned.id}/compact` },
          {
            name: "revert.stage",
            path: `/api/session/${owned.id}/revert/stage`,
            body: { messageID: seeded.info.id },
          },
          { name: "revert.clear", path: `/api/session/${owned.id}/revert/clear` },
          { name: "revert.commit", path: `/api/session/${owned.id}/revert/commit` },
          { name: "interrupt", path: `/api/session/${owned.id}/interrupt` },
          { name: "pause", path: `/api/session/${owned.id}/pause` },
          { name: "resume", path: `/api/session/${owned.id}/resume` },
          { name: "regenerateTitle", path: `/api/session/${owned.id}/title/regenerate`, body: {} },
          {
            name: "permission.create",
            path: `/api/session/${owned.id}/permission`,
            body: { action: "shell", resources: ["*"] },
          },
          {
            name: "checkpoint.revert",
            path: `/api/session/${owned.id}/checkpoint/cp_public_takeover/revert`,
            body: {},
          },
          { name: "checkpoint.create", path: `/api/session/${owned.id}/checkpoint`, body: { kind: "manual" } },
        ] as const

        for (const operation of blocked) {
          const response = yield* request(operation.path, {
            method: "POST",
            headers,
            ...("body" in operation ? { body: JSON.stringify(operation.body) } : {}),
          })
          expect(response.status, operation.name).toBe(400)
          expect(yield* responseJson(response), operation.name).toMatchObject({ _tag: "InvalidRequestError" })
        }

        const { readDb } = yield* Database.Service
        const durable = yield* readDb
          .select({ title: SessionTable.title, metadata: SessionTable.metadata, pausedAt: SessionTable.paused_at })
          .from(SessionTable)
          .where(eq(SessionTable.id, owned.id))
          .get()
          .pipe(Effect.orDie)
        expect(durable).toEqual({
          title: "cross-generation scheduled run",
          metadata: { scheduledTaskID: "stk_v2_fence", scheduledTaskRunID: "str_v2_fence" },
          pausedAt: null,
        })
        expect(
          yield* readDb
            .select()
            .from(SessionInputTable)
            .where(eq(SessionInputTable.session_id, owned.id))
            .all()
            .pipe(Effect.orDie),
        ).toHaveLength(0)
        const stored = (yield* Session.Service.use((svc) => svc.messages({ sessionID: owned.id }))).find(
          (message) => message.info.id === seeded.info.id,
        )
        expect(stored?.parts).toMatchObject([{ id: seeded.part.id, text: "producer-owned transcript" }])

        const parent = yield* createSession({ title: "current public parent" })
        const child = yield* createSession({ title: "current public child", parentID: parent.id })
        const childPrompt = yield* request(`/api/session/${child.id}/prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: { text: "do not bypass parent authority" }, resume: false }),
        })
        expect(childPrompt.status).toBe(400)
        expect(yield* responseJson(childPrompt)).toMatchObject({ _tag: "InvalidRequestError" })
      }),
    { git: true, config: { formatter: false, lsp: false } },
    20_000,
  )

  it.live(
    "model-switch rejects unsupported reasoning variants but accepts a valid model up to the live-attempt fence",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const base = testProviderConfig(llm.url)
        const config = {
          ...base,
          provider: {
            test: {
              ...base.provider.test,
              models: {
                "test-model": {
                  ...base.provider.test.models["test-model"],
                  variants: { high: {} },
                },
              },
            },
          },
        }
        const directory = yield* tmpdirScoped({ git: true, config })
        const session = yield* createSession({ title: "switch variant validation" }).pipe(
          provideInstanceEffect(directory),
        )
        const route = `${pathFor(SessionPaths.switchModel, { sessionID: session.id })}?directory=${encodeURIComponent(directory)}`
        const headers = { "x-opencode-directory": directory, "content-type": "application/json" }
        const payload = {
          assistantMessageID: MessageID.ascending(),
          requestSentAt: Date.now(),
          providerID: "test",
          modelID: "test-model",
        }
        const unsupported = yield* request(route, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...payload, variant: "ultra" }),
        })
        expect(unsupported.status).toBe(400)
        expect(yield* responseJson(unsupported)).toMatchObject({
          _tag: "InvalidRequestError",
          kind: "model",
          field: "variant",
        })

        const defaultVariant = yield* request(route, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...payload, variant: "default" }),
        })
        // No provider attempt is active. This must pass model validation, then
        // fail the exact-attempt conflict fence without queuing any continuation.
        expect(defaultVariant.status).toBe(409)
        const { db } = yield* Database.Service
        const queued = yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.session_id, session.id)).all()
        expect(queued).toHaveLength(0)
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
    40_000,
  )

  it.instance(
    "model-switch validates conversational ownership before model selection with actionable errors",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const parent = yield* createSession({ title: "model switch parent" })
        const scheduled = yield* createSession({
          title: "model switch scheduled run",
          metadata: { scheduledTaskID: "stk_model_switch", scheduledTaskRunID: "str_model_switch" },
        })
        const child = yield* createSession({ title: "model switch child", parentID: parent.id })
        const call = (sessionID: SessionIDType) =>
          request(pathFor(SessionPaths.switchModel, { sessionID }), {
            method: "POST",
            headers,
            body: JSON.stringify({
              assistantMessageID: MessageID.ascending(),
              requestSentAt: Date.now(),
              providerID: "missing-provider",
              modelID: "missing-model",
            }),
          })

        for (const sessionID of [parent.id, scheduled.id]) {
          const response = yield* call(sessionID)
          expect(response.status).toBe(400)
          expect(yield* responseJson(response)).toMatchObject({
            _tag: "InvalidRequestError",
            kind: "model",
            field: "modelID",
          })
        }

        const blocked = yield* call(child.id)
        expect(blocked.status).toBe(400)
        expect(yield* responseJson(blocked)).toMatchObject({
          _tag: "InvalidRequestError",
          kind: "child",
          message: "This worker's model selection is managed by its owning controller and cannot be switched here.",
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
    30_000,
  )

  it.instance(
    "returns safe v2 unknown errors for corrupt projected messages",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession({ title: "v2 corrupt message" })
        yield* insertCorruptV2Message(session.id)

        const messages = yield* request(`/api/session/${session.id}/message`, {
          headers: { "x-opencode-directory": test.directory },
        })
        const messagesBody = yield* responseJson(messages)
        expect(messages.status).toBe(500)
        expect(messagesBody).toMatchObject({
          _tag: "UnknownError",
          message: "Unexpected server error. Check server logs for details.",
        })
        expect((messagesBody as { ref?: unknown }).ref).toMatch(/^err_[0-9a-f-]{8}$/)
        expect(JSON.stringify(messagesBody)).not.toContain("assistant")

        const context = yield* request(`/api/session/${session.id}/context`, {
          headers: { "x-opencode-directory": test.directory },
        })
        const contextBody = yield* responseJson(context)
        expect(context.status).toBe(500)
        expect(contextBody).toMatchObject({
          _tag: "UnknownError",
          message: "Unexpected server error. Check server logs for details.",
        })
        expect((contextBody as { ref?: unknown }).ref).toMatch(/^err_[0-9a-f-]{8}$/)
        expect(JSON.stringify(contextBody)).not.toContain("assistant")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "aborts an active V1 handle without loading or waiting for an Instance",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const runState = yield* SessionRunState.Service
        const owner = yield* SessionExecutionOwner.Service
        const store = yield* InstanceStore.Service
        const session = yield* createSession({ title: "bootstrap-free abort" })
        const running = yield* runState
          .ensureRunning(session.id, Effect.succeed({} as SessionV1.WithParts), Effect.never)
          .pipe(Effect.forkChild)
        yield* Effect.sleep("50 millis")

        const load = spyOn(store, "load")
        const response = yield* request(pathFor(SessionPaths.abort, { sessionID: session.id }), {
          method: "POST",
          headers: { "x-opencode-directory": test.directory },
        })
        expect(response.status).toBe(200)
        expect(yield* responseJson(response)).toBe(true)
        expect(load).not.toHaveBeenCalled()
        load.mockRestore()

        yield* Fiber.await(running)
        expect((yield* owner.snapshot(session.id)).ownerID).toBeUndefined()
      }),
    { git: true, config: { formatter: false, lsp: false } },
    15_000,
  )

  it.instance(
    "surfaces and stops an orphaned same-process generation with an unresolved tool effect",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const owner = yield* SessionExecutionOwner.Service
        const sessions = yield* Session.Service
        const { db } = yield* Database.Service
        const session = yield* createSession({ title: "orphaned tool recovery" })
        const user = yield* createTextMessage(session.id, "run the tool")
        const assistant = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "assistant",
          parentID: user.info.id,
          modelID: ModelV2.ID.make("test"),
          providerID: ProviderV2.ID.make("test"),
          mode: "build",
          agent: "build",
          path: { cwd: test.directory, root: test.directory },
          time: { created: Date.now() },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        })
        const part = yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: assistant.id,
          type: "tool",
          callID: "call_interrupted_tool",
          tool: "bash",
          state: { status: "running", input: { command: "unknown external effect" }, time: { start: Date.now() } },
        })

        // Acquire through the durable owner API without registering a local
        // Runner activation, reproducing a same-process orphaned generation.
        const acquired = yield* owner.tryAcquire(session.id)
        expect(acquired.state).toBe("acquired")
        if (acquired.state !== "acquired") return

        const headers = { "x-opencode-directory": test.directory }
        const status = yield* request(`/session/status?directory=${encodeURIComponent(test.directory)}`)
        expect(status.status).toBe(200)
        expect(yield* responseJson(status)).toMatchObject({ [session.id]: { type: "interrupted" } })

        const stopped = yield* request(pathFor(SessionPaths.abort, { sessionID: session.id }), {
          method: "POST",
          headers,
        })
        expect(stopped.status).toBe(200)
        expect(yield* responseJson(stopped)).toBe(true)
        expect((yield* owner.snapshot(session.id)).ownerID).toBeUndefined()
        expect((yield* sessions.get(session.id)).pausedAt).toBeDefined()
        const repaired = yield* db.select().from(PartTable).where(eq(PartTable.id, part.id)).get().pipe(Effect.orDie)
        expect(repaired?.data.state).toMatchObject({ status: "error", metadata: { interrupted: true } })
      }),
    { git: true, config: { formatter: false, lsp: false } },
    15_000,
  )

  it.instance(
    "returns false instead of reporting successful abort when the observed live owner cannot be quiesced",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const owner = yield* SessionExecutionOwner.Service
        const recovery = yield* SessionOperatorRecovery.Service
        const session = yield* createSession({ title: "live-owner abort refuses false success" })
        const acquired = yield* owner.tryAcquire(session.id)
        expect(acquired.state).toBe("acquired")
        if (acquired.state !== "acquired") return
        yield* Effect.addFinalizer(() => owner.release(acquired.token).pipe(Effect.asVoid))

        const restore = spyOn(recovery, "recover").mockImplementation(() => Effect.succeed("live"))
        yield* Effect.addFinalizer(() => Effect.sync(() => restore.mockRestore()))
        const stopped = yield* request(pathFor(SessionPaths.abort, { sessionID: session.id }), {
          method: "POST",
          headers: { "x-opencode-directory": test.directory },
        })
        expect(stopped.status).toBe(200)
        expect(yield* responseJson(stopped)).toBe(false)
        const after = yield* owner.snapshot(session.id)
        expect(after.ownerID).toBe(acquired.token.ownerID)
        expect(after.generation).toBe(acquired.token.generation)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    15_000,
  )

  it.instance(
    "answers active pending-response handles over HTTP without loading an Instance",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const store = yield* InstanceStore.Service
        const registry = yield* PendingResponseRegistry.Service
        const settled = new Set<string>()
        const unregister = [] as Array<Effect.Effect<void>>
        const ids = Array.from({ length: 10 }, (_, index) => `question_control_${index + 1}`)
        for (const id of ids) {
          unregister.push(
            yield* registry.register({
              kind: "question",
              requestID: id,
              sessionID: SessionID.make(`ses_${id}`),
              directory: FSUtil.resolve(test.directory),
              snapshot: { id, sessionID: SessionID.make(`ses_${id}`), questions: [] },
              settle: () =>
                Effect.sync(() => {
                  settled.add(id)
                }),
            }),
          )
        }
        yield* Effect.addFinalizer(() => Effect.forEach(unregister, (remove) => remove, { discard: true }))
        const load = spyOn(store, "load").mockImplementation(() => Effect.never as never)
        try {
          let start = 0
          for (const count of [1, 3, 6]) {
            const group = ids.slice(start, start + count)
            const responses = yield* Effect.forEach(
              group,
              (requestID) =>
                request(`/question/${requestID}/reject`, {
                  method: "POST",
                  headers: { "x-opencode-directory": test.directory },
                }),
              { concurrency: count },
            )
            expect(responses.map((response) => response.status)).toEqual(Array.from({ length: count }, () => 200))
            expect(yield* Effect.forEach(responses, responseJson)).toEqual(Array.from({ length: count }, () => true))
            start += count
          }
          expect(settled.size).toBe(10)
          expect(load).not.toHaveBeenCalled()

          const literalPercentDirectory = `${test.directory}_literal%2Fdirectory`
          const removePercent = yield* registry.register({
            kind: "question",
            requestID: "question_control_percent",
            sessionID: SessionID.make("ses_question_control_percent"),
            directory: FSUtil.resolve(literalPercentDirectory),
            snapshot: {
              id: "question_control_percent",
              sessionID: SessionID.make("ses_question_control_percent"),
              questions: [],
            },
            settle: () =>
              Effect.sync(() => {
                settled.add("question_control_percent")
              }),
          })
          yield* Effect.addFinalizer(() => removePercent)
          const wrongPercentResponse = yield* request("/question/question_control_percent/reject", {
            method: "POST",
            headers: { "x-opencode-directory": `${test.directory}_wrong` },
          })
          expect(wrongPercentResponse.status).toBe(404)
          const queryFenceResponse = yield* request(
            `/question/question_control_percent/reject?directory=${encodeURIComponent(test.directory)}`,
            { method: "POST", headers: { "x-opencode-directory": literalPercentDirectory } },
          )
          expect(queryFenceResponse.status).toBe(404)
          const percentResponse = yield* request("/question/question_control_percent/reject", {
            method: "POST",
            headers: { "x-opencode-directory": literalPercentDirectory },
          })
          expect(percentResponse.status).toBe(200)
          expect(yield* responseJson(percentResponse)).toBe(true)
          expect(load).not.toHaveBeenCalled()
        } finally {
          load.mockRestore()
        }
      }),
    { git: true, config: { formatter: false, lsp: false } },
    15_000,
  )

  it.instance(
    "overflowed transient notifications publish an invalidation and the active snapshot repairs state",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const registry = yield* PendingResponseRegistry.Service
        const events = yield* EventV2Bridge.Service
        const store = yield* InstanceStore.Service
        const load = spyOn(store, "load").mockImplementation(() => Effect.never as never)
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const invalidated = yield* Deferred.make<void>()
        let blockOnce = true
        const unsubscribe = yield* events.listen((event) => {
          if (event.type === Question.Event.Rejected.type && blockOnce) {
            blockOnce = false
            return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
          }
          if (event.type === "server.pending-response-state-invalidated")
            return Deferred.succeed(invalidated, undefined)
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsubscribe)

        const id = "question_overflow_active"
        const sessionID = SessionID.make("ses_question_overflow_active")
        const unregister = yield* registry.register({
          kind: "question",
          requestID: id,
          sessionID,
          directory: FSUtil.resolve(test.directory),
          snapshot: { id, sessionID, questions: [{ question: "Continue?", header: "Action", options: [] }] },
          settle: () => Effect.void,
        })
        yield* Effect.addFinalizer(() => unregister)

        yield* registry.notify(
          events.publish(Question.Event.Rejected, { sessionID, requestID: QuestionID.make("que_worker_blocker") }),
          FSUtil.resolve(test.directory),
        )
        yield* Deferred.await(entered).pipe(Effect.timeout("2 seconds"))
        for (let index = 0; index < 129; index++) yield* registry.notify(Effect.void, FSUtil.resolve(test.directory))
        yield* Deferred.succeed(release, undefined)
        yield* Deferred.await(invalidated).pipe(Effect.timeout("5 seconds"))

        const response = yield* request("/question", { headers: { "x-opencode-directory": test.directory } })
        expect(response.status).toBe(200)
        expect(yield* responseJson(response)).toEqual([
          { id, sessionID, questions: [{ question: "Continue?", header: "Action", options: [] }] },
        ])
        expect(load).not.toHaveBeenCalled()
        load.mockRestore()
      }),
    { git: true, config: { formatter: false, lsp: false } },
    15_000,
  )

  it.instance(
    "cancels 1, 3, and 6 active V1 sessions over HTTP while Instance bootstrap is blocked",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const runState = yield* SessionRunState.Service
        const store = yield* InstanceStore.Service
        const owner = yield* SessionExecutionOwner.Service
        const sessions = yield* Effect.forEach(Array.from({ length: 10 }), (_, index) =>
          createSession({ title: `parallel abort ${index}` }),
        )
        const fibers = [] as Fiber.Fiber<unknown, unknown>[]
        for (const session of sessions) {
          fibers.push(
            yield* runState
              .ensureRunning(session.id, Effect.succeed({} as SessionV1.WithParts), Effect.never)
              .pipe(Effect.forkChild),
          )
        }
        yield* Effect.sleep("50 millis")
        for (const session of sessions) expect((yield* owner.snapshot(session.id)).ownerID).toBeTruthy()

        // Any accidental transition back through InstanceContext now blocks
        // forever; the control route must finish using only durable owners.
        const load = spyOn(store, "load").mockImplementation(() => Effect.never as never)
        let start = 0
        for (const count of [1, 3, 6]) {
          const group = sessions.slice(start, start + count)
          const responses = yield* Effect.forEach(
            group,
            (session) =>
              request(pathFor(SessionPaths.abort, { sessionID: session.id }), {
                method: "POST",
                headers: { "x-opencode-directory": test.directory },
              }),
            { concurrency: count },
          )
          expect(responses.map((response) => response.status)).toEqual(Array.from({ length: count }, () => 200))
          expect(yield* Effect.forEach(responses, responseJson)).toEqual(Array.from({ length: count }, () => true))
          start += count
        }
        expect(load).not.toHaveBeenCalled()
        load.mockRestore()
        yield* Effect.forEach(fibers, (fiber) => Fiber.await(fiber), { concurrency: 8 })
      }),
    { git: true, config: { formatter: false, lsp: false } },
    15_000,
  )

  it.instance(
    "aborts an orphaned session-owned BackgroundJob without loading an Instance",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const store = yield* InstanceStore.Service
        const session = yield* createSession({ title: "orphaned background task" })
        const job = yield* AppBackgroundJob.Service.use((jobs) =>
          jobs.start({
            id: `job_${session.id}`,
            type: "test-orphan",
            metadata: { sessionId: session.id },
            run: Effect.never,
          }),
        ).pipe(provideInstanceEffect(test.directory))
        const load = spyOn(store, "load").mockImplementation(() => Effect.never as never)

        const response = yield* request(pathFor(SessionPaths.abort, { sessionID: session.id }), {
          method: "POST",
          headers: { "x-opencode-directory": test.directory },
        })

        expect(response.status).toBe(200)
        expect(yield* responseJson(response)).toBe(true)
        expect(load).not.toHaveBeenCalled()
        load.mockRestore()
        expect(
          yield* AppBackgroundJob.Service.use((jobs) => jobs.get(job.id)).pipe(provideInstanceEffect(test.directory)),
        ).toMatchObject({ status: "cancelled" })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "does not let a delayed stale abort cancel a newer session generation",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const runState = yield* SessionRunState.Service
        const owner = yield* SessionExecutionOwner.Service
        const automation = yield* GoalAutomation.Service
        const session = yield* createSession({ title: "stale abort fence" })
        const running = yield* runState
          .ensureRunning(session.id, Effect.succeed({} as SessionV1.WithParts), Effect.never)
          .pipe(Effect.forkChild)
        yield* Effect.sleep("30 millis")
        const previous = yield* owner.snapshot(session.id)
        expect(previous.ownerID).toBeTruthy()

        const entered = yield* Deferred.make<void>()
        const resume = yield* Deferred.make<void>()
        const cancelAutomation = spyOn(automation, "cancel")
        const requestInterrupt = owner.requestInterrupt
        const delayed = spyOn(owner, "requestInterrupt").mockImplementation((id, reason, generation) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(resume)),
            Effect.andThen(requestInterrupt(id, reason, generation)),
          ),
        )
        const abort = yield* request(pathFor(SessionPaths.abort, { sessionID: session.id }), {
          method: "POST",
          headers: { "x-opencode-directory": test.directory },
        }).pipe(Effect.forkChild)
        yield* Deferred.await(entered).pipe(Effect.timeout("2 seconds"))

        yield* owner.release({
          sessionID: session.id,
          ownerID: previous.ownerID!,
          generation: previous.generation,
        })
        const acquired = yield* owner.tryAcquireLocal(session.id)
        expect(acquired.state).toBe("acquired")
        if (acquired.state !== "acquired") return

        const { db } = yield* Database.Service
        const newerRecovery = yield* Recovery.observeFailure(db, {
          sessionID: session.id,
          sourceAssistantMessageID: "msg_newer_generation_recovery",
          providerID: "test",
          modelID: "test-model",
          failureClass: "account-quota",
          resetAt: Date.now() + 60000,
          resetSource: "retry-after",
          now: Date.now(),
        })

        yield* Deferred.succeed(resume, undefined)
        const response = yield* Fiber.join(abort).pipe(Effect.timeout("2 seconds"))
        delayed.mockRestore()
        expect(response.status).toBe(200)
        expect(yield* responseJson(response)).toBe(false)
        const current = yield* owner.snapshot(session.id)
        expect(current.ownerID).toBe(acquired.token.ownerID)
        expect(current.generation).toBe(acquired.token.generation)
        expect(cancelAutomation).not.toHaveBeenCalled()
        expect((yield* Recovery.get(db, session.id))?.generation).toBe(newerRecovery.generation)
        cancelAutomation.mockRestore()

        yield* owner.release(acquired.token)
        yield* runState.cancel(session.id)
        yield* Fiber.await(running)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    15_000,
  )

  it.instance(
    "rejects abort for producer-owned sessions without canceling their active owner",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const runState = yield* SessionRunState.Service
        const owner = yield* SessionExecutionOwner.Service
        const session = yield* createSession({ title: "producer-owned abort" })
        const metadata = SessionMetadataOwnership.specialAgent({
          agent: "test-owner",
          ownerKind: "goal",
          ownerID: "goal_test",
        })
        const { db } = yield* Database.Service
        yield* db.update(SessionTable).set({ metadata }).where(eq(SessionTable.id, session.id)).run().pipe(Effect.orDie)
        expect(SessionMetadataOwnership.isProducerOwned(metadata)).toBe(true)
        const running = yield* runState
          .ensureRunning(session.id, Effect.succeed({} as SessionV1.WithParts), Effect.never)
          .pipe(Effect.forkChild)
        yield* Effect.sleep("30 millis")
        const before = yield* owner.snapshot(session.id)
        const response = yield* request(pathFor(SessionPaths.abort, { sessionID: session.id }), {
          method: "POST",
          headers: { "x-opencode-directory": test.directory },
        })
        expect(response.status).toBe(400)
        expect((yield* owner.snapshot(session.id)).generation).toBe(before.generation)
        expect((yield* owner.snapshot(session.id)).ownerID).toBe(before.ownerID)
        yield* runState.cancel(session.id)
        yield* Fiber.await(running)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves sessions with migrated summary diffs missing file details",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession({ title: "legacy diff" })
        yield* setLegacySummaryDiff(session.id)

        const response = yield* request(pathFor(SessionPaths.get, { sessionID: session.id }), {
          headers: { "x-opencode-directory": test.directory },
        })

        expect(response.status).toBe(200)
        expect((yield* json<Session.Info>(response)).summary?.diffs).toEqual([{ additions: 1, deletions: 0 }])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves lifecycle mutation routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }

        const createdEmpty = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
        })
        expect(createdEmpty.id).toBeTruthy()

        const createdWhitespace = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
          body: "  \n\t",
        })
        expect(createdWhitespace.id).toBeTruthy()

        const invalidCreate = yield* request(SessionPaths.create, {
          method: "POST",
          headers,
          body: "{",
        })
        expect(invalidCreate.status).toBe(400)

        const created = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "created" }),
        })
        expect(created.title).toBe("created")

        const updated = yield* requestJson<Session.Info>(pathFor(SessionPaths.update, { sessionID: created.id }), {
          method: "PATCH",
          headers,
          body: JSON.stringify({ title: "updated", time: { archived: 1 } }),
        })
        expect(updated).toMatchObject({ id: created.id, title: "updated", time: { archived: 1 } })

        const forked = yield* requestJson<Session.Info>(pathFor(SessionPaths.fork, { sessionID: created.id }), {
          method: "POST",
          headers,
        })
        expect(forked.id).not.toBe(created.id)

        const forkedWithoutContentType = yield* requestJson<Session.Info>(
          pathFor(SessionPaths.fork, { sessionID: created.id }),
          {
            method: "POST",
            headers: { "x-opencode-directory": test.directory },
          },
        )
        expect(forkedWithoutContentType.id).not.toBe(created.id)

        const invalidFork = yield* request(pathFor(SessionPaths.fork, { sessionID: created.id }), {
          method: "POST",
          headers,
          body: "{",
        })
        expect(invalidFork.status).toBe(400)

        const forkedWhitespace = yield* requestJson<Session.Info>(
          pathFor(SessionPaths.fork, { sessionID: created.id }),
          {
            method: "POST",
            headers,
            body: "  \n",
          },
        )
        expect(forkedWhitespace.id).not.toBe(created.id)

        expect(
          yield* requestJson<boolean>(pathFor(SessionPaths.abort, { sessionID: created.id }), {
            method: "POST",
            headers,
          }),
        ).toBe(true)

        expect(
          yield* requestJson<boolean>(pathFor(SessionPaths.remove, { sessionID: created.id }), {
            method: "DELETE",
            headers,
          }),
        ).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false, share: "disabled" } },
  )

  it.instance(
    "strips producer identity from public metadata and rejects generic mutation of producer-owned Sessions",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }

        const publicCreated = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "public metadata",
            metadata: {
              ordinary: "keep",
              scheduledTaskID: "stk_spoof",
              scheduledTaskRunID: "str_spoof",
              specialAgent: "goal_auditor",
              specialAgentOwnerKind: "goal",
              specialAgentOwnerID: "spoof-owner",
              goalID: "goal_spoof",
              parentSessionID: "ses_spoof",
            },
          }),
        })
        expect(publicCreated.metadata).toEqual({ ordinary: "keep" })

        const publicUpdated = yield* requestJson<Session.Info>(
          pathFor(SessionPaths.update, { sessionID: publicCreated.id }),
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({
              metadata: {
                ordinary: "replaced",
                scheduledTaskID: "stk_spoof",
                scheduledTaskRunID: "str_spoof",
                specialAgent: "goal_auditor",
                specialAgentOwnerKind: "goal",
                specialAgentOwnerID: "spoof-owner",
              },
            }),
          },
        )
        expect(publicUpdated.metadata).toEqual({ ordinary: "replaced" })

        const trusted = yield* createSession({
          title: "trusted scheduled metadata",
          metadata: {
            ordinaryOld: true,
            scheduledTaskID: "stk_real",
            scheduledTaskRunID: "str_real",
          },
        })

        const updated = yield* request(pathFor(SessionPaths.update, { sessionID: trusted.id }), {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            metadata: {
              ordinaryNew: true,
              scheduledTaskID: "stk_spoof",
              scheduledTaskRunID: "str_spoof",
              specialAgent: "goal_auditor",
            },
          }),
        })
        expect(updated.status).toBe(400)

        const forked = yield* request(pathFor(SessionPaths.fork, { sessionID: trusted.id }), {
          method: "POST",
          headers,
        })
        expect(forked.status).toBe(400)
        expect(
          (yield* requestJson<Session.Info>(pathFor(SessionPaths.get, { sessionID: trusted.id }), { headers }))
            .metadata,
        ).toEqual({
          ordinaryOld: true,
          scheduledTaskID: "stk_real",
          scheduledTaskRunID: "str_real",
        })

        const specialAgent = yield* createSession({
          title: "trusted special-agent metadata",
          metadata: {
            specialAgent: "goal_auditor",
            specialAgentOwnerKind: "goal",
            specialAgentOwnerID: "ses_parent\u0000goal_real",
            goalID: "goal_real",
            parentSessionID: "ses_parent",
            ordinaryOld: true,
          },
        })
        const specialUpdated = yield* request(pathFor(SessionPaths.update, { sessionID: specialAgent.id }), {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            metadata: {
              specialAgent: "prompt_revisor",
              specialAgentOwnerKind: "session",
              specialAgentOwnerID: "spoof-owner",
              goalID: "goal_spoof",
              parentSessionID: "ses_spoof",
              ordinaryNew: true,
            },
          }),
        })
        expect(specialUpdated.status).toBe(400)

        const specialFork = yield* request(pathFor(SessionPaths.fork, { sessionID: specialAgent.id }), {
          method: "POST",
          headers,
        })
        expect(specialFork.status).toBe(400)
        expect(
          (yield* requestJson<Session.Info>(pathFor(SessionPaths.get, { sessionID: specialAgent.id }), { headers }))
            .metadata,
        ).toEqual({
          specialAgent: "goal_auditor",
          specialAgentOwnerKind: "goal",
          specialAgentOwnerID: "ses_parent\u0000goal_real",
          goalID: "goal_real",
          parentSessionID: "ses_parent",
          ordinaryOld: true,
        })
      }),
    { git: true, config: { formatter: false, lsp: false, share: "disabled" } },
  )

  it.instance(
    "persists selected workspace id when creating a session",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = true
        const project = yield* Project.use.fromDirectory(test.directory)
        const workspace = yield* createLocalWorkspace({
          projectID: project.project.id,
          type: "session-create-workspace",
          directory: path.join(test.directory, ".workspace-local"),
        })

        const created = yield* requestJson<Session.Info>(`${SessionPaths.create}?workspace=${workspace.id}`, {
          method: "POST",
          headers: { "x-opencode-directory": test.directory, "content-type": "application/json" },
          body: JSON.stringify({ title: "workspace session" }),
        })
        const messages = yield* request(
          `${pathFor(SessionPaths.messages, { sessionID: created.id })}?workspace=${workspace.id}`,
          {
            headers: { "x-opencode-directory": test.directory },
          },
        )

        expect(created).toMatchObject({ id: created.id, workspaceID: workspace.id })
        expect(messages.status).toBe(200)
        expect(yield* getWorkspaceID(created.id)).toEqual({ workspaceID: workspace.id })
      }),
    { git: true, config: { formatter: false, lsp: false, share: "disabled" } },
  )

  it.instance(
    "validates archived timestamp values",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "archived" })
        const body = JSON.stringify({ time: { archived: -1 } })

        const response = yield* request(pathFor(SessionPaths.update, { sessionID: session.id }), {
          method: "PATCH",
          headers,
          body,
        })
        expect(response.status).toBe(200)
        expect((yield* json<Session.Info>(response)).time.archived).toBe(-1)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "uses project-scoped path and directory precedence",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const currentDir = path.join(test.directory, "packages", "opencode", "src")
        yield* Effect.promise(() => mkdir(currentDir, { recursive: true }))

        const store = yield* InstanceStore.Service
        const { pathSession, pathlessSession } = yield* store.provide(
          { directory: currentDir },
          Effect.gen(function* () {
            return {
              pathSession: yield* createSession(),
              pathlessSession: yield* createSession(),
            }
          }).pipe(Effect.provideService(TestInstance, { directory: currentDir })),
        )
        yield* clearSessionPath(pathlessSession.id)

        const query = new URLSearchParams({
          scope: "project",
          path: "packages/opencode/src",
          directory: currentDir,
        })
        const headers = { "x-opencode-directory": test.directory }
        const sessions = (yield* json<Session.Info[]>(
          yield* request(`${SessionPaths.list}?${query}`, { headers }),
        )).map((item) => item.id)

        expect(sessions).toContain(pathSession.id)
        expect(sessions).not.toContain(pathlessSession.id)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "lists sessions created through an equivalent directory hint",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const hint = test.directory + path.sep
        const headers = { "x-opencode-directory": hint, "content-type": "application/json" }
        const created = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "hinted" }),
        })

        const query = new URLSearchParams({ directory: hint, roots: "true" })
        const listed = yield* requestJson<Session.Info[]>(`${SessionPaths.list}?${query}`, { headers })
        expect(listed.map((item) => item.id)).toContain(created.id)

        const globalQuery = new URLSearchParams({ directory: hint })
        const global = yield* requestJson<Session.Info[]>(`${ExperimentalPaths.session}?${globalQuery}`, { headers })
        expect(global.map((item) => item.id)).toContain(created.id)

        const bootstrapFreeQuery = new URLSearchParams({ directory: hint, limit: "50" })
        const bootstrapFree = yield* requestJson<Session.Info[]>(`${GlobalPaths.sessionRoots}?${bootstrapFreeQuery}`)
        expect(bootstrapFree.map((item) => item.id)).toContain(created.id)

        const bootstrapFreeGet = yield* requestJson<Session.Info>(
          GlobalPaths.sessionGet.replace(":sessionID", created.id),
        )
        expect(bootstrapFreeGet.id).toBe(created.id)
        expect(FSUtil.resolve(bootstrapFreeGet.directory)).toBe(FSUtil.resolve(created.directory))
        const missingBootstrapFree = yield* requestJson<Session.Info | null>(
          GlobalPaths.sessionGet.replace(":sessionID", SessionID.make("ses_missing_bootstrap_free")),
        )
        expect(missingBootstrapFree).toBeNull()

        const projects = yield* requestJson<Project.Info[]>(GlobalPaths.projects)
        expect(projects.some((project) => FSUtil.resolve(project.worktree) === FSUtil.resolve(test.directory))).toBe(
          true,
        )
      }),
    { git: true, config: { formatter: false, lsp: false, share: "disabled" } },
  )

  it.instance(
    "project-scoped global roots include root Sessions outside the canonical worktree directory",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const nested = path.join(test.directory, ".scheduled", "task-a")
        yield* Effect.promise(() => mkdir(nested, { recursive: true }))

        const root = yield* createSession({ title: "canonical root" })
        const store = yield* InstanceStore.Service
        const foreign = yield* store.provide(
          { directory: nested },
          createSession({ title: "scheduled foreign-directory root" }).pipe(
            Effect.provideService(TestInstance, { directory: nested }),
          ),
        )
        expect(foreign.projectID).toBe(root.projectID)
        expect(FSUtil.resolve(foreign.directory)).not.toBe(FSUtil.resolve(root.directory))

        const directoryOnly = new URLSearchParams({ directory: test.directory, limit: "50" })
        const oldCensus = yield* requestJson<Session.Info[]>(GlobalPaths.sessionRoots + "?" + directoryOnly)
        expect(oldCensus.map((item) => item.id)).toContain(root.id)
        expect(oldCensus.map((item) => item.id)).not.toContain(foreign.id)

        const projectWide = new URLSearchParams({
          directory: test.directory,
          projectID: root.projectID,
          limit: "50",
        })
        const projectCensus = yield* requestJson<Session.Info[]>(GlobalPaths.sessionRoots + "?" + projectWide)
        expect(projectCensus.map((item) => item.id)).toContain(root.id)
        expect(projectCensus.map((item) => item.id)).toContain(foreign.id)
      }),
    { git: true, config: { formatter: false, lsp: false, share: "disabled" } },
  )

  it.instance(
    "lists Windows sessions for equivalent directory spellings",
    () =>
      Effect.gen(function* () {
        if (process.platform !== "win32") return
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const created = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "windows spelling" }),
        })

        const forwardSlashes = test.directory.replaceAll("\\", "/")
        const lowercaseDrive = test.directory.replace(/^[A-Z]:/, (drive) => drive.toLowerCase())
        const trailingSeparator = `${test.directory}\\`
        for (const spelling of [forwardSlashes, lowercaseDrive, trailingSeparator]) {
          const query = new URLSearchParams({ directory: spelling, roots: "true" })
          const listed = yield* requestJson<Session.Info[]>(`${SessionPaths.list}?${query}`, { headers })
          expect({ spelling, ids: listed.map((item) => item.id) }).toEqual({ spelling, ids: [created.id] })
        }
      }),
    { git: true, config: { formatter: false, lsp: false, share: "disabled" } },
    { timeout: 15000 },
  )

  it.instance(
    "lists Windows sessions created through the global worktree sentinel",
    () =>
      Effect.gen(function* () {
        if (process.platform !== "win32") return
        const globalWorktreeSentinel = "/"
        const headers = { "x-opencode-directory": globalWorktreeSentinel, "content-type": "application/json" }
        const driveRootSession = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "created at drive root" }),
        })
        expect(driveRootSession.directory).toMatch(/^[A-Za-z]:\\$/)

        const query = new URLSearchParams({ directory: globalWorktreeSentinel, roots: "true" })
        const listed = yield* requestJson<Session.Info[]>(`${SessionPaths.list}?${query}`, { headers })
        expect(listed.map((item) => item.id)).toContain(driveRootSession.id)
      }),
    { git: true, config: { formatter: false, lsp: false, share: "disabled" } },
    { timeout: 15000 },
  )

  it.instance(
    "serves paginated message link headers",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const session = yield* createSession({ title: "messages" })
        yield* createTextMessage(session.id, "first")
        yield* createTextMessage(session.id, "second")
        const route = `${pathFor(SessionPaths.messages, { sessionID: session.id })}?limit=1`

        const response = yield* request(route, { headers })

        expect(response.headers["x-next-cursor"]).toBeTruthy()
        expect(response.headers["link"]).toContain("limit=1")
        expect(response.headers["access-control-expose-headers"]?.toLowerCase()).toContain("x-next-cursor")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves progressive timeline parts for a persisted owner and 404s only a missing message",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const session = yield* createSession({ title: "timeline parts route" })
        const message = yield* createTextMessage(session.id, "timeline route content")
        const route = pathFor(`${SessionReadPaths.message}/timeline-parts`, {
          sessionID: session.id,
          messageID: message.info.id,
        })

        const page = yield* requestJson<{ data: { id: string }[]; nextCursor?: string }>(route, { headers })
        expect(page.data.map((part) => part.id)).toContain(message.part.id)

        const missing = pathFor(`${SessionReadPaths.message}/timeline-parts`, {
          sessionID: session.id,
          messageID: "msg_missing_timeline_route",
        })
        const response = yield* request(missing, { headers })
        expect(response.status).toBe(404)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    { timeout: 30000 },
  )

  it.instance(
    "pages session timeline parts once across owners with a stable lossless cursor",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const session = yield* createSession({ title: "batch timeline recovery" })
        const first = yield* createTextMessage(session.id, "first")
        const second = yield* createTextMessage(session.id, "second")
        const expected = new Set([first.part.id, second.part.id])
        const sessionService = yield* Session.Service
        for (let index = 0; index < 511; index++) {
          const part = yield* sessionService.updatePart({
            id: PartID.ascending(),
            sessionID: session.id,
            messageID: index % 2 === 0 ? first.info.id : second.info.id,
            type: "text",
            text: `part ${index}`,
          })
          expected.add(part.id)
        }

        const route = pathFor(SessionReadPaths.timelineParts, { sessionID: session.id })
        const query = new URLSearchParams()
        query.append("messageIDs", first.info.id)
        query.append("messageIDs", second.info.id)
        let cursor: string | undefined
        const recovered = new Map<string, string>()
        const pageSizes: number[] = []
        do {
          const page = yield* requestJson<{
            data: { messageID: string; part: { id: string; messageID: string } }[]
            nextCursor?: string
            completeMessageIDs: string[]
          }>(`${route}?${query.toString()}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { headers })
          pageSizes.push(page.data.length)
          for (const entry of page.data) {
            expect(entry.part.messageID).toBe(entry.messageID)
            expect([first.info.id, second.info.id]).toContain(entry.messageID)
            expect(recovered.has(entry.part.id)).toBe(false)
            recovered.set(entry.part.id, entry.messageID)
          }
          if (page.nextCursor) expect(page.nextCursor).not.toBe(cursor)
          if (!page.nextCursor)
            expect(page.completeMessageIDs.toSorted()).toEqual([first.info.id, second.info.id].toSorted())
          cursor = page.nextCursor
        } while (cursor)

        expect(pageSizes).toEqual([512, 1])
        expect(new Set(recovered.keys())).toEqual(expected)
        expect([...recovered.values()].filter((messageID) => messageID === first.info.id)).toHaveLength(257)
        expect([...recovered.values()].filter((messageID) => messageID === second.info.id)).toHaveLength(256)

        const foreignSession = yield* createSession({ title: "foreign timeline owner" })
        const foreign = yield* createTextMessage(foreignSession.id, "foreign")
        const invalidQuery = new URLSearchParams()
        invalidQuery.append("messageIDs", first.info.id)
        invalidQuery.append("messageIDs", foreign.info.id)
        const invalid = yield* request(`${route}?${invalidQuery.toString()}`, { headers })
        expect(invalid.status).toBe(404)

        const cursorMismatch = yield* request(
          `${route}?${invalidQuery.toString()}&cursor=${encodeURIComponent(
            Buffer.from(
              JSON.stringify({ partID: "prt_invalid", messageIDs: [first.info.id, second.info.id] }),
            ).toString("base64url"),
          )}`,
          { headers },
        )
        expect(cursorMismatch.status).toBe(400)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    { timeout: 30000 },
  )

  it.instance(
    "serves bounded progressive V1 part detail without a keyed full-message read",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const session = yield* createSession({ title: "part detail" })
        const message = yield* createTextMessage(session.id, "inspect-" + "🙂".repeat(2_500))
        const route = pathFor(`${SessionReadPaths.message}/parts`, {
          sessionID: session.id,
          messageID: message.info.id,
        })
        const serialized = JSON.stringify({ type: "text", text: message.part.text })
        let cursor: string | undefined
        let inspected = ""
        let pages = 0
        do {
          const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""
          const page = yield* requestJson<{
            data: { partID: string; type: string; offset: number; totalChars: number; text: string }[]
            nextCursor?: string
          }>(`${route}${query}`, { headers })
          pages++
          expect(page.data).toHaveLength(1)
          expect(page.data[0]?.partID).toBe(message.part.id)
          expect(page.data[0]?.offset).toBe(Array.from(inspected).length)
          expect(page.data[0]?.totalChars).toBe(Array.from(serialized).length)
          expect(Array.from(page.data[0]!.text).length).toBeLessThanOrEqual(1_024)
          inspected += page.data[0]!.text
          cursor = page.nextCursor
        } while (cursor)

        expect(pages).toBeGreaterThan(1)
        expect(inspected).toBe(serialized)
        expect(inspected.length).toBe(serialized.length)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    { timeout: 30000 },
  )

  it.instance(
    "detail recovery reads the live producer prefix without changing durable history",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const session = yield* createSession({ title: "live recovery" })
        const stored = yield* createTextMessage(session.id, "")
        const currentParts = yield* CurrentParts.Service
        const live = { ...stored.part, text: "prefix while provider is silent" }
        const key = { sessionID: session.id, messageID: stored.info.id, partID: stored.part.id }
        const token = currentParts.register({ ...key, snapshot: () => live })
        yield* Effect.addFinalizer(() => Effect.sync(() => currentParts.release(key, token)))
        const route = `${pathFor(SessionPaths.messages, { sessionID: session.id })}?limit=1`
        const recovered = yield* requestJson<SessionV1.WithParts[]>(route, { headers })
        expect(recovered[0]?.parts).toContainEqual(live)
        const durable = yield* Session.Service.use((svc) => svc.messages({ sessionID: session.id }))
        expect(durable[0]?.parts).toContainEqual(stored.part)
        currentParts.release(key, token)
        const after = yield* requestJson<SessionV1.WithParts[]>(route, { headers })
        expect(after[0]?.parts).toContainEqual(stored.part)
        expect(currentParts.snapshot(session.id, [stored.info.id])).toEqual([])
      }),
    { git: true, config: { formatter: false, lsp: false } },
    { timeout: 30000 },
  )

  it.instance(
    "serves message mutation routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "messages" })
        const first = yield* createTextMessage(session.id, "first")
        const second = yield* createTextMessage(session.id, "second")

        const updated = yield* requestJson<SessionV1.Part>(
          pathFor(SessionPaths.updatePart, {
            sessionID: session.id,
            messageID: first.info.id,
            partID: first.part.id,
          }),
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({ ...first.part, text: "updated" }),
          },
        )
        expect(updated).toMatchObject({ id: first.part.id, type: "text", text: "updated" })
        const stabilized = yield* Session.Service.use((svc) =>
          svc
            .messages({ sessionID: session.id })
            .pipe(Effect.map((messages) => messages.find((message) => message.info.id === first.info.id))),
        )
        expect(stabilized?.info).toMatchObject({
          role: "user",
          provenance: { owner: "user", source: V1SessionTurnProvenance.Source.Prompt },
        })

        expect(
          yield* requestJson<boolean>(
            pathFor(SessionPaths.deletePart, {
              sessionID: session.id,
              messageID: first.info.id,
              partID: first.part.id,
            }),
            { method: "DELETE", headers },
          ),
        ).toBe(true)

        expect(
          yield* requestJson<boolean>(
            pathFor(SessionPaths.deleteMessage, { sessionID: session.id, messageID: second.info.id }),
            { method: "DELETE", headers },
          ),
        ).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "rejects public part mutation of host-owned user-role turns",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "host-owned part mutation" })
        const svc = yield* Session.Service
        const info = yield* svc.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: session.id,
          provenance: V1SessionTurnProvenance.host(V1SessionTurnProvenance.Source.GoalProgress, {
            ref: "goal-state:httpapi-mutation",
          }),
          agent: "build",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
          time: { created: Date.now() },
        })
        const part = yield* svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: info.id,
          type: "text",
          text: "authoritative state",
          synthetic: true,
        })

        const update = yield* request(
          pathFor(SessionPaths.updatePart, {
            sessionID: session.id,
            messageID: info.id,
            partID: part.id,
          }),
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({ ...part, text: "spoofed state" }),
          },
        )
        expect(update.status).toBe(400)

        const remove = yield* request(
          pathFor(SessionPaths.deletePart, {
            sessionID: session.id,
            messageID: info.id,
            partID: part.id,
          }),
          { method: "DELETE", headers },
        )
        expect(remove.status).toBe(400)

        const removeMessage = yield* request(
          pathFor(SessionPaths.deleteMessage, {
            sessionID: session.id,
            messageID: info.id,
          }),
          { method: "DELETE", headers },
        )
        expect(removeMessage.status).toBe(400)

        const stored = (yield* svc.messages({ sessionID: session.id })).find((message) => message.info.id === info.id)
        expect(stored?.parts).toMatchObject([{ id: part.id, text: "authoritative state", synthetic: true }])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "human Stop/Pause/Resume reach root and nested delegated workers without granting aggregate mutation",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const svc = yield* Session.Service
        const runState = yield* SessionRunState.Service
        const owner = yield* SessionExecutionOwner.Service
        const store = yield* InstanceStore.Service
        const parent = yield* createSession({ title: "Nested worker parent" })
        const headers = { "x-opencode-directory": test.directory }
        for (const nested of [false, true]) {
          const metadata = SessionMetadataOwnership.delegatedWorker({
            producer: "oxp",
            principalRef: "principal",
            invocationRef: "invocation",
            rootRef: "root",
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            nestedDelegation: false,
            ...(nested ? { parentWorkerID: parent.id } : {}),
          })
          const chat = yield* createSession({
            agent: "build",
            model: { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test-model") },
            metadata,
            ...(nested ? { parentID: parent.id } : {}),
          })
          const { db } = yield* Database.Service
          yield* Recovery.observeFailure(db, {
            sessionID: chat.id,
            sourceAssistantMessageID: "msg_human_stop_recovery",
            providerID: "test",
            modelID: "test-model",
            failureClass: "account-quota",
            resetAt: Date.now() + 60000,
            resetSource: "retry-after",
            now: Date.now(),
          })
          const entered = yield* Deferred.make<void>()
          const running = yield* runState
            .ensureRunning(
              chat.id,
              Effect.succeed({} as SessionV1.WithParts),
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
            )
            .pipe(Effect.forkChild)
          yield* awaitWithTimeout(Deferred.await(entered), "worker did not acquire execution")
          const load = spyOn(store, "load").mockImplementation(() => Effect.never as never)
          try {
            const stopped = yield* awaitWithTimeout(
              request(pathFor(SessionPaths.abort, { sessionID: chat.id }), { method: "POST", headers }),
              "human Stop waited for bootstrap",
            )
            expect(stopped.status).toBe(200)
            expect(yield* stopped.json).toBe(true)
            expect(load).not.toHaveBeenCalled()
            expect(yield* Recovery.get(db, chat.id)).toBeUndefined()
            const registry = yield* PendingResponseRegistry.Service
            for (const kind of ["permission", "question"] as const) {
              const requestID = `${kind}_human_${nested ? "nested" : "root"}`
              const settled = yield* Deferred.make<void>()
              const unregister = yield* registry.register({
                kind,
                requestID,
                sessionID: chat.id,
                directory: FSUtil.resolve(test.directory),
                snapshot: { id: requestID, sessionID: chat.id },
                settle: () => Deferred.succeed(settled, undefined).pipe(Effect.asVoid),
              })
              yield* Effect.addFinalizer(() => unregister)
              const response = yield* awaitWithTimeout(
                request(kind === "permission" ? `/permission/${requestID}/reply` : `/question/${requestID}/reject`, {
                  method: "POST",
                  headers: { ...headers, "content-type": "application/json" },
                  ...(kind === "permission" ? { body: JSON.stringify({ reply: "once" }) } : {}),
                }),
                "human blocker response waited for bootstrap",
              )
              expect(response.status).toBe(200)
              yield* awaitWithTimeout(Deferred.await(settled), "human blocker response never settled")
            }
            expect(load).not.toHaveBeenCalled()
          } finally {
            load.mockRestore()
          }
          yield* Fiber.await(running)
          expect((yield* owner.snapshot(chat.id)).ownerID).toBeUndefined()
          const paused = yield* request(pathFor(SessionPaths.pause, { sessionID: chat.id }), {
            method: "POST",
            headers,
          })
          expect(paused.status).toBe(204)
          expect((yield* svc.get(chat.id)).pausedAt).toBeDefined()
          const resumed = yield* request(pathFor(SessionPaths.resume, { sessionID: chat.id }), {
            method: "POST",
            headers,
          })
          expect(resumed.status).toBe(204)
          expect((yield* svc.get(chat.id)).pausedAt).toBeUndefined()
          expect((yield* svc.get(chat.id)).metadata).toEqual(metadata)
          const mutation = yield* request(pathFor(SessionPaths.update, { sessionID: chat.id }), {
            method: "PATCH",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ title: "takeover" }),
          })
          expect(mutation.status).toBe(400)
        }
      }),
    { git: true, config: { formatter: false, lsp: false } },
    { timeout: 30000 },
  )

  it.live(
    "delegated prompt_async admits a follow-up while the provider is occupied and completes execution",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        let release!: () => void
        const held = new Promise<void>((resolve) => {
          release = resolve
        })
        yield* Effect.addFinalizer(() => Effect.sync(release))
        yield* llm.push(
          reply().wait(held).text("first completion").stop().item(),
          reply().text("follow-up completion").stop().item(),
        )
        const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
        const origin = {
          producer: "oxp",
          principalRef: "oxp:busy-http",
          invocationRef: "oxp-inv:busy-http",
          rootRef: "root-busy-http",
          agent: "build",
          model: { providerID: "test", modelID: "test-model" },
          nestedDelegation: false,
        }
        const chat = yield* createSession({
          title: "Busy worker follow-up",
          agent: "build",
          model: { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test-model") },
          metadata: SessionMetadataOwnership.delegatedWorker(origin),
        }).pipe(provideInstanceEffect(directory))
        const headers = { "x-opencode-directory": directory, "content-type": "application/json" }
        for (const text of ["follow-up one", "follow-up two"]) {
          const response = yield* request(pathFor(SessionPaths.promptAsync, { sessionID: chat.id }), {
            method: "POST",
            headers,
            body: JSON.stringify({ parts: [{ type: "text", text }] }),
          }).pipe((operation) =>
            awaitWithTimeout(operation, `${text}: HTTP admission exceeded five seconds`, "5 seconds"),
          )
          expect(response.status).toBe(204)
          if (text === "follow-up one")
            yield* awaitWithTimeout(llm.wait(1), "First prompt did not reach the held provider", "10 seconds")
        }
        const stored = yield* Session.use.messages({ sessionID: chat.id }).pipe(provideInstanceEffect(directory))
        expect(stored.filter((message) => message.info.role === "user")).toHaveLength(2)
        release()
        yield* pollWithTimeout(
          Session.use.messages({ sessionID: chat.id }).pipe(
            provideInstanceEffect(directory),
            Effect.map((messages) =>
              messages.some(
                (message) =>
                  message.info.role === "assistant" &&
                  !!message.info.time.completed &&
                  message.parts.some((part) => part.type === "text" && part.text.includes("follow-up completion")),
              )
                ? true
                : undefined,
            ),
          ),
          "follow-up never reached a completed provider response",
        )
        expect((yield* Session.use.get(chat.id).pipe(provideInstanceEffect(directory))).metadata).toEqual(chat.metadata)
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
    { timeout: 45000 },
  )

  it.instance(
    "admits interactive delegated-worker follow-ups at 1/3/6 concurrency without changing protected ownership",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const svc = yield* Session.Service
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        for (const count of [1, 3, 6]) {
          const chats = yield* Effect.forEach(
            Array.from({ length: count }, (_, index) => index),
            (index) => {
              const origin = {
                producer: "oxp",
                principalRef: `oxp:interactive-${count}-${index}`,
                invocationRef: `oxp-inv:interactive-${count}-${index}`,
                rootRef: "root-interactive",
                agent: "build",
                model: { providerID: "test", modelID: "test-model", accountID: "assigned-account", variant: "max" },
                nestedDelegation: false,
              }
              return createSession({
                title: "Interactive worker",
                agent: origin.agent,
                model: {
                  providerID: ProviderV2.ID.make("test"),
                  id: ModelV2.ID.make("test-model"),
                  accountID: "assigned-account",
                  variant: "max",
                },
                metadata: SessionMetadataOwnership.delegatedWorker(origin),
              })
            },
          )
          const responses = yield* Effect.forEach(
            chats,
            (chat) =>
              request(pathFor(SessionPaths.promptAsync, { sessionID: chat.id }), {
                method: "POST",
                headers,
                // The composer can omit accountID; admission binds the durable account.
                body: JSON.stringify({
                  noReply: true,
                  agent: "build",
                  model: { providerID: "test", modelID: "test-model" },
                  variant: "max",
                  parts: [{ type: "text", text: "human follow-up" }],
                }),
              }).pipe(Effect.timeout("5 seconds")),
            { concurrency: "unbounded" },
          )
          expect(responses.map((response) => response.status)).toEqual(Array(count).fill(204))
          for (const chat of chats) {
            const current = yield* svc.get(chat.id)
            expect(current.metadata).toEqual(chat.metadata)
            expect(current.model).toEqual(chat.model)
            expect(current.agent).toBe(chat.agent)
            const messages = yield* svc.messages({ sessionID: chat.id })
            expect(messages).toHaveLength(1)
            expect(messages[0]!.info).toMatchObject({
              role: "user",
              provenance: { owner: "user", source: "prompt" },
              model: { providerID: "test", modelID: "test-model", accountID: "assigned-account", variant: "max" },
            })
            expect(messages[0]!.parts).toMatchObject([{ type: "text", text: "human follow-up" }])
            expect(messages[0]!.parts[0]).toMatchObject({
              metadata: { workerDelegationPolicy: { version: 1, nestedDelegation: false } },
            })
            // Conversational admission does not grant aggregate mutation authority.
            const takeover = yield* request(pathFor(SessionPaths.update, { sessionID: chat.id }), {
              method: "PATCH",
              headers,
              body: JSON.stringify({ title: "takeover" }),
            })
            expect(takeover.status).toBe(400)
          }
        }
      }),
    { git: true, config: { formatter: false, lsp: false } },
    { timeout: 30000 },
  )

  it.instance(
    "rejects delegated selection/permission overrides and malformed origins before acknowledgement or persistence",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const svc = yield* Session.Service
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const origin = {
          producer: "oxp",
          principalRef: "oxp:protected",
          invocationRef: "oxp-inv:protected",
          rootRef: "root-protected",
          agent: "build",
          model: { providerID: "test", modelID: "test-model" },
          nestedDelegation: false,
        }
        const chat = yield* createSession({
          title: "Protected worker",
          agent: "build",
          model: { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test-model") },
          metadata: SessionMetadataOwnership.delegatedWorker(origin),
        })
        for (const override of [
          { model: { providerID: "other", modelID: "other" } },
          { model: { providerID: "test", modelID: "test-model", accountID: "other" } },
          { variant: "max" },
          { tools: { shell: true } },
          { subProvider: "other" },
          { agent: "plan" },
        ]) {
          const response = yield* request(pathFor(SessionPaths.promptAsync, { sessionID: chat.id }), {
            method: "POST",
            headers,
            body: JSON.stringify({ noReply: true, parts: [{ type: "text", text: "must not persist" }], ...override }),
          })
          expect(response.status).toBe(400)
          expect(yield* response.json).toMatchObject({
            _tag: "InvalidRequestError",
            kind: "delegated_worker",
            message: expect.stringContaining("assigned"),
          })
          expect(yield* svc.messages({ sessionID: chat.id })).toHaveLength(0)
          expect((yield* svc.get(chat.id)).metadata).toEqual(chat.metadata)
        }
        const malformed = yield* createSession({ metadata: { workerDelegation: { producer: "oxp" } } })
        const response = yield* request(pathFor(SessionPaths.promptAsync, { sessionID: malformed.id }), {
          method: "POST",
          headers,
          body: JSON.stringify({ noReply: true, parts: [{ type: "text", text: "must not persist" }] }),
        })
        expect(response.status).toBe(400)
        expect(yield* svc.messages({ sessionID: malformed.id })).toHaveLength(0)
        // The synchronous prompt endpoint shares the same service-owned binding.
        const admitted = yield* request(pathFor(SessionPaths.prompt, { sessionID: chat.id }), {
          method: "POST",
          headers,
          body: JSON.stringify({ noReply: true, parts: [{ type: "text", text: "synchronous follow-up" }] }),
        })
        expect(admitted.status).toBe(200)
        expect(yield* svc.messages({ sessionID: chat.id })).toHaveLength(1)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    { timeout: 30000 },
  )

  it.instance(
    "keeps scheduled-task aggregate mutation fenced while allowing ordinary Session prompting",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({
          title: "scheduled run",
          metadata: { scheduledTaskID: "stk_http_test", scheduledTaskRunID: "str_http_test" },
        })
        const seeded = yield* createTextMessage(session.id, "producer-owned transcript")

        const prompt = yield* request(pathFor(SessionPaths.promptAsync, { sessionID: session.id }), {
          method: "POST",
          headers,
          body: JSON.stringify({
            noReply: true,
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "human follow-up" }],
          }),
        })
        expect(prompt.status).toBe(204)
        yield* pollWithTimeout(
          Session.Service.use((svc) => svc.messages({ sessionID: session.id })).pipe(
            Effect.map((messages) =>
              messages.some(
                (message) =>
                  message.info.role === "user" &&
                  message.info.provenance?.owner === "user" &&
                  message.parts.some((part) => part.type === "text" && part.text === "human follow-up"),
              )
                ? true
                : undefined,
            ),
          ),
          "timed out waiting for Scheduled root human prompt",
        )

        const malformed = yield* createSession({
          title: "malformed scheduled run",
          // scheduledTaskID alone is the canonical task-owned Session shape.
          // A run id without its owning task is the malformed protected origin.
          metadata: { scheduledTaskRunID: "str_http_malformed" },
        })
        const malformedPrompt = yield* request(pathFor(SessionPaths.promptAsync, { sessionID: malformed.id }), {
          method: "POST",
          headers,
          body: JSON.stringify({
            noReply: true,
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "must fail before async acknowledgement" }],
          }),
        })
        expect(malformedPrompt.status).toBe(400)

        const blockedAggregateOperations = [
          {
            name: "update",
            path: pathFor(SessionPaths.update, { sessionID: session.id }),
            method: "PATCH",
            body: { title: "public takeover" },
          },
          {
            name: "fork",
            path: pathFor(SessionPaths.fork, { sessionID: session.id }),
            method: "POST",
          },
          {
            name: "abort",
            path: pathFor(SessionPaths.abort, { sessionID: session.id }),
            method: "POST",
          },
          {
            name: "pause",
            path: pathFor(SessionPaths.pause, { sessionID: session.id }),
            method: "POST",
          },
          {
            name: "resume",
            path: pathFor(SessionPaths.resume, { sessionID: session.id }),
            method: "POST",
          },
          {
            name: "regenerateTitle",
            path: pathFor(SessionPaths.regenerateTitle, { sessionID: session.id }),
            method: "POST",
            body: {},
          },
          {
            name: "init",
            path: pathFor(SessionPaths.init, { sessionID: session.id }),
            method: "POST",
            body: { providerID: "test", modelID: "test", messageID: MessageID.ascending() },
          },
          {
            name: "share",
            path: pathFor(SessionPaths.share, { sessionID: session.id }),
            method: "POST",
          },
          {
            name: "unshare",
            path: pathFor(SessionPaths.share, { sessionID: session.id }),
            method: "DELETE",
          },
          {
            name: "summarize",
            path: pathFor(SessionPaths.summarize, { sessionID: session.id }),
            method: "POST",
            body: { providerID: "test", modelID: "test" },
          },
          {
            name: "revert",
            path: pathFor(SessionPaths.revert, { sessionID: session.id }),
            method: "POST",
            body: { messageID: seeded.info.id },
          },
          {
            name: "unrevert",
            path: pathFor(SessionPaths.unrevert, { sessionID: session.id }),
            method: "POST",
          },
        ] as const

        for (const operation of blockedAggregateOperations) {
          const response = yield* request(operation.path, {
            method: operation.method,
            headers,
            ...("body" in operation ? { body: JSON.stringify(operation.body) } : {}),
          })
          expect(response.status, operation.name).toBe(400)
        }

        const update = yield* request(
          pathFor(SessionPaths.updatePart, {
            sessionID: session.id,
            messageID: seeded.info.id,
            partID: seeded.part.id,
          }),
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({ ...seeded.part, text: "rewritten" }),
          },
        )
        expect(update.status).toBe(400)

        const remove = yield* request(
          pathFor(SessionPaths.deleteMessage, { sessionID: session.id, messageID: seeded.info.id }),
          { method: "DELETE", headers },
        )
        expect(remove.status).toBe(400)

        const stored = (yield* Session.Service.use((svc) => svc.messages({ sessionID: session.id }))).find(
          (message) => message.info.id === seeded.info.id,
        )
        expect(stored?.parts).toMatchObject([{ id: seeded.part.id, text: "producer-owned transcript" }])

        const aggregate = yield* requestJson<Session.Info>(pathFor(SessionPaths.get, { sessionID: session.id }), {
          headers,
        })
        expect(aggregate).toMatchObject({
          id: session.id,
          title: "scheduled run",
          metadata: { scheduledTaskID: "stk_http_test", scheduledTaskRunID: "str_http_test" },
        })
        expect(aggregate.pausedAt).toBeUndefined()

        const removeSession = yield* request(pathFor(SessionPaths.remove, { sessionID: session.id }), {
          method: "DELETE",
          headers,
        })
        expect(removeSession.status).toBe(400)
        expect(
          (yield* requestJson<Session.Info>(pathFor(SessionPaths.get, { sessionID: session.id }), { headers })).id,
        ).toBe(session.id)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "rejects part updates whose path and body ids disagree",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "part mismatch" })
        const message = yield* createTextMessage(session.id, "first")
        const response = yield* request(
          pathFor(SessionPaths.updatePart, {
            sessionID: session.id,
            messageID: message.info.id,
            partID: message.part.id,
          }),
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({ ...message.part, id: PartID.ascending() }),
          },
        )

        expect(response.status).toBe(400)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves remaining non-LLM session mutation routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "remaining" })

        expect(
          yield* requestJson<Session.Info>(pathFor(SessionPaths.revert, { sessionID: session.id }), {
            method: "POST",
            headers,
            body: JSON.stringify({ messageID: MessageID.ascending() }),
          }),
        ).toMatchObject({ id: session.id })

        expect(
          yield* requestJson<Session.Info>(pathFor(SessionPaths.unrevert, { sessionID: session.id }), {
            method: "POST",
            headers,
          }),
        ).toMatchObject({ id: session.id })

        const permissionID = String(PermissionV1.ID.ascending())
        const permission = yield* request(
          pathFor(SessionPaths.permissions, {
            sessionID: session.id,
            permissionID,
          }),
          {
            method: "POST",
            headers,
            body: JSON.stringify({ response: "once" }),
          },
        )
        expect(permission.status).toBe(404)
        expect(yield* responseJson(permission)).toEqual({
          _tag: "PermissionNotFoundError",
          requestID: permissionID,
          message: `Permission request not found: ${permissionID}`,
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "pauses and resumes sessions durably",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const session = yield* createSession({ title: "pause me" })

        const pause = yield* request(pathFor(SessionPaths.pause, { sessionID: session.id }), {
          method: "POST",
          headers,
        })
        expect(pause.status).toBe(204)
        expect(
          (yield* requestJson<Session.Info>(pathFor(SessionPaths.get, { sessionID: session.id }), { headers }))
            .pausedAt,
        ).toBeTruthy()

        // Idempotent — pause-while-paused is a no-op, not an error.
        const again = yield* request(pathFor(SessionPaths.pause, { sessionID: session.id }), {
          method: "POST",
          headers,
        })
        expect(again.status).toBe(204)

        const resume = yield* request(pathFor(SessionPaths.resume, { sessionID: session.id }), {
          method: "POST",
          headers,
        })
        expect(resume.status).toBe(204)
        expect(
          (yield* requestJson<Session.Info>(pathFor(SessionPaths.get, { sessionID: session.id }), { headers }))
            .pausedAt,
        ).toBeUndefined()
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "returns session not found errors for pause, resume and regenerateTitle on missing sessions",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const missing = SessionID.descending()
        const expected = {
          _tag: "SessionNotFoundError",
          sessionID: missing,
          message: `Session not found: ${missing}`,
        }

        for (const [name, body] of [
          [SessionPaths.pause, undefined],
          [SessionPaths.resume, undefined],
          [SessionPaths.regenerateTitle, "{}"],
        ] as const) {
          const response = yield* request(pathFor(name, { sessionID: missing }), {
            method: "POST",
            headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
            ...(body === undefined ? {} : { body }),
          })
          expect(response.status).toBe(404)
          expect(yield* responseJson(response)).toEqual(expected)
        }
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "submitting a prompt automatically resumes a paused session and drains the new input",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        yield* llm.text("ok", { usage: { input: 1, output: 1 } })

        const config = testProviderConfig(llm.url)
        const directory = yield* tmpdirScoped({ git: true, config })
        const session = yield* createSession({ title: "paused drain" }).pipe(provideInstanceEffect(directory))
        const headers = { "x-opencode-directory": directory }

        yield* request(pathFor(SessionPaths.pause, { sessionID: session.id }), { method: "POST", headers })

        // Sending a human prompt is an explicit Resume action: no separate
        // /resume request is needed, and the new message is admitted first.
        const admitted = yield* request(
          `${pathFor(SessionPaths.prompt, { sessionID: session.id })}?directory=${encodeURIComponent(directory)}`,
          {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({
              agent: "build",
              model: { providerID: "test", modelID: "test-model" },
              parts: [{ type: "text", text: "hello while paused" }],
            }),
          },
        )
        expect(admitted.status).toBe(200)
        expect((yield* requestJson<Session.Info>(pathFor(SessionPaths.get, { sessionID: session.id }), { headers })).pausedAt).toBeUndefined()

        const assistant = yield* pollWithTimeout(
          Effect.gen(function* () {
            const messages = yield* Session.use
              .messages({ sessionID: session.id })
              .pipe(provideInstanceEffect(directory), Effect.orDie)
            return messages.find((message) => message.info.role === "assistant")
          }),
          "user submission did not resume and drain the admitted prompt",
          "10 seconds",
        )
        expect(assistant?.info.role).toBe("assistant")
        expect(yield* llm.calls).toBe(1)
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
    { git: true, config: { formatter: false, lsp: false } },
    { timeout: 60000 },
  )

  it.instance(
    "prompt_async including a Poke continue message automatically unpauses the session",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        yield* llm.text("continued", { usage: { input: 1, output: 1 } })
        const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
        const session = yield* createSession({ title: "paused poke" }).pipe(provideInstanceEffect(directory))
        const headers = { "x-opencode-directory": directory }
        const paused = yield* request(pathFor(SessionPaths.pause, { sessionID: session.id }), { method: "POST", headers })
        expect(paused.status).toBe(204)

        const sent = yield* request(pathFor(SessionPaths.promptAsync, { sessionID: session.id }), {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "continue" }],
          }),
        })
        expect(sent.status).toBe(204)
        expect((yield* requestJson<Session.Info>(pathFor(SessionPaths.get, { sessionID: session.id }), { headers })).pausedAt).toBeUndefined()

        const assistant = yield* pollWithTimeout(
          Effect.gen(function* () {
            const messages = yield* Session.use.messages({ sessionID: session.id })
              .pipe(provideInstanceEffect(directory), Effect.orDie)
            return messages.find((message) => message.info.role === "assistant")
          }),
          "Poke did not wake the paused session",
          "10 seconds",
        )
        expect(assistant?.info.role).toBe("assistant")
        // An async wake creates the assistant row before provider startup.
        // Verify the request actually reached the model, not merely the DB.
        const calls = yield* pollWithTimeout(
          Effect.gen(function* () {
            const count = yield* llm.calls
            return count > 0 ? count : undefined
          }),
          "Poke did not reach the provider",
          "30 seconds",
        )
        expect(calls).toBe(1)
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
    { git: true, config: { formatter: false, lsp: false } },
    { timeout: 120000 },
  )

  it.live("pause stops an in-flight V1 run", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      // The provider response never completes, so the run stays in flight.
      yield* llm.hang

      const config = testProviderConfig(llm.url)
      const directory = yield* tmpdirScoped({ git: true, config })
      const session = yield* createSession({ title: "in-flight pause" }).pipe(provideInstanceEffect(directory))
      const headers = { "x-opencode-directory": directory }

      // Fork the prompt request — a hung run would otherwise block the test.
      const promptRequest = yield* request(
        `${pathFor(SessionPaths.prompt, { sessionID: session.id })}?directory=${encodeURIComponent(directory)}`,
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "long running task" }],
          }),
        },
      ).pipe(Effect.forkChild)

      // Wait until the run is actually streaming against the mock provider.
      yield* llm.wait(1)

      const pause = yield* request(pathFor(SessionPaths.pause, { sessionID: session.id }), {
        method: "POST",
        headers,
      })
      expect(pause.status).toBe(204)

      // The in-flight run is cancelled: the prompt request resolves instead of
      // hanging forever, and no further provider calls happen.
      const response = yield* awaitWithTimeout(
        Fiber.await(promptRequest).pipe(Effect.flatMap((exit) => Effect.succeed(exit))),
        "in-flight V1 run was not stopped by pause",
        "10 seconds",
      )
      expect(Exit.isSuccess(response)).toBe(true)
      expect(yield* llm.calls).toBe(1)
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
  )

  it.live(
    "regenerates a session title in the background",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        yield* llm.tool(SessionTitle.GENERATED_TITLE_TOOL, { title: "Generated Title" })

        const config = testProviderConfig(llm.url)
        const directory = yield* tmpdirScoped({ git: true, config })
        const session = yield* createSession({ title: "Old Title" }).pipe(provideInstanceEffect(directory))
        const svc = yield* Session.Service
        const message = yield* svc.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
          time: { created: Date.now() },
        })
        yield* svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: message.id,
          type: "text",
          text: "hello",
        })

        const response = yield* request(pathFor(SessionPaths.regenerateTitle, { sessionID: session.id }), {
          method: "POST",
          headers: { "x-opencode-directory": directory, "content-type": "application/json" },
          body: JSON.stringify({}),
        })
        expect(response.status).toBe(204)

        const titled = yield* pollWithTimeout(
          Effect.gen(function* () {
            const current = yield* Session.use.get(session.id).pipe(provideInstanceEffect(directory), Effect.orDie)
            return current.title === "Old Title" ? undefined : current.title
          }),
          "title was not regenerated",
          "10 seconds",
        )
        expect(titled).toBe("Generated Title")

        const transcriptID = SpecialAgentSession.sessionIDFor({
          ownerKind: SpecialAgentSession.OWNER_SESSION,
          ownerID: session.id,
          agent: "session_title",
        })
        const { readDb } = yield* Database.Service
        const history = yield* SessionHistory.load(readDb, transcriptID)
        const prompts = history.filter(
          (item) =>
            item.type === "synthetic" &&
            item.provenance?.owner === "host" &&
            item.provenance.source === CurrentSessionTurnProvenance.Source.SessionTitle,
        )
        expect(prompts).toHaveLength(1)
        expect(prompts[0] && CurrentSessionTurnProvenance.isWorkerPromptTurn(prompts[0])).toBe(false)
        const assistants = history.filter((item) => item.type === "assistant")
        expect(assistants).toHaveLength(1)
        expect(
          assistants.flatMap((assistant) =>
            assistant.type === "assistant"
              ? assistant.content
                  .filter((part) => part.type === "tool")
                  .map((part) => ({ name: part.name, status: part.state.status }))
              : [],
          ),
        ).toContainEqual({ name: SessionTitle.GENERATED_TITLE_TOOL, status: "completed" })

        // The desktop's production local-protocol path hydrates detail Sessions
        // through the mature V1 message endpoint. Special-agent Sessions own a
        // current transcript, so that endpoint must expose the same durable
        // conversation instead of rendering an empty child after navigation.
        const compat = yield* requestJson<SessionV1.WithParts[]>(
          `${pathFor(SessionPaths.messages, { sessionID: transcriptID })}?limit=50`,
          { headers: { "x-opencode-directory": directory } },
        )
        expect(
          compat.some(
            (item) =>
              item.info.role === "user" &&
              item.info.provenance?.source === CurrentSessionTurnProvenance.Source.SessionTitle,
          ),
        ).toBe(true)
        expect(
          compat.some(
            (item) =>
              item.info.role === "assistant" &&
              item.parts.some((part) => part.type === "tool" && part.tool === SessionTitle.GENERATED_TITLE_TOOL),
          ),
        ).toBe(true)

        const assistant = compat.find((item) => item.info.role === "assistant")
        const prompt = compat.find((item) => item.info.role === "user")
        expect(assistant?.info.role).toBe("assistant")
        expect(prompt?.info.role).toBe("user")
        if (!assistant || assistant.info.role !== "assistant" || !prompt || prompt.info.role !== "user") {
          return yield* Effect.die("special-agent V1 projection did not expose the expected turn pair")
        }
        expect(assistant.info.parentID).toBe(prompt.info.id)

        const firstPageResponse = yield* request(
          `${pathFor(SessionPaths.messages, { sessionID: transcriptID })}?limit=1`,
          { headers: { "x-opencode-directory": directory } },
        )
        const firstPage = yield* json<SessionV1.WithParts[]>(firstPageResponse)
        expect(firstPage).toHaveLength(1)
        expect(firstPage[0]?.info.role).toBe("assistant")
        const nextCursor = firstPageResponse.headers["x-next-cursor"]
        expect(nextCursor).toBeTruthy()

        const secondPage = yield* requestJson<SessionV1.WithParts[]>(
          `${pathFor(SessionPaths.messages, { sessionID: transcriptID })}?limit=1&before=${encodeURIComponent(String(nextCursor))}`,
          { headers: { "x-opencode-directory": directory } },
        )
        expect(secondPage).toHaveLength(1)
        expect(secondPage[0]?.info.role).toBe("user")
        expect(firstPage[0]?.info.role === "assistant" ? firstPage[0].info.parentID : undefined).toBe(
          secondPage[0]?.info.id,
        )

        const byID = yield* requestJson<SessionV1.WithParts>(
          pathFor(SessionPaths.message, {
            sessionID: transcriptID,
            messageID: assistant.info.id,
          }),
          { headers: { "x-opencode-directory": directory } },
        )
        expect(byID.info.id).toBe(assistant.info.id)
        expect(byID.info.role === "assistant" ? byID.info.parentID : undefined).toBe(prompt.info.id)
        expect(byID.parts.some((part) => part.type === "tool" && part.tool === SessionTitle.GENERATED_TITLE_TOOL)).toBe(
          true,
        )
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
    20_000,
  )

  it.live(
    "regenerateTitle leaves the title untouched until user explicitly chooses a different model",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        yield* llm.push(
          httpError(400, { error: { message: "Upstream rejected the first title model" } }),
          reply().tool(SessionTitle.GENERATED_TITLE_TOOL, { title: "Recovered After 400" }).item(),
        )

        const base = testProviderConfig(llm.url)
        const config = {
          ...base,
          provider: {
            test: {
              ...base.provider.test,
              models: {
                ...base.provider.test.models,
                "title-backup-model": {
                  ...base.provider.test.models["test-model"],
                  id: "title-backup-model",
                  name: "Title Backup",
                },
              },
            },
          },
        }
        const directory = yield* tmpdirScoped({ git: true, config })
        const session = yield* createSession({ title: "Old Title" }).pipe(provideInstanceEffect(directory))
        const svc = yield* Session.Service
        const message = yield* svc.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
          time: { created: Date.now() },
        })
        yield* svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: message.id,
          type: "text",
          text: "HTTP 400 recovery test",
        })

        const response = yield* request(pathFor(SessionPaths.regenerateTitle, { sessionID: session.id }), {
          method: "POST",
          headers: { "x-opencode-directory": directory, "content-type": "application/json" },
          body: JSON.stringify({}),
        })
        expect(response.status).toBe(503)
        expect((yield* Session.use.get(session.id).pipe(provideInstanceEffect(directory), Effect.orDie)).title).toBe("Old Title")
        expect((yield* llm.inputs).map((item) => item.model)).toEqual(["test-model"])

        // UI prompts the human to choose another model. No backend fallback
        // happens before the explicit second request carrying that choice.
        const retry = yield* request(pathFor(SessionPaths.regenerateTitle, { sessionID: session.id }), {
          method: "POST",
          headers: { "x-opencode-directory": directory, "content-type": "application/json" },
          body: JSON.stringify({ model: { providerID: "test", id: "title-backup-model" } }),
        })
        expect(retry.status).toBe(204)
        expect((yield* Session.use.get(session.id).pipe(provideInstanceEffect(directory), Effect.orDie)).title)
          .toBe("Recovered After 400")
        expect((yield* llm.inputs).map((item) => item.model)).toEqual(["test-model", "title-backup-model"])
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
    20_000,
  )

  it.live(
    "regenerateTitle repairs prose in the same title-agent conversation",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        yield* llm.push(
          reply().text("This looks like a title, but I forgot the completion tool.").stop().item(),
          reply().tool(SessionTitle.GENERATED_TITLE_TOOL, { title: "Recovered Title" }).item(),
        )

        const config = testProviderConfig(llm.url)
        const directory = yield* tmpdirScoped({ git: true, config })
        const session = yield* createSession({ title: "Old Title" }).pipe(provideInstanceEffect(directory))
        const svc = yield* Session.Service
        const message = yield* svc.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
          time: { created: Date.now() },
        })
        yield* svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: message.id,
          type: "text",
          text: "repair title generation",
        })

        const response = yield* request(pathFor(SessionPaths.regenerateTitle, { sessionID: session.id }), {
          method: "POST",
          headers: { "x-opencode-directory": directory, "content-type": "application/json" },
          body: JSON.stringify({}),
        })
        expect(response.status).toBe(204)

        const titled = yield* pollWithTimeout(
          Effect.gen(function* () {
            const current = yield* Session.use.get(session.id).pipe(provideInstanceEffect(directory), Effect.orDie)
            return current.title === "Old Title" ? undefined : current.title
          }),
          "repaired title was not regenerated",
          "10 seconds",
        )
        expect(titled).toBe("Recovered Title")

        const inputs = yield* llm.inputs
        expect(inputs).toHaveLength(2)
        expect(JSON.stringify(inputs[1])).toContain("Protocol correction")
        expect(JSON.stringify(inputs[1])).toContain(SessionTitle.GENERATED_TITLE_TOOL)
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
    20_000,
  )

  it.live(
    "regenerateTitle repairs an invalid generated_title payload before succeeding",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        yield* llm.push(
          reply().tool(SessionTitle.GENERATED_TITLE_TOOL, { wrong: "field" }).item(),
          reply().tool(SessionTitle.GENERATED_TITLE_TOOL, { title: "Validated Title" }).item(),
        )

        const config = testProviderConfig(llm.url)
        const directory = yield* tmpdirScoped({ git: true, config })
        const session = yield* createSession({ title: "Old Title" }).pipe(provideInstanceEffect(directory))
        const svc = yield* Session.Service
        const message = yield* svc.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
          time: { created: Date.now() },
        })
        yield* svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: message.id,
          type: "text",
          text: "validate title payload",
        })

        const response = yield* request(pathFor(SessionPaths.regenerateTitle, { sessionID: session.id }), {
          method: "POST",
          headers: { "x-opencode-directory": directory, "content-type": "application/json" },
          body: JSON.stringify({}),
        })
        expect(response.status).toBe(204)

        const titled = yield* pollWithTimeout(
          Effect.gen(function* () {
            const current = yield* Session.use.get(session.id).pipe(provideInstanceEffect(directory), Effect.orDie)
            return current.title === "Old Title" ? undefined : current.title
          }),
          "payload-repaired title was not regenerated",
          "10 seconds",
        )
        expect(titled).toBe("Validated Title")

        const inputs = yield* llm.inputs
        expect(inputs).toHaveLength(2)
        const repair = JSON.stringify(inputs[1])
        expect(repair).toContain("Protocol error")
        expect(repair).toContain("Protocol correction")
        expect(repair).toContain("host rejected the previous completion")
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
    20_000,
  )

  it.live("regenerateTitle rejects missing structured output and leaves the title untouched", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      // No generated_title tool call is an invalid terminal response and must
      // never be inferred into a title from prose or an empty completion.
      yield* llm.push(reply().stop().item(), reply().stop().item())

      const config = testProviderConfig(llm.url)
      const directory = yield* tmpdirScoped({ git: true, config })
      const session = yield* createSession({ title: "Keep Me" }).pipe(provideInstanceEffect(directory))
      const svc = yield* Session.Service
      const message = yield* svc.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: session.id,
        agent: "build",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
        time: { created: Date.now() },
      })
      yield* svc.updatePart({
        id: PartID.ascending(),
        sessionID: session.id,
        messageID: message.id,
        type: "text",
        text: "hello",
      })

      const response = yield* request(pathFor(SessionPaths.regenerateTitle, { sessionID: session.id }), {
        method: "POST",
        headers: { "x-opencode-directory": directory, "content-type": "application/json" },
        body: JSON.stringify({}),
      })
      expect(response.status).toBe(503)

      // Give the background generation a moment to run, then confirm no write.
      yield* llm.wait(1)
      const current = yield* Session.use.get(session.id).pipe(provideInstanceEffect(directory), Effect.orDie)
      expect(current.title).toBe("Keep Me")
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
  )

  it.instance(
    "permission auto-accept policy route settles a pending ask without renderer delivery",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.addFinalizer(() => Effect.promise(() => AutoAcceptPolicy.remove(test.directory)))
        const permission = yield* Permission.Service
        const sessionID = SessionID.descending()
        const ask = yield* permission
          .ask({
            sessionID,
            permission: "bash",
            patterns: ["echo hidden"],
            always: [],
            metadata: {},
            ruleset: [],
          })
          .pipe(Effect.forkScoped)
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const pending = yield* permission.list()
            return pending.length === 1 ? pending : undefined
          }),
          "permission did not become pending",
        )

        const query = new URLSearchParams({ directory: test.directory })
        const response = yield* request(`/permission/auto-accept?${query}`, {
          method: "PUT",
          headers: { "x-opencode-directory": test.directory, "content-type": "application/json" },
          body: JSON.stringify({ autoAccept: { "*": true }, mode: "patch" }),
        })
        expect(response.status).toBe(200)
        expect(yield* responseJson(response)).toBe(true)
        yield* awaitWithTimeout(Fiber.await(ask), "sidecar did not settle the permission")
        expect(yield* permission.list()).toHaveLength(0)

        // A second renderer may hydrate an older full preference snapshot. Hydration
        // only fills absent keys and cannot overwrite the sidecar's explicit choice.
        const hydrate = yield* request(`/permission/auto-accept?${query}`, {
          method: "PUT",
          headers: { "x-opencode-directory": test.directory, "content-type": "application/json" },
          body: JSON.stringify({ autoAccept: { "*": false, stale_window_session: false }, mode: "hydrate" }),
        })
        expect(hydrate.status).toBe(200)
        const durable = yield* Effect.promise(() => AutoAcceptPolicy.get(test.directory))
        expect(durable.current.autoAccept["*"]).toBe(true)
        expect(durable.current.autoAccept.stale_window_session).toBe(false)
      }),
    { git: true },
    15_000,
  )
})
