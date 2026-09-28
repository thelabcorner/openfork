import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Context, DateTime, Effect, Layer, Option, Ref } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Credential } from "@opencode-ai/core/credential"
import { EventV2 } from "@opencode-ai/core/event"
import { OfxpInvocation } from "@opencode-ai/core/ofxp-invocation"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { ScheduledTask } from "@opencode-ai/core/scheduled-task"
import { ScheduledTaskSessionBinding } from "@opencode-ai/core/scheduled-task/session-binding"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { SessionUsage } from "@opencode-ai/core/session/usage"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { RevisionDraft } from "@opencode-ai/core/revision-draft"
import { OxpActivity } from "@opencode-ai/core/oxp-activity/activity"
import { OxpActivityInspection } from "@opencode-ai/core/oxp-activity/inspection"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { Swarm } from "@opencode-ai/schema/swarm"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { ForkCredentials } from "../../src/fork/credentials"
import { Capacity } from "../../src/capacity/capacity"
import { OfxpRuntime } from "../../src/ofxp/runtime"
import { OfxpRoot } from "../../src/ofxp/root"
import { Usage } from "../../src/usage/usage"
import { Quota } from "../../src/quota/quota"
import { WakaTime } from "@opencode-ai/core/wakatime"
import { Session } from "../../src/session/session"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
import { OfxpPaths } from "../../src/server/routes/instance/httpapi/groups/ofxp"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { forkCredentialHandlers } from "../../src/server/routes/instance/httpapi/handlers/fork-credential"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { ofxpHandlers } from "../../src/server/routes/instance/httpapi/handlers/ofxp"
import { providerSettingsHandlers } from "../../src/server/routes/instance/httpapi/handlers/provider-settings"
import { revisionDraftHandlers } from "../../src/server/routes/instance/httpapi/handlers/revision-draft"
import { scheduledTaskHandlers } from "../../src/server/routes/instance/httpapi/handlers/scheduled-task"
import { swarmHandlers } from "../../src/server/routes/instance/httpapi/handlers/swarm"
import { usageHandlers } from "../../src/server/routes/instance/httpapi/handlers/usage"
import { WakaTimePaths } from "../../src/server/routes/instance/httpapi/groups/wakatime"
import { wakatimeHandlers } from "../../src/server/routes/instance/httpapi/handlers/wakatime"
import { quotaHandlers } from "../../src/server/routes/instance/httpapi/handlers/quota"
import { SwarmMemberSessionWake } from "../../src/swarm/member-session-wake"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

const capturedTaskCreate = Ref.makeUnsafe<Record<string, unknown> | undefined>(undefined)
const capturedOfxpRotations = Ref.makeUnsafe(0)
const capturedOfxpRotationFinalizations = Ref.makeUnsafe(0)
const capturedOfxpServerSeeds = Ref.makeUnsafe<ReadonlyArray<Record<string, unknown>>>([])
const ofxpActivityPeerID = Ofxp.PeerID.make(`ofxp_${"B".repeat(43)}`)
const ofxpActivityReceipt: Ofxp.InvocationReceipt = {
  invocationID: Ofxp.InvocationID.create(),
  sourcePeerID: ofxpActivityPeerID,
  operation: "read",
  commitClass: "safe_read",
  state: "committed",
  targetRef: "/private/host/path",
  resultDigest: `sha256:${"a".repeat(64)}`,
  createdAt: 100,
  settledAt: 101,
}
const ofxpPeerRecord: OfxpPeer.Record = {
  info: {
    id: ofxpActivityPeerID,
    realmID: "realm_http",
    label: "HTTP peer",
    fingerprint: Ofxp.PublicKeyFingerprint.make(`sha256:${"b".repeat(64)}`),
    rekeyState: "stable",
    pairedAt: 80,
    lastSeenAt: 200,
    grantRevision: 1,
  },
  publicKeySpki: "fixture-spki",
  grant: { ...Ofxp.DENY_GRANT },
}
const ofxpLocalPeerID = Ofxp.PeerID.make(`ofxp_${"C".repeat(43)}`)
const httpTask = Swarm.Task.make({
  id: Swarm.TaskID.make("swt_http"),
  swarmID: Swarm.ID.make("swr_http"),
  title: "operator task",
  status: "ready",
  priority: 0,
  reservationRevision: 0,
  leaseGeneration: 0,
  semanticRetryCount: 0,
  acceptance: { criteria: [] },
  metadata: {},
  readyAt: DateTime.makeUnsafe(1),
  time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
})

/**
 * Core owns the exporter. The transport mock therefore exposes exactly the Core
 * `Status` shape - enabled/configured plus the optional resolved CLI and its
 * source - and nothing else. There is deliberately no credential mutation here:
 * enablement authority is the only writable fact on this surface.
 */
const instanceLoads = Ref.makeUnsafe(0)
const wakatimeState = Ref.makeUnsafe<{
  enabled: boolean
  configured: boolean
  cli?: string
  source?: "override" | "system" | "managed"
  failNext: boolean
}>({ enabled: false, configured: true, cli: "/usr/bin/wakatime-cli", source: "system", failNext: false })

const wakatimeStatus = (state: {
  enabled: boolean
  configured: boolean
  cli?: string
  source?: "override" | "system" | "managed"
}) => ({
  enabled: state.enabled,
  configured: state.configured,
  ...(state.cli === undefined ? {} : { cli: state.cli }),
  ...(state.source === undefined ? {} : { source: state.source }),
}) satisfies WakaTime.Status

/**
 * Negative ownership invariant.
 *
 * This layer intentionally does NOT provide InstanceStore, workspace routing,
 * Location, Provider, Plugin, MCP, ToolRegistry, LSP, or any directory runtime.
 * These requests must therefore remain process-global by construction.
 */
const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(RootHttpApi).pipe(
    Layer.provide([
      controlHandlers,
      controlPlaneHandlers,
      forkCredentialHandlers,
      globalHandlers,
      ofxpHandlers,
      providerSettingsHandlers,
      quotaHandlers,
      revisionDraftHandlers,
      scheduledTaskHandlers,
      swarmHandlers,
      usageHandlers,
      wakatimeHandlers,
    ]),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(
    Layer.mock(Auth.Service)({
      all: () => Effect.succeed({}),
      get: () => Effect.succeed(undefined),
    }),
  ),
  Layer.provide(
    Layer.mock(Config.Service)({
      getGlobal: () => Effect.succeed({}),
    }),
  ),
  Layer.provide(
    Layer.mock(ForkCredentials.Service)({
      list: () => Effect.succeed([]),
      usageByCredential: () => Effect.succeed({ byCredential: new Map(), unattributed: [] }),
    }),
  ),
  Layer.provide(
    Layer.mock(SessionUsage.Service)({
      windows: () => Effect.succeed([]),
    }),
  ),
  Layer.provide(
    Layer.mock(Quota.Service)({
      providers: () => Effect.succeed({ providers: [] }),
      get: () => Effect.die("unused quota get"),
      resets: ({ from, to }) =>
        Effect.succeed({ from, to, generatedAt: from, occurrences: [], failures: [] }),
    }),
  ),
  Layer.provide(
    Layer.mock(Capacity.Service)({
      go: () =>
        Effect.succeed({
          providerID: "opencode-go",
          priorStatus: "ok",
          priorFetchedAt: 0,
          routed: [],
          accounts: [],
        }),
    }),
  ),
  Layer.provide(Layer.mock(MoveSession.Service)({})),
  Layer.provide(
    Layer.mock(ModelsDev.Service)({
      get: () => Effect.succeed({}),
      refresh: () => Effect.void,
    }),
  ),
  Layer.provide(
    Layer.mock(Credential.Service)({
      all: () => Effect.succeed([]),
    }),
  ),
  Layer.provide(
    Layer.mock(EventV2.Service)({
      publish: () => Effect.succeed({} as never),
    }),
  ),
  Layer.provide([
    Layer.mock(OfxpInvocation.Service)({
      recentByPeer: () => Effect.succeed([{ sourcePeerID: ofxpActivityPeerID, receipts: [ofxpActivityReceipt] }]),
    }),
    Layer.mock(OfxpRuntime.Service)({
      status: () =>
        Effect.succeed({
          active: true,
          peerID: ofxpLocalPeerID,
          label: "Local OpenFork",
          port: 7331,
          discovery: "active",
          identityRotationSupported: true,
        }),
      rotateIdentity: (expectedPeerID) =>
        expectedPeerID !== ofxpLocalPeerID
          ? Effect.fail(
              new OfxpRuntime.ConflictError({
                detail: `OFXP identity changed concurrently (expected ${expectedPeerID}, current ${ofxpLocalPeerID})`,
              }),
            )
          : Ref.update(capturedOfxpRotations, (count) => count + 1).pipe(
              Effect.as({
                active: true,
                peerID: ofxpLocalPeerID,
                label: "Local OpenFork",
                port: 7331,
                discovery: "active" as const,
                identityRotationSupported: true,
              }),
            ),
      finalizeIdentityRotation: (expectedPeerID) =>
        expectedPeerID !== ofxpLocalPeerID
          ? Effect.fail(
              new OfxpRuntime.ConflictError({
                detail: `OFXP identity changed concurrently (expected ${expectedPeerID}, current ${ofxpLocalPeerID})`,
              }),
            )
          : Ref.update(capturedOfxpRotationFinalizations, (count) => count + 1).pipe(
              Effect.as({
                active: true,
                peerID: ofxpLocalPeerID,
                label: "Local OpenFork",
                port: 7331,
                discovery: "active" as const,
                identityRotationSupported: true,
              }),
            ),
      replaceServerSeeds: (seeds) =>
        Ref.set(capturedOfxpServerSeeds, seeds as unknown as ReadonlyArray<Record<string, unknown>>).pipe(
          Effect.as(seeds.length),
        ),
      candidates: () =>
        Effect.succeed([
          {
            peerID: ofxpActivityPeerID,
            realmID: "realm_http",
            openforkVersion: "1.18.30",
            protocolVersion: 1,
            pairing: true,
            instances: [
              {
                source: "mdns" as const,
                id: "peer.local",
                fqdn: "peer.local",
                endpoint: { host: "peer.local", port: 7443, addresses: ["192.0.2.10"] },
              },
            ],
            lastSeenAt: 200,
          },
        ]),
      connectionStatuses: () =>
        Effect.succeed([
          {
            peerID: ofxpActivityPeerID,
            endpoint: { host: "192.0.2.10", port: 7443 },
            pendingRequests: 2,
          },
        ]),
      pairingPreviews: () => Effect.succeed([]),
    }),
    Layer.mock(OfxpRoot.Service)({
      approve: (peerID, _candidate, alias, source, expectedGrantRevision) =>
        expectedGrantRevision === ofxpPeerRecord.info.grantRevision
          ? Effect.succeed({
              id: Ofxp.RootID.create(),
              alias: Ofxp.RootAlias.make(alias ?? "root"),
              available: true,
              source: source ?? "manual",
              approvedAt: 100,
            })
          : Effect.fail(
              new OfxpPeer.OfxpPeerSchema.StaleRevisionError({
                peerID,
                expectedRevision: expectedGrantRevision ?? 0,
                actualRevision: ofxpPeerRecord.info.grantRevision,
              }),
            ),
    }),
    Layer.mock(OfxpPeer.Service)({
      overview: () => Effect.succeed([{ record: ofxpPeerRecord, roots: [] }]),
      setGrant: (input) =>
        Effect.fail(
          new OfxpPeer.OfxpPeerSchema.StaleRevisionError({
            peerID: input.peerID,
            expectedRevision: input.expectedRevision,
            actualRevision: input.expectedRevision + 1,
          }),
        ),
      revokeFenced: (input) =>
        input.expectedRevision === ofxpPeerRecord.info.grantRevision
          ? Effect.succeed(true)
          : Effect.fail(
              new OfxpPeer.OfxpPeerSchema.StaleRevisionError({
                peerID: input.peerID,
                expectedRevision: input.expectedRevision,
                actualRevision: ofxpPeerRecord.info.grantRevision,
              }),
            ),
      approveRoot: (input) =>
        input.expectedGrantRevision === ofxpPeerRecord.info.grantRevision
          ? Effect.succeed({
              id: Ofxp.RootID.create(),
              alias: Ofxp.RootAlias.make(input.alias),
              available: true,
              source: input.source ?? "manual",
              approvedAt: input.now ?? 100,
            })
          : Effect.fail(
              new OfxpPeer.OfxpPeerSchema.StaleRevisionError({
                peerID: input.peerID,
                expectedRevision: input.expectedGrantRevision ?? 0,
                actualRevision: ofxpPeerRecord.info.grantRevision,
              }),
            ),
      subscribe: () => () => {},
    }),
  ]),
  Layer.provide(
    Layer.mock(Session.Service)({
      listGlobal: () => Effect.succeed([]),
    }),
  ),
  Layer.provide(Layer.mock(ScheduledTask.Service)({})),
  Layer.provide(Layer.mock(ScheduledTaskSessionBinding.Service)({})),
  Layer.provide(
    Layer.mock(SwarmV2.Service)({
      summaries: () => Effect.succeed([]),
      info: (id) => Effect.succeed({ id } as never),
      update: (input) =>
        Effect.fail(
          new SwarmV2.SwarmSchema.StaleRevisionError({
            swarmID: input.id,
            expectedRevision: input.expectedRevision,
            actualRevision: input.expectedRevision + 1,
          }),
        ),
      configureMember: (input) =>
        Effect.fail(
          new SwarmV2.SwarmSchema.StaleFenceError({
            fence: "member_binding",
            id: input.memberID,
            expectedGeneration: input.expectedBindingGeneration,
            actualGeneration: input.expectedBindingGeneration + 1,
          }),
        ),
      createTask: (input) =>
        Ref.set(capturedTaskCreate, input as unknown as Record<string, unknown>).pipe(
          Effect.as(httpTask),
        ),
    }),
  ),
  Layer.provide(
    Layer.mock(SwarmMemberSessionWake.Service)({
      request: () => Effect.succeed(false),
    }),
  ),
  Layer.provide(
    Layer.mock(WakaTime.Service)({
      status: () => Ref.get(wakatimeState).pipe(Effect.map(wakatimeStatus)),
      setEnabled: (enabled: boolean) =>
        Ref.get(wakatimeState).pipe(
          Effect.flatMap((state) =>
            state.failNext
              ? Effect.fail(new Error("Unable to persist WakaTime settings"))
              : Ref.update(wakatimeState, (current) => ({ ...current, enabled })).pipe(
                  Effect.andThen(Ref.get(wakatimeState).pipe(Effect.map(wakatimeStatus))),
                ),
          ),
        ),
    }),
  ),
  Layer.provide(
    Layer.mock(OxpActivity.Service)({
      rename: () => Effect.succeed(false),
      archive: () => Effect.succeed(false),
      deleteHistory: () => Effect.succeed(false),
    }),
  ),
  Layer.provide(
    Layer.mock(OxpActivityInspection.Service)({
      list: () => Effect.succeed([]),
      get: () => Effect.succeed(undefined),
      invocations: () =>
        Effect.succeed({ items: [], links: [], more: false }),
      resource: () => Effect.succeed([]),
    }),
  ),
  Layer.provide(
    Layer.mock(RevisionDraft.Service)({
      recover: () => Effect.succeed(undefined),
      consume: () => Effect.void,
    }),
  ),
  Layer.provide(
    Layer.mock(Usage.Service)({
      summary: () => Effect.die("unused usage summary"),
      modelProfile: () => Effect.succeed({ models: [] }),
      pricingCatalog: () => Effect.succeed({ models: [] }),
      recordMaintenance: () => Effect.void,
    }),
  ),
  Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode", publicUrl: "" })),
)

const it = testEffect(apiLayer)

describe("Tier-0 root ownership", () => {
  it.live("serves provider settings without a workspace runtime", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get("/provider-settings").pipe(HttpClient.execute)
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ providers: [] })
    }),
  )

  it.live("serves provider settings models without a workspace runtime", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get("/provider-settings/models").pipe(HttpClient.execute)
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ models: [] })
    }),
  )

  it.live("serves usage model profile without a workspace runtime", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get("/usage/model-profile").pipe(HttpClient.execute)
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ models: [] })
    }),
  )

  it.live("serves the quota reset agenda from the root Tier-0 graph without a workspace runtime", () =>
    Effect.gen(function* () {
      const from = 1_700_000_000_000
      const to = from + 24 * 60 * 60 * 1000
      const response = yield* HttpClientRequest.get(`/quota/resets?from=${from}&to=${to}`).pipe(HttpClient.execute)
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({
        from,
        to,
        generatedAt: from,
        occurrences: [],
        failures: [],
      })
    }),
  )

  it.live("serves Go capacity without a workspace runtime", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get("/fork/capacity").pipe(HttpClient.execute)
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({
        providerID: "opencode-go",
        priorStatus: "ok",
        priorFetchedAt: 0,
        routed: [],
        accounts: [],
      })
    }),
  )

  it.live("serves OFXP settings state without InstanceStore or a workspace runtime", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(OfxpPaths.state).pipe(HttpClient.execute)
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({
        status: {
          active: true,
          peerID: ofxpLocalPeerID,
          label: "Local OpenFork",
          port: 7331,
          discovery: "active",
          identityRotationSupported: true,
        },
        candidates: [
          {
            peerID: ofxpActivityPeerID,
            realmID: "realm_http",
            openforkVersion: "1.18.30",
            protocolVersion: 1,
            pairing: true,
            endpointCount: 1,
            lastSeenAt: 200,
          },
        ],
        pairings: [],
        peers: [
          {
            info: ofxpPeerRecord.info,
            grant: ofxpPeerRecord.grant,
            roots: [],
            online: true,
            openforkVersion: "1.18.30",
            protocolVersion: 1,
            authenticatedEndpoint: {
              host: "192.0.2.10",
              port: 7443,
              pendingRequests: 2,
            },
          },
        ],
        activity: [
          {
            sourcePeerID: ofxpActivityPeerID,
            operation: "read",
            commitClass: "safe_read",
            state: "committed",
            createdAt: 100,
            settledAt: 101,
          },
        ],
      })
    }),
  )

  it.live("rotates OFXP identity through the Tier-0 operator surface without a workspace runtime", () =>
    Effect.gen(function* () {
      yield* Ref.set(capturedOfxpRotations, 0)
      const response = yield* HttpClientRequest.post(OfxpPaths.rotateIdentity).pipe(
        HttpClientRequest.setBody(HttpBody.jsonUnsafe({ expectedPeerID: ofxpLocalPeerID })),
        HttpClient.execute,
      )
      expect(response.status).toBe(200)
      expect(yield* Ref.get(capturedOfxpRotations)).toBe(1)
      expect(yield* response.json).toMatchObject({
        status: {
          active: true,
          peerID: ofxpLocalPeerID,
          identityRotationSupported: true,
        },
      })
    }),
  )

  it.live("reconciles configured-server OFXP discovery seeds without a workspace runtime", () =>
    Effect.gen(function* () {
      yield* Ref.set(capturedOfxpServerSeeds, [])
      const seedPeerID = Ofxp.PeerID.make(`ofxp_${"E".repeat(43)}`)
      const response = yield* HttpClientRequest.put(OfxpPaths.serverSeeds).pipe(
        HttpClientRequest.setBody(
          HttpBody.jsonUnsafe({
            seeds: [
              {
                id: "configured:http://remote.example",
                peerID: seedPeerID,
                realmID: "realm:remote",
                openforkVersion: "1.18.30",
                protocolVersion: 1,
                pairing: true,
                endpoint: {
                  host: "remote.example",
                  port: 9443,
                  addresses: ["192.0.2.44"],
                },
              },
            ],
          }),
        ),
        HttpClient.execute,
      )
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ accepted: 1 })
      expect(yield* Ref.get(capturedOfxpServerSeeds)).toEqual([
        {
          source: "server",
          id: "configured:http://remote.example",
          peerID: seedPeerID,
          realmID: "realm:remote",
          openforkVersion: "1.18.30",
          protocolVersion: 1,
          pairing: true,
          endpoint: {
            host: "remote.example",
            port: 9443,
            addresses: ["192.0.2.44"],
          },
        },
      ])
    }),
  )

  it.live("finalizes OFXP identity rotation through the Tier-0 operator surface without a workspace runtime", () =>
    Effect.gen(function* () {
      yield* Ref.set(capturedOfxpRotationFinalizations, 0)
      const response = yield* HttpClientRequest.post(OfxpPaths.finalizeIdentityRotation).pipe(
        HttpClientRequest.setBody(HttpBody.jsonUnsafe({ expectedPeerID: ofxpLocalPeerID })),
        HttpClient.execute,
      )
      expect(response.status).toBe(200)
      expect(yield* Ref.get(capturedOfxpRotationFinalizations)).toBe(1)
      expect(yield* response.json).toMatchObject({
        status: {
          active: true,
          peerID: ofxpLocalPeerID,
          identityRotationSupported: true,
        },
      })
    }),
  )

  it.live("preserves stale OFXP identity generations as transport-level 409 conflicts", () =>
    Effect.gen(function* () {
      yield* Ref.set(capturedOfxpRotations, 0)
      yield* Ref.set(capturedOfxpRotationFinalizations, 0)
      const stalePeerID = Ofxp.PeerID.make(`ofxp_${"D".repeat(43)}`)

      const rotate = yield* HttpClientRequest.post(OfxpPaths.rotateIdentity).pipe(
        HttpClientRequest.setBody(HttpBody.jsonUnsafe({ expectedPeerID: stalePeerID })),
        HttpClient.execute,
      )
      expect(rotate.status).toBe(409)
      expect(yield* rotate.json).toMatchObject({ _tag: "ConflictError", code: "ofxp_state_changed" })

      const finalize = yield* HttpClientRequest.post(OfxpPaths.finalizeIdentityRotation).pipe(
        HttpClientRequest.setBody(HttpBody.jsonUnsafe({ expectedPeerID: stalePeerID })),
        HttpClient.execute,
      )
      expect(finalize.status).toBe(409)
      expect(yield* finalize.json).toMatchObject({ _tag: "ConflictError", code: "ofxp_state_changed" })
      expect(yield* Ref.get(capturedOfxpRotations)).toBe(0)
      expect(yield* Ref.get(capturedOfxpRotationFinalizations)).toBe(0)
    }),
  )

  it.live("preserves stale OFXP grant revisions as transport-level 409 conflicts", () =>
    Effect.gen(function* () {
      const peerID = Ofxp.PeerID.make(`ofxp_${"A".repeat(43)}`)
      const response = yield* HttpClientRequest.patch(OfxpPaths.grant.replace(":peerID", peerID)).pipe(
        HttpClientRequest.setBody(
          HttpBody.jsonUnsafe({
            expectedRevision: 7,
            grant: Ofxp.DENY_GRANT,
          }),
        ),
        HttpClient.execute,
      )
      const body = yield* response.json
      expect({ status: response.status, body }).toMatchObject({
        status: 409,
        body: {
          _tag: "ConflictError",
          code: "ofxp_stale_grant",
        },
      })
    }),
  )

  it.live("preserves stale OFXP revoke/root generations as transport-level 409 conflicts", () =>
    Effect.gen(function* () {
      const peerPath = OfxpPaths.peer.replace(":peerID", ofxpActivityPeerID)
      const revoke = yield* HttpClientRequest.delete(peerPath).pipe(
        HttpClientRequest.setBody(HttpBody.jsonUnsafe({ expectedRevision: 0 })),
        HttpClient.execute,
      )
      expect(revoke.status).toBe(409)
      expect(yield* revoke.json).toMatchObject({ _tag: "ConflictError", code: "ofxp_stale_peer" })

      const root = yield* HttpClientRequest.post(OfxpPaths.roots.replace(":peerID", ofxpActivityPeerID)).pipe(
        HttpClientRequest.setBody(
          HttpBody.jsonUnsafe({
            expectedRevision: 0,
            alias: "project",
            canonicalPath: "/srv/project",
            source: "project",
          }),
        ),
        HttpClient.execute,
      )
      expect(root.status).toBe(409)
      expect(yield* root.json).toMatchObject({ _tag: "ConflictError", code: "ofxp_stale_root" })
    }),
  )

  it.live("serves revision recovery and acknowledgement without a workspace runtime", () =>
    Effect.gen(function* () {
      const recover = yield* HttpClientRequest.post("/revision-draft/recover").pipe(
        HttpClientRequest.setBody(HttpBody.jsonUnsafe({ kind: "prompt", key: "session:missing" })),
        HttpClient.execute,
      )
      expect(recover.status).toBe(200)
      expect(yield* recover.json).toBeNull()

      const consume = yield* HttpClientRequest.post("/revision-draft/consume").pipe(
        HttpClientRequest.setBody(HttpBody.jsonUnsafe({ id: "revision-draft:missing" })),
        HttpClient.execute,
      )
      expect(consume.status).toBe(200)
    }),
  )

  it.live("serves project-scoped root Session census without a workspace runtime", () =>
    Effect.gen(function* () {
      const query = new URLSearchParams({
        directory: "/canonical/project",
        projectID: "project-tier0",
        limit: "5",
      })
      const response = yield* HttpClientRequest.get(GlobalPaths.sessionRoots + "?" + query).pipe(HttpClient.execute)
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual([])
    }),
  )

  it.live("serves Swarm summaries without InstanceStore or a workspace runtime", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get("/swarm?limit=25").pipe(HttpClient.execute)
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual([])
    }),
  )

  it.live("preserves stale Swarm revisions as transport-level 409 conflicts", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.patch("/swarm/swr_http_stale").pipe(
        HttpClientRequest.setBody(HttpBody.jsonUnsafe({ expectedRevision: 7, status: "paused" })),
        HttpClient.execute,
      )
      expect(response.status).toBe(409)
      expect(yield* response.json).toMatchObject({
        _tag: "ConflictError",
        resource: "swr_http_stale",
        code: "swarm_stale_revision",
      })
    }),
  )

  it.live("preserves stale managed-member binding generations as transport-level 409 conflicts", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.patch("/swarm/swr_http/member/swm_http/configure").pipe(
        HttpClientRequest.setBody(
          HttpBody.jsonUnsafe({
            expectedBindingGeneration: 3,
            desiredProfile: {
              agent: "build",
              model: { providerID: "test", id: "test-model" },
              permissionBoundary: [],
            },
            workspacePolicy: { mode: "shared-read" },
          }),
        ),
        HttpClient.execute,
      )
      expect(response.status).toBe(409)
      expect(yield* response.json).toMatchObject({
        _tag: "ConflictError",
        resource: "swm_http",
        code: "swarm_stale_fence",
      })
    }),
  )

  it.live("does not allow operator task creation to spoof member authorship", () =>
    Effect.gen(function* () {
      yield* Ref.set(capturedTaskCreate, undefined)
      const response = yield* HttpClientRequest.post("/swarm/swr_http/task").pipe(
        HttpClientRequest.setBody(
          HttpBody.jsonUnsafe({
            title: "operator task",
            createdByMemberID: "swm_spoofed",
          }),
        ),
        HttpClient.execute,
      )
      const responseBody = yield* response.text
      const captured = yield* Ref.get(capturedTaskCreate)
      expect({ status: response.status, body: responseBody, captured }).toEqual({
        status: 200,
        body: expect.any(String),
        captured: expect.any(Object),
      })
      // Effect schema may either reject the unknown field at the boundary or
      // strip it before the handler. In neither case can it become member
      // provenance in Core.
      if (captured) {
        expect(captured.swarmID).toBe(Swarm.ID.make("swr_http"))
        expect(captured.title).toBe("operator task")
        expect("createdByMemberID" in captured).toBe(false)
      }
    }),
  )

  it.live("serves OXP parent activity history without a workspace runtime", () =>
    Effect.gen(function* () {
      const list = yield* HttpClientRequest.get(
        GlobalPaths.oxpActivities,
      ).pipe(HttpClient.execute)
      expect(list.status).toBe(200)
      expect(yield* list.json).toEqual([])

      const get = yield* HttpClientRequest.get(
        GlobalPaths.oxpActivity.replace(":activityID", "oxpa_missing"),
      ).pipe(HttpClient.execute)
      expect(get.status).toBe(200)
      expect(yield* get.json).toBeNull()

      const history = yield* HttpClientRequest.get(
        GlobalPaths.oxpInvocations.replace(
          ":activityID",
          "oxpa_missing",
        ),
      ).pipe(HttpClient.execute)
      expect(history.status).toBe(200)
      expect(yield* history.json).toEqual({ items: [], more: false })

      const invocationDetail = yield* HttpClientRequest.get(
        GlobalPaths.oxpInvocationDetail.replace(
          ":invocationID",
          "oxpi_missing",
        ),
      ).pipe(HttpClient.execute)
      const invocationDetailBody = yield* invocationDetail.text
      console.info("OXP invocation detail response", invocationDetail.status, invocationDetailBody)
      expect(invocationDetail.status).toBe(200)
      expect(invocationDetailBody).toBe("null")

      const provenance = yield* HttpClientRequest.get(
        GlobalPaths.oxpResource + "?kind=session&ref=ses_missing",
      ).pipe(HttpClient.execute)
      expect(provenance.status).toBe(200)
      expect(yield* provenance.json).toEqual([])
    }),
  )
})

describe("Tier-0 WakaTime opt-in surface", () => {
  const configuredStatus = { enabled: false, configured: true, cli: "/usr/bin/wakatime-cli", source: "system" as const }
  const resetWakaTime = Ref.set(wakatimeState, { ...configuredStatus, failNext: false })

  it.live("serves WakaTime status without a workspace runtime", () =>
    Effect.gen(function* () {
      yield* resetWakaTime
      const response = yield* HttpClientRequest.get(WakaTimePaths.status).pipe(HttpClient.execute)
      expect(response.status).toBe(200)
      // Exactly Core's Status projection: opt-in, configuration, resolved CLI,
      // and how that CLI was found. No queue depth, no last-send telemetry.
      expect(yield* response.json).toEqual({
        enabled: false,
        configured: true,
        cli: "/usr/bin/wakatime-cli",
        source: "system",
      })
      expect(yield* Ref.get(instanceLoads)).toBe(0)
    }),
  )

  it.live("omits the CLI and source when no binary is resolved yet", () =>
    Effect.gen(function* () {
      yield* Ref.set(wakatimeState, { enabled: false, configured: false, failNext: false })
      const response = yield* HttpClientRequest.get(WakaTimePaths.status).pipe(HttpClient.execute)
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ enabled: false, configured: false })
      expect(yield* Ref.get(instanceLoads)).toBe(0)
    }),
  )

  it.live("toggles WakaTime opt-in through Core without a workspace runtime", () =>
    Effect.gen(function* () {
      yield* resetWakaTime
      const response = yield* HttpClientRequest.patch(WakaTimePaths.status).pipe(
        HttpClientRequest.setBody(HttpBody.jsonUnsafe({ enabled: true })),
        HttpClient.execute,
      )
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({
        enabled: true,
        configured: true,
        cli: "/usr/bin/wakatime-cli",
        source: "system",
      })
      expect((yield* Ref.get(wakatimeState)).enabled).toBe(true)
      expect(yield* Ref.get(instanceLoads)).toBe(0)
    }),
  )

  it.live("maps a Core settings failure to an internal error without leaking state", () =>
    Effect.gen(function* () {
      yield* Ref.set(wakatimeState, { ...configuredStatus, failNext: true })
      const response = yield* HttpClientRequest.patch(WakaTimePaths.status).pipe(
        HttpClientRequest.setBody(HttpBody.jsonUnsafe({ enabled: true })),
        HttpClient.execute,
      )
      expect(response.status).toBe(500)
      expect(JSON.parse(yield* response.text)).toMatchObject({ message: "Unable to persist WakaTime settings" })
    }),
  )

  it.live("exposes no credential write path on the WakaTime surface", () =>
    Effect.gen(function* () {
      // Core holds no API-key store, so the transport must not offer one. Any
      // request aimed at a key/flush path has to fail as an unknown route.
      yield* resetWakaTime
      for (const path of ["/global/wakatime/key", "/global/wakatime/flush"]) {
        const response = yield* HttpClientRequest.post(path).pipe(HttpClient.execute)
        expect({ path, status: response.status }).toEqual({ path, status: 404 })
      }
      expect(yield* Ref.get(instanceLoads)).toBe(0)
    }),
  )
})