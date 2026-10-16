import { describe, expect } from "bun:test"
import { DateTime, Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { canonicalLocationRef, LocationServiceMap } from "@opencode-ai/core/location-services"
import { Location } from "@opencode-ai/core/location"
import { Catalog } from "@opencode-ai/core/catalog"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { ProviderRouteBindingTable } from "@opencode-ai/core/provider-route.sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import {
  resetHostedCatalogForTest,
  setHostedCatalogForTest,
} from "@opencode-ai/core/plugin/provider/opencode-hosted"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { ApplicationTools } from "../src/tool/application-tools"

/**
 * Core special-agent route-inheritance proof.
 *
 * Host-owned maintenance resolution (`resolveMaintenanceWithInfo`) must never
 * select, bind, rebind, or fail over the parent Session's durable
 * ProviderRoute. Same-provider maintenance inherits the existing exact route
 * generation; everything else resolves one transient route or, only when the
 * route owner positively declines, uses direct provider lookup. These tests
 * fail if maintenance creates a durable row, advances a revision, fails over
 * a dead binding, or serves hosted models through ambient auth.
 */

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ApplicationTools.node, Database.node, EventV2.node, LocationServiceMap.node])),
)

const hostedProviderID = ProviderV2.ID.opencode
const hostedModelID = ModelV2.ID.make("maintenance-public-test")
const hostedRef = ModelV2.Ref.make({ providerID: hostedProviderID, id: hostedModelID })

const directProviderID = ProviderV2.ID.make("direct-test")
const directModelID = ModelV2.ID.make("direct-v1")
const directRef = ModelV2.Ref.make({ providerID: directProviderID, id: directModelID })

const hostedAffinity = "opencode-provider/opencode"

const registerHostedModel = () =>
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    yield* catalog.transform((editor) => {
      editor.provider.update(hostedProviderID, (provider) => {
        provider.name = "OpenCode Maintenance Test"
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
      editor.model.update(hostedProviderID, hostedModelID, (model) => {
        model.name = "Maintenance public test"
        model.api = {
          id: hostedModelID,
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
  })

const registerDirectModel = () =>
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    yield* catalog.transform((editor) => {
      editor.provider.update(directProviderID, (provider) => {
        provider.name = "Direct Test"
        provider.api = {
          type: "aisdk",
          package: "@ai-sdk/openai-compatible",
          url: "https://direct.test/v1",
          settings: {},
        }
        provider.request = {
          headers: {},
          body: { apiKey: "direct-test-key" },
        }
        provider.integrationID = undefined
        provider.disabled = false
      })
      editor.model.update(directProviderID, directModelID, (model) => {
        model.name = "Direct v1"
        model.api = {
          id: directModelID,
          type: "aisdk",
          package: "@ai-sdk/openai-compatible",
          url: "https://direct.test/v1",
          settings: {},
        }
        model.capabilities = { tools: true, input: ["text"], output: ["text"] }
        model.request = { headers: {}, body: {} }
        model.variants = []
        model.time = { released: 0 }
        model.cost = [
          {
            input: 1,
            output: 1,
            cache: { read: 0, write: 0 },
            tier: undefined,
          },
        ]
        model.status = "active"
        model.enabled = true
        model.limit = { context: 100, output: 20 }
      })
    })
  })

const insertSessionRow = (
  sessionID: SessionV2.ID,
  directory: string,
  model?: { readonly id: string; readonly providerID: string },
) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({
        id: ProjectV2.ID.global,
        worktree: AbsolutePath.make(directory),
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
        directory: AbsolutePath.make(directory),
        title: "Maintenance route test",
        version: "test",
        ...(model ? { model } : {}),
      })
      .run()
      .pipe(Effect.orDie)
  })

const insertBinding = (input: {
  readonly sessionID: SessionV2.ID
  readonly affinityDomain: string
  readonly providerID: string
  readonly routeKind: "public" | "account"
  readonly accountID?: string
  readonly credentialHandle?: string
}) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProviderRouteBindingTable)
      .values({
        session_id: input.sessionID,
        affinity_domain: input.affinityDomain,
        provider_id: input.providerID,
        route_kind: input.routeKind,
        account_id: input.accountID ?? null,
        credential_handle: input.credentialHandle ?? null,
        mode: null,
        pin: null,
        route_revision: 1,
        assigned_at: Date.now(),
        assignment_epoch: 1,
        reason: "initial",
      })
      .run()
      .pipe(Effect.orDie)
  })

const readBindings = () =>
  Effect.gen(function* () {
    const { readDb } = yield* Database.Service
    return yield* readDb.select().from(ProviderRouteBindingTable).all().pipe(Effect.orDie)
  })

const sessionInfo = (
  sessionID: SessionV2.ID,
  location: Location.Ref,
  model?: { readonly id: ModelV2.ID; readonly providerID: ProviderV2.ID },
) =>
  SessionV2.Info.make({
    id: sessionID,
    projectID: ProjectV2.ID.global,
    title: "Maintenance route test",
    ...(model ? { model: { id: model.id, providerID: model.providerID } } : {}),
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location,
  })

const withLocation = <A, E, R>(dir: { readonly path: string }, effect: Effect.Effect<A, E, R>) => {
  const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
  return effect.pipe(
    Effect.scoped,
    Effect.provide(LocationServiceMap.Service.get(location)),
  )
}

describe("Core maintenance resolution never mutates the parent route", () => {
  it.live("rejects hosted Public-only transient routing without creating a ProviderRoute row", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const sessionID = SessionV2.ID.make("ses_maintenance_transient")
          yield* insertSessionRow(sessionID, dir.path, {
            id: hostedModelID,
            providerID: hostedProviderID,
          })
          yield* withLocation(
            dir,
            Effect.gen(function* () {
              yield* registerHostedModel()
              setHostedCatalogForTest([hostedModelID], Date.now())
              yield* Effect.addFinalizer(() => Effect.sync(resetHostedCatalogForTest))

              const models = yield* SessionRunnerModel.Service
              const resolved = yield* models.resolveMaintenanceWithInfo(
                sessionInfo(sessionID, canonicalLocationRef(Location.Ref.make({ directory: AbsolutePath.make(dir.path) })), {
                  id: hostedModelID,
                  providerID: hostedProviderID,
                }),
                 hostedRef,
               ).pipe(Effect.exit)
               // OpenFork special agents cannot execute the upstream-only free tier.
               expect(resolved._tag).toBe("Failure")
               expect(yield* readBindings()).toEqual([])
            }),
          )
        }),
      ),
    ),
  )

  it.live("rejects a committed hosted Public binding without changing its revision", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const sessionID = SessionV2.ID.make("ses_maintenance_inherit")
          yield* insertSessionRow(sessionID, dir.path, {
            id: hostedModelID,
            providerID: hostedProviderID,
          })
          yield* insertBinding({
            sessionID,
            affinityDomain: hostedAffinity,
            providerID: hostedProviderID,
            routeKind: "public",
          })
          yield* withLocation(
            dir,
            Effect.gen(function* () {
              yield* registerHostedModel()
              setHostedCatalogForTest([hostedModelID], Date.now())
              yield* Effect.addFinalizer(() => Effect.sync(resetHostedCatalogForTest))

              const models = yield* SessionRunnerModel.Service
              const resolved = yield* models.resolveMaintenanceWithInfo(
                sessionInfo(sessionID, canonicalLocationRef(Location.Ref.make({ directory: AbsolutePath.make(dir.path) })), {
                  id: hostedModelID,
                  providerID: hostedProviderID,
                }),
                 hostedRef,
               ).pipe(Effect.exit)
               expect(resolved._tag).toBe("Failure")
               const rows = yield* readBindings()
              expect(rows.length).toBe(1)
              expect(rows[0]).toMatchObject({
                route_kind: "public",
                route_revision: 1,
                account_id: null,
                credential_handle: null,
              })
            }),
          )
        }),
      ),
    ),
  )

  it.live("an unavailable maintenance model fails without touching the parent route", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const sessionID = SessionV2.ID.make("ses_maintenance_unavailable")
          yield* insertSessionRow(sessionID, dir.path, {
            id: hostedModelID,
            providerID: hostedProviderID,
          })
          yield* insertBinding({
            sessionID,
            affinityDomain: hostedAffinity,
            providerID: hostedProviderID,
            routeKind: "public",
          })
          yield* withLocation(
            dir,
            Effect.gen(function* () {
              yield* registerHostedModel()
              setHostedCatalogForTest([hostedModelID], Date.now())
              yield* Effect.addFinalizer(() => Effect.sync(resetHostedCatalogForTest))

              const models = yield* SessionRunnerModel.Service
              const failure = yield* models
                .resolveMaintenanceWithInfo(
                  sessionInfo(
                    sessionID,
                    canonicalLocationRef(Location.Ref.make({ directory: AbsolutePath.make(dir.path) })),
                    { id: hostedModelID, providerID: hostedProviderID },
                  ),
                  ModelV2.Ref.make({
                    providerID: hostedProviderID,
                    id: ModelV2.ID.make("no-such-model"),
                  }),
                )
                .pipe(Effect.flip)
              expect(failure).toMatchObject({ _tag: "SessionRunnerModel.ModelUnavailableError" })
              const rows = yield* readBindings()
              expect(rows.length).toBe(1)
              expect(rows[0]).toMatchObject({ route_kind: "public", route_revision: 1 })
            }),
          )
        }),
      ),
    ),
  )

  it.live("a dead account binding fails closed instead of failing over or rebinding", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const sessionID = SessionV2.ID.make("ses_maintenance_stale")
          yield* insertSessionRow(sessionID, dir.path, {
            id: hostedModelID,
            providerID: hostedProviderID,
          })
          yield* insertBinding({
            sessionID,
            affinityDomain: hostedAffinity,
            providerID: hostedProviderID,
            routeKind: "account",
            accountID: "acct_gone",
            credentialHandle: "cred_gone",
          })
          yield* withLocation(
            dir,
            Effect.gen(function* () {
              yield* registerHostedModel()
              setHostedCatalogForTest([hostedModelID], Date.now())
              yield* Effect.addFinalizer(() => Effect.sync(resetHostedCatalogForTest))

              const models = yield* SessionRunnerModel.Service
              const failure = yield* models
                .resolveMaintenanceWithInfo(
                  sessionInfo(
                    sessionID,
                    canonicalLocationRef(Location.Ref.make({ directory: AbsolutePath.make(dir.path) })),
                    { id: hostedModelID, providerID: hostedProviderID },
                  ),
                  hostedRef,
                )
                .pipe(Effect.flip)
              expect(failure).toMatchObject({ _tag: "SessionRunnerModel.RouteUnavailableError" })
              // No failover bind, no rebind, no revision advance.
              const rows = yield* readBindings()
              expect(rows.length).toBe(1)
              expect(rows[0]).toMatchObject({
                route_kind: "account",
                account_id: "acct_gone",
                route_revision: 1,
              })
            }),
          )
        }),
      ),
    ),
  )

  it.live("an explicit cross-provider override uses a transient route and adds no durable row", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const sessionID = SessionV2.ID.make("ses_maintenance_override")
          yield* insertSessionRow(sessionID, dir.path, {
            id: hostedModelID,
            providerID: hostedProviderID,
          })
          yield* insertBinding({
            sessionID,
            affinityDomain: hostedAffinity,
            providerID: hostedProviderID,
            routeKind: "public",
          })
          yield* withLocation(
            dir,
            Effect.gen(function* () {
              yield* registerHostedModel()
              yield* registerDirectModel()
              setHostedCatalogForTest([hostedModelID], Date.now())
              yield* Effect.addFinalizer(() => Effect.sync(resetHostedCatalogForTest))

              const models = yield* SessionRunnerModel.Service
              const resolved = yield* models.resolveMaintenanceWithInfo(
                sessionInfo(
                  sessionID,
                  canonicalLocationRef(Location.Ref.make({ directory: AbsolutePath.make(dir.path) })),
                  { id: hostedModelID, providerID: hostedProviderID },
                ),
                directRef,
                { explicitOverride: true },
              )
              // Outside the route owner's domain: direct provider model, no
              // attribution, and the parent binding is untouched.
              expect(resolved.model).toBeDefined()
              expect(resolved.route).toBeUndefined()
              const rows = yield* readBindings()
              expect(rows.length).toBe(1)
              expect(rows[0]).toMatchObject({
                affinity_domain: hostedAffinity,
                route_kind: "public",
                route_revision: 1,
              })
            }),
          )
        }),
      ),
    ),
  )

  it.live("an explicit same-provider override cannot select hosted Public", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const sessionID = SessionV2.ID.make("ses_maintenance_same_override")
          yield* insertSessionRow(sessionID, dir.path, {
            id: hostedModelID,
            providerID: hostedProviderID,
          })
          yield* insertBinding({
            sessionID,
            affinityDomain: hostedAffinity,
            providerID: hostedProviderID,
            routeKind: "public",
          })
          yield* withLocation(
            dir,
            Effect.gen(function* () {
              yield* registerHostedModel()
              setHostedCatalogForTest([hostedModelID], Date.now())
              yield* Effect.addFinalizer(() => Effect.sync(resetHostedCatalogForTest))

              const models = yield* SessionRunnerModel.Service
              const resolved = yield* models.resolveMaintenanceWithInfo(
                sessionInfo(
                  sessionID,
                  canonicalLocationRef(Location.Ref.make({ directory: AbsolutePath.make(dir.path) })),
                  { id: hostedModelID, providerID: hostedProviderID },
                ),
                 hostedRef,
                 { explicitOverride: true },
               ).pipe(Effect.exit)
               expect(resolved._tag).toBe("Failure")
              const rows = yield* readBindings()
              expect(rows.length).toBe(1)
              expect(rows[0]).toMatchObject({ route_kind: "public", route_revision: 1 })
            }),
          )
        }),
      ),
    ),
  )

  it.live("a model-less session does not execute the hosted Public catalog default", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const sessionID = SessionV2.ID.make("ses_maintenance_modelless")
          yield* insertSessionRow(sessionID, dir.path)
          yield* withLocation(
            dir,
            Effect.gen(function* () {
              const catalog = yield* Catalog.Service
              yield* registerHostedModel()
              yield* catalog.transform((editor) => {
                editor.model.default.set(hostedProviderID, hostedModelID)
              })
              setHostedCatalogForTest([hostedModelID], Date.now())
              yield* Effect.addFinalizer(() => Effect.sync(resetHostedCatalogForTest))

              const models = yield* SessionRunnerModel.Service
              // No ref and no session model: the worker selection (catalog
              // default) is inherited as non-explicit maintenance, never
              // worker routing, and no durable row is created.
              const resolved = yield* models.resolveMaintenanceWithInfo(
                sessionInfo(
                  sessionID,
                  canonicalLocationRef(Location.Ref.make({ directory: AbsolutePath.make(dir.path) })),
                ),
                 undefined,
               ).pipe(Effect.exit)
               expect(resolved._tag).toBe("Failure")
              expect(yield* readBindings()).toEqual([])
            }),
          )
        }),
      ),
    ),
  )

  it.live("no-session hosted Public selection fails closed without ambient auth", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          yield* withLocation(
            dir,
            Effect.gen(function* () {
              yield* registerHostedModel()
              setHostedCatalogForTest([hostedModelID], Date.now())
              yield* Effect.addFinalizer(() => Effect.sync(resetHostedCatalogForTest))

              const models = yield* SessionRunnerModel.Service
               const resolved = yield* models.resolveMaintenanceWithInfo(undefined, hostedRef).pipe(Effect.exit)
               expect(resolved._tag).toBe("Failure")
              expect(yield* readBindings()).toEqual([])
            }),
          )
        }),
      ),
    ),
  )

  it.live("no-session third-party resolution uses direct lookup only after the route owner declines", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          yield* withLocation(
            dir,
            Effect.gen(function* () {
              yield* registerDirectModel()

              const models = yield* SessionRunnerModel.Service
              const resolved = yield* models.resolveMaintenanceWithInfo(undefined, directRef)
              expect(resolved.model).toBeDefined()
              expect(resolved.route).toBeUndefined()
              expect(yield* readBindings()).toEqual([])
            }),
          )
        }),
      ),
    ),
  )
})
