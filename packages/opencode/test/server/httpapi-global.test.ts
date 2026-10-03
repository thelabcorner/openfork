import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { SessionUsage } from "@opencode-ai/core/session/usage"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionStatus } from "../../src/session/status"
import { DirectoryActivityFence } from "@opencode-ai/core/directory-activity-fence"
import { OxpActivity } from "@opencode-ai/core/oxp-activity/activity"
import { OxpActivityInspection } from "@opencode-ai/core/oxp-activity/inspection"
import { OxpAttribution } from "@opencode-ai/core/oxp-attribution/attribution"
import { RevisionDraft } from "@opencode-ai/core/revision-draft"
import { ScheduledTask } from "@opencode-ai/core/scheduled-task"
import { ScheduledTaskSessionBinding } from "@opencode-ai/core/scheduled-task/session-binding"
import { OfxpInvocation } from "@opencode-ai/core/ofxp-invocation"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { SwarmProfilePreflight } from "../../src/swarm/profile-preflight"
import { Auth } from "../../src/auth"
import { Capacity } from "../../src/capacity/capacity"
import { Config } from "../../src/config/config"
import { ForkCredentials } from "../../src/fork/credentials"
import { Installation } from "../../src/installation"
import { OfxpRoot } from "../../src/ofxp/root"
import { OfxpRuntime } from "../../src/ofxp/runtime"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { directoryActivityFenceHandlers } from "../../src/server/routes/instance/httpapi/handlers/directory-activity-fence"
import { forkCredentialHandlers } from "../../src/server/routes/instance/httpapi/handlers/fork-credential"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { ofxpHandlers } from "../../src/server/routes/instance/httpapi/handlers/ofxp"
import { providerSettingsHandlers } from "../../src/server/routes/instance/httpapi/handlers/provider-settings"
import { usageHandlers } from "../../src/server/routes/instance/httpapi/handlers/usage"
import { wakatimeHandlers } from "../../src/server/routes/instance/httpapi/handlers/wakatime"
import { quotaHandlers } from "../../src/server/routes/instance/httpapi/handlers/quota"
import { revisionDraftHandlers } from "../../src/server/routes/instance/httpapi/handlers/revision-draft"
import { scheduledTaskHandlers } from "../../src/server/routes/instance/httpapi/handlers/scheduled-task"
import { swarmHandlers } from "../../src/server/routes/instance/httpapi/handlers/swarm"
import { SwarmMemberSessionWake } from "../../src/swarm/member-session-wake"
import { Usage } from "../../src/usage/usage"
import { WakaTime } from "@opencode-ai/core/wakatime"
import { Quota } from "../../src/quota/quota"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

const oxpAttributionSnapshot: OxpAttribution.Snapshot = {
  generatedAt: 123,
  scope: { since: 100, until: 200 },
  totals: {
    calls: 2,
    activities: 1,
    inferredRounds: 2,
    uniqueRequestChars: 120,
    uniqueResultChars: 240,
    uniqueChars: 360,
    uniqueTokens: 90,
    amplification: 1.5,
    requestChars: 180,
    resultChars: 360,
    chars: 540,
    requestTokens: 45,
    resultTokens: 90,
    tokens: 135,
    byTool: [],
    bySource: [],
  },
  sensitivity: {
    low: { rho: 0.75, tokens: 120 },
    calibrated: { rho: 0.9, tokens: 135 },
    high: { rho: 0.99, tokens: 150 },
  },
  coverage: {
    request: {
      observed_boundary: 2,
      historical_detail: 0,
      calibrated_surrogate: 0,
      calibrated_donor: 0,
      unavailable: 0,
    },
    result: {
      observed_boundary: 2,
      historical_detail: 0,
      calibrated_surrogate: 0,
      calibrated_donor: 0,
      unavailable: 0,
      not_applicable: 0,
    },
    invalidPersistedMeasurements: 0,
    complete: true,
  },
  model: {
    kind: "geometric-context-residency",
    rho: 0.9,
    gapThresholdMs: 1_000,
    requestCharsPerToken: 4,
    resultCharsPerToken: 4,
    components: {
      callTranscript: true,
      returnedContent: true,
      repeatedContextExposure: true,
      availabilitySchema: false,
    },
    calibration: {
      productionDigest: "production-digest",
      sourceDigest: "source-digest",
      calibratedAt: "2026-10-02T00:00:00.000Z",
      observations: 100,
      corpus: {
        observations: 100,
        activities: 10,
        tools: 4,
        toolStatusGroups: 8,
        minStartedAt: 1,
        maxStartedAt: 2,
        maxCompletedAt: 3,
      },
      validation: {
        toolPriorChars: 1,
        statusPriorChars: 1,
        statusSpecialization: "tool-status",
        exposureAggregateBiasRMSE: 0.01,
        exposureWAPE: 0.02,
      },
    },
  },
  causalAttribution: {
    available: false,
    reason: "trace-chain-unavailable",
  },
}

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(RootHttpApi).pipe(
    Layer.provide([
      controlHandlers,
      controlPlaneHandlers,
      directoryActivityFenceHandlers,
      forkCredentialHandlers,
      globalHandlers,
      ofxpHandlers,
      providerSettingsHandlers,
      usageHandlers,
      wakatimeHandlers,
      quotaHandlers,
      revisionDraftHandlers,
      scheduledTaskHandlers,
      swarmHandlers,
    ]),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
    // Raw HttpApi routes expose an opaque handler context at the request boundary.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(Layer.mock(Auth.Service)({})),
  Layer.provide(
    Layer.mock(Config.Service)({
      getGlobal: () => Effect.succeed({}),
      updateGlobal: (config) => Effect.succeed({ info: config, changed: false }),
      updateGlobalAgent: (input) =>
        Effect.succeed({
          info: input.value === null ? {} : { agent: { [input.id]: input.value } },
          changed: false,
        }),
    }),
  ),
  Layer.provide(Layer.mock(ForkCredentials.Service)({})),
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
  Layer.provide(Layer.mock(SessionUsage.Service)({})),
  Layer.provide(
    Layer.mock(SessionExecutionOwner.Service)({
      listWorking: () =>
        Effect.succeed(new Map([[SessionSchema.ID.make("ses_global_status"), { type: "busy" as const }]])),
    }),
  ),
  Layer.provide(
    Layer.mock(SessionStatus.Service)({
      list: () =>
        Effect.succeed(
          new Map([
            [
              SessionSchema.ID.make("ses_retry_status"),
              { type: "retry" as const, attempt: 2, message: "retrying", next: 3 },
            ],
          ]),
        ),
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
  Layer.provide([
    Layer.mock(OfxpInvocation.Service)({}),
    Layer.mock(OfxpPeer.Service)({ subscribe: () => () => {} }),
    Layer.mock(OfxpRoot.Service)({}),
    Layer.mock(OfxpRuntime.Service)({}),
    Layer.mock(OxpActivity.Service)({}),
    Layer.mock(OxpActivityInspection.Service)({}),
    Layer.mock(OxpAttribution.Service)({
      snapshot: (input) =>
        Effect.succeed({
          ...oxpAttributionSnapshot,
          scope: {
            ...(input?.since === undefined ? {} : { since: input.since }),
            ...(input?.until === undefined ? {} : { until: input.until }),
            ...(input?.activityID === undefined ? {} : { activityID: input.activityID }),
          },
        }),
    }),
    Layer.mock(RevisionDraft.Service)({}),
    Layer.mock(ScheduledTask.Service)({}),
    Layer.mock(ScheduledTaskSessionBinding.Service)({}),
    Layer.mock(SwarmV2.Service)({}),
    Layer.mock(SwarmProfilePreflight.Service)({ check: () => Effect.die("unused Swarm profile preflight") }),
    Layer.mock(SwarmMemberSessionWake.Service)({}),
  ]),
  Layer.provide(
    Layer.mock(Usage.Service)({
      summary: () => Effect.die("unused usage summary"),
      modelProfile: () => Effect.succeed({ models: [] }),
      recordMaintenance: () => Effect.void,
    }),
  ),
).pipe(
  Layer.provide(Layer.mock(MoveSession.Service)({})),
  Layer.provide(Layer.mock(WakaTime.Service)({})),
  Layer.provide(Layer.mock(DirectoryActivityFence.Service)({})),
  Layer.provide(
    Layer.mock(Installation.Service)({
      method: () => Effect.succeed("curl"),
      latest: () => Effect.succeed("9.9.9"),
      upgrade: () => Effect.void,
    }),
  ),
  Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode", publicUrl: "" })),
)
const it = testEffect(apiLayer)

describe("global HttpApi", () => {
  it.live("fences stale interest POSTs and reports the applied generation", () =>
    Effect.gen(function* () {
      const interest = yield* Effect.promise(() => import("@opencode-ai/server/event-interest"))
      const state = interest.registerEventStreamInterest("http-generation-test", ["a"], 2)!
      yield* Effect.addFinalizer(() => Effect.sync(() => interest.unregisterEventStreamInterest(state)))
      const stale = yield* HttpClientRequest.post("/global/event/interest").pipe(
        HttpClientRequest.bodyJsonUnsafe({ subscriber: state.subscriber, sessions: ["b"], generation: 1 }),
        HttpClient.execute,
      )
      expect(stale.status).toBe(200)
      expect(yield* stale.json).toEqual({ updated: false, generation: 2 })
      expect(interest.eventStreamAllowsSession(state, "a")).toBe(true)
      const latest = yield* HttpClientRequest.post("/global/event/interest").pipe(
        HttpClientRequest.bodyJsonUnsafe({ subscriber: state.subscriber, sessions: ["c"], generation: 3 }),
        HttpClient.execute,
      )
      expect(latest.status).toBe(200)
      expect(yield* latest.json).toEqual({ updated: true, generation: 3 })
      expect(interest.eventStreamAllowsSession(state, "c")).toBe(true)
      expect(interest.eventStreamAllowsSession(state, "a")).toBe(false)
    }),
  )

  it.live("accepts exact global agent replacement and deletion without workspace routing", () =>
    Effect.gen(function* () {
      const replace = yield* HttpClientRequest.put(GlobalPaths.configAgent.replace(":agentID", "reviewer")).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          mode: "all",
          prompt: "Review the implementation critically.",
        }),
        HttpClient.execute,
      )
      expect(replace.status).toBe(200)
      expect(yield* replace.json).toMatchObject({
        agent: {
          reviewer: {
            mode: "all",
            prompt: "Review the implementation critically.",
          },
        },
      })

      const remove = yield* HttpClientRequest.make("DELETE")(GlobalPaths.configAgent.replace(":agentID", "reviewer")).pipe(
        HttpClient.execute,
      )
      expect(remove.status).toBe(200)
      expect(yield* remove.json).toEqual({})
    }),
  )

  it.live("rejects invalid global agent identifiers", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.put(
        GlobalPaths.configAgent.replace(":agentID", encodeURIComponent("Review Agent")),
      ).pipe(
        HttpClientRequest.bodyJsonUnsafe({ mode: "all" }),
        HttpClient.execute,
      )
      expect(response.status).toBe(400)
    }),
  )

  it.live("serves global working-session status without instance services", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(GlobalPaths.sessionStatus).pipe(HttpClient.execute)

      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({
        ses_global_status: { type: "busy" },
        ses_retry_status: { type: "retry", attempt: 2, message: "retrying", next: 3 },
      })
    }),
  )

  it.live("serves Tier-0 usage without workspace instance dependencies", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get("/usage/model-profile").pipe(HttpClient.execute)
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ models: [] })
    }),
  )

  it.live("serves Tier-0 OXP attribution without workspace instance dependencies", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(`${GlobalPaths.oxpAttribution}?since=100&until=200`).pipe(
        HttpClient.execute,
      )
      expect(response.status).toBe(200)
      expect(yield* response.json).toMatchObject({
        generatedAt: 123,
        scope: { since: 100, until: 200 },
        totals: { calls: 2, tokens: 135, amplification: 1.5 },
        causalAttribution: {
          available: false,
          reason: "trace-chain-unavailable",
        },
      })
    }),
  )

  it.live("upgrades to the requested version", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(GlobalPaths.upgrade).pipe(
        HttpClientRequest.bodyJsonUnsafe({ target: "9.9.9" }),
        HttpClient.execute,
      )

      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ success: true, version: "9.9.9" })
    }),
  )

  it.live("rejects invalid upgrade payloads", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(GlobalPaths.upgrade).pipe(
        HttpClientRequest.bodyJsonUnsafe({ target: 1 }),
        HttpClient.execute,
      )

      expect(response.status).toBe(400)
    }),
  )

  it.live("rejects invalid upgrade target versions", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(GlobalPaths.upgrade).pipe(
        HttpClientRequest.bodyJsonUnsafe({ target: "latest" }),
        HttpClient.execute,
      )

      expect(response.status).toBe(400)
    }),
  )

  it.live("rejects unsupported upgrade content types", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(GlobalPaths.upgrade).pipe(
        HttpClientRequest.setBody(HttpBody.text('{"target":"1.0.0"}', "text/plain")),
        HttpClient.execute,
      )

      expect(response.status).toBe(415)
    }),
  )
})
