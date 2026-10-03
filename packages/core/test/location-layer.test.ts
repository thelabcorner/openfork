import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { DateTime, Effect, Equal, Hash, Schema } from "effect"
import { Tool } from "@opencode-ai/core/tool/tool"
import { define } from "@opencode-ai/plugin/v2/effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Catalog } from "@opencode-ai/core/catalog"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { canonicalLocationRef, LocationServiceMap } from "@opencode-ai/core/location-services"
import { Location } from "@opencode-ai/core/location"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { ProviderRouteIntent } from "@opencode-ai/schema/model-select/provider-route-intent"
import { ProviderPublicRouteHealthTable } from "@opencode-ai/core/provider-route-health.sql"
import { ProviderRouteBindingTable } from "@opencode-ai/core/provider-route.sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import {
  resetHostedCatalogForTest,
  setHostedCatalogForTest,
} from "@opencode-ai/core/plugin/provider/opencode-hosted"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolDefinitions } from "./lib/tool"
import { FSUtil } from "../src/fs-util"
import { Credential } from "../src/credential"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { Global } from "../src/global"
import { ModelsDev } from "../src/models-dev"
import { Npm } from "../src/npm"
import { Project } from "../src/project"
import { Reference } from "../src/reference"
import { ToolRegistry } from "../src/tool/registry"
import { ApplicationTools } from "../src/tool/application-tools"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ApplicationTools.node, Database.node, EventV2.node, LocationServiceMap.node])),
)

describe("LocationServiceMap", () => {
  it.live("reuses cached services for constructed and decoded location refs", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.scoped(
          Effect.gen(function* () {
            const locations = yield* LocationServiceMap.Service
            const directory = AbsolutePath.make(dir.path)
            const constructed = Location.Ref.make({ directory })
            const decoded = Schema.decodeUnknownSync(Location.Ref)({ directory })

            expect(constructed).toEqual({ directory, workspaceID: undefined })
            expect(decoded).toEqual(constructed)
            expect(Equal.equals(constructed, decoded)).toBe(true)
            expect(Hash.hash(constructed)).toBe(Hash.hash(decoded))
            expect(yield* locations.contextEffect(constructed)).toBe(yield* locations.contextEffect(decoded))
          }),
        ),
      ),
    ),
  )

  it.live("canonicalizes filesystem aliases before location cache lookup", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.scoped(
          Effect.gen(function* () {
            const locations = yield* LocationServiceMap.Service
            const canonical = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
            const aliasPath =
              process.platform === "win32" ? dir.path.replaceAll("\\", "/") : `${dir.path}${path.sep}.`
            const alias = Location.Ref.make({ directory: AbsolutePath.make(aliasPath) })

            expect(canonicalLocationRef(alias).directory).toBe(canonicalLocationRef(canonical).directory)
            expect(yield* locations.contextEffect(canonical)).toBe(yield* locations.contextEffect(alias))
          }),
        ),
      ),
    ),
  )

  it.live("isolates location state while sharing location policy with catalog", () =>
    Effect.acquireRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      (dirs) => Effect.promise(() => Promise.all(dirs.map((dir) => dir[Symbol.asyncDispose]())).then(() => undefined)),
    ).pipe(
      Effect.flatMap(([blocked, allowed]) =>
        Effect.gen(function* () {
          yield* (yield* ApplicationTools.Service).register({
            application_context: Tool.make({
              description: "Read application context",
              input: Schema.Struct({}),
              output: Schema.Struct({ ok: Schema.Boolean }),
              execute: () => Effect.succeed({ ok: true }),
            }),
          })
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(blocked.path, "opencode.json"),
              JSON.stringify({
                experimental: { policies: [{ effect: "deny", action: "provider.use", resource: "test" }] },
              }),
            ),
          )

          const update = (directory: string) =>
            Effect.gen(function* () {
              yield* Reference.Service
              const catalog = yield* Catalog.Service
              yield* catalog.transform((editor) => editor.provider.update(ProviderV2.ID.make("test"), () => {}))
              return {
                providers: yield* catalog.provider.all(),
                tools: yield* toolDefinitions(yield* ToolRegistry.Service),
              }
            }).pipe(
              Effect.scoped,
              Effect.provide(
                LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(directory) })),
              ),
            )

          const blockedState = yield* update(blocked.path)
          expect(blockedState.providers.some((provider) => provider.id === ProviderV2.ID.make("test"))).toBe(false)
          expect(blockedState.tools.map((tool) => tool.name).sort()).toEqual([
            "application_context",
            "apply_patch",
            "bash",
            "edit",
            "glob",
            "goal",
            "grep",
            "question",
            "read",
            "skill",
            "todowrite",
            "webfetch",
            "websearch",
            "write",
          ])
          const allowedState = yield* update(allowed.path)
          expect(allowedState.providers.some((provider) => provider.id === ProviderV2.ID.make("test"))).toBe(true)
          expect(allowedState.tools.map((tool) => tool.name).sort()).toEqual([
            "application_context",
            "apply_patch",
            "bash",
            "edit",
            "glob",
            "goal",
            "grep",
            "question",
            "read",
            "skill",
            "todowrite",
            "webfetch",
            "websearch",
            "write",
          ])
        }),
      ),
    ),
  )

  it.live("rejects an unavailable selected model during location model resolution", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(dir.path, "opencode.json"),
              JSON.stringify({
                providers: {
                  unavailable: {
                    name: "Unavailable",
                    api: { type: "native", settings: {} },
                    models: { chat: { disabled: true } },
                  },
                },
              }),
            ),
          )
          const failure = yield* SessionRunnerModel.Service.use((models) =>
            models.resolve(
              SessionV2.Info.make({
                id: SessionV2.ID.make("ses_unavailable_model"),
                projectID: ProjectV2.ID.global,
                title: "test",
                model: {
                  id: ModelV2.ID.make("chat"),
                  providerID: ProviderV2.ID.make("unavailable"),
                },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
                location,
              }),
            ),
          ).pipe(Effect.provide(LocationServiceMap.Service.get(location)), Effect.flip)

          expect(failure).toMatchObject({
            _tag: "SessionRunnerModel.ModelUnavailableError",
            providerID: "unavailable",
            modelID: "chat",
          })
        }),
      ),
    ),
  )

  it.live("Core/current Public routing consumes durable route health before bind and recovers when health clears", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const { db, readDb } = yield* Database.Service
          const directory = AbsolutePath.make(dir.path)
          const location = Location.Ref.make({ directory })
          const providerID = ProviderV2.ID.opencode
          const modelID = ModelV2.ID.make("public-health-test")
          const sessionID = SessionV2.ID.make("ses_core_public_health")
          const now = Date.now()

          yield* db
            .insert(ProjectTable)
            .values({
              id: ProjectV2.ID.global,
              worktree: directory,
              sandboxes: [],
            })
            .onConflictDoNothing()
            .run()
            .pipe(Effect.orDie)
          yield* db
            .insert(SessionTable)
            .values({
              id: sessionID,
              project_id: ProjectV2.ID.global,
              slug: sessionID,
              directory,
              title: "Core Public health test",
              version: "test",
              model: { id: modelID, providerID },
            })
            .run()
            .pipe(Effect.orDie)
          yield* db
            .insert(ProviderPublicRouteHealthTable)
            .values({
              provider_id: providerID,
              model_id: modelID,
              state: "quota-exhausted",
              expires_at: now + 60_000,
              observed_at: now,
            })
            .run()
            .pipe(Effect.orDie)

          setHostedCatalogForTest([modelID], now)
          yield* Effect.addFinalizer(() => Effect.sync(resetHostedCatalogForTest))

          const session = SessionV2.Info.make({
            id: sessionID,
            projectID: ProjectV2.ID.global,
            title: "Core Public health test",
            model: { id: modelID, providerID },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: DateTime.makeUnsafe(now), updated: DateTime.makeUnsafe(now) },
            location,
          })

          yield* Effect.gen(function* () {
            const catalog = yield* Catalog.Service
            yield* catalog.transform((editor) => {
              editor.provider.update(providerID, (provider) => {
                provider.name = "OpenCode Public Health"
                provider.api = {
                  type: "aisdk",
                  package: "@ai-sdk/openai-compatible",
                  url: "https://opencode.test/v1",
                  settings: {},
                }
                provider.request = {
                  headers: {},
                  body: { apiKey: "catalog-only-availability-sentinel" },
                }
                provider.integrationID = undefined
                provider.disabled = false
              })
              editor.model.update(providerID, modelID, (model) => {
                model.name = "Public health test"
                model.api = {
                  id: modelID,
                  type: "aisdk",
                  package: "@ai-sdk/openai-compatible",
                  url: "https://opencode.test/v1",
                  settings: {},
                }
                model.capabilities = { tools: true, input: ["text"], output: ["text"] }
                model.request = { headers: {}, body: {} }
                model.variants = []
                model.time = { released: 0 }
                model.cost = [
                  {
                    input: 0,
                    output: 0,
                    cache: { read: 0, write: 0 },
                    tier: undefined,
                  },
                ]
                model.status = "active"
                model.enabled = true
                model.limit = { context: 100, output: 20 }
              })
            })

            const models = yield* SessionRunnerModel.Service
            const blocked = yield* models
              .resolveWithInfo(session, ProviderRouteIntent.Info.make({ kind: "public" }))
              .pipe(Effect.flip)
            expect(blocked).toMatchObject({
              _tag: "SessionRunnerModel.RouteUnavailableError",
              providerID,
              modelID,
            })
            expect(yield* readDb.select().from(ProviderRouteBindingTable).all()).toEqual([])

            yield* db.delete(ProviderPublicRouteHealthTable).run().pipe(Effect.orDie)

            const resolved = yield* models.resolveWithInfo(
              session,
              ProviderRouteIntent.Info.make({ kind: "public" }),
            )
            expect(resolved.route).toMatchObject({
              providerID,
              routeKind: "public",
              routeRevision: 1,
            })
            expect(
              (yield* readDb.select().from(ProviderRouteBindingTable).all()).map((row) => ({
                providerID: row.provider_id,
                routeKind: row.route_kind,
                accountID: row.account_id,
                credentialHandle: row.credential_handle,
              })),
            ).toEqual([
              {
                providerID,
                routeKind: "public",
                accountID: null,
                credentialHandle: null,
              },
            ])
          }).pipe(
            Effect.scoped,
            Effect.provide(LocationServiceMap.Service.get(location)),
          )
        }),
      ),
    ),
  )

  it.live("installs public plugins into a location", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const plugins = yield* PluginV2.Service
          const reviewer = define({
            id: "reviewer",
            effect: (ctx) =>
              ctx.agent
                .transform((agent) => {
                  agent.update("reviewer", (item) => {
                    item.description = "Reviews code"
                    item.mode = "subagent"
                  })
                })
                .pipe(Effect.asVoid),
          })
          yield* plugins.add(PluginV2.ID.make(reviewer.id), reviewer.effect)

          expect(yield* (yield* AgentV2.Service).get(AgentV2.ID.make("reviewer"))).toMatchObject({
            description: "Reviews code",
            mode: "subagent",
          })
        }).pipe(
          Effect.scoped,
          Effect.provide(LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(dir.path) }))),
        ),
      ),
    ),
  )
})
