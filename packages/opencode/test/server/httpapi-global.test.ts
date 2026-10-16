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
import { RevisionProgress } from "@opencode-ai/core/revision-progress"
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
import { promptRevisionProgressHandlers } from "../../src/server/routes/instance/httpapi/handlers/prompt-revision-progress"
import { promptRevisorRunHandlers } from "../../src/server/routes/instance/httpapi/handlers/prompt-revisor-runs"
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
    inferredTurns: 2,
    estimatedSurroundingTokens: 210,
    estimatedTotalTokens: 300,
    requestChars: 120,
    resultChars: 240,
    chars: 360,
    requestTokens: 30,
    resultTokens: 60,
    tokens: 90,
    byTool: [],
    bySource: [],
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
    kind: "empirical-tool-usage",
    requestCharsPerToken: 4,
    resultCharsPerToken: 4,
    turnGapThresholdMs: 1_500,
    components: {
      observedToolPayload: true,
      estimatedOxpTokens: true,
      empiricallyEstimatedUpstream: true,
      geometricResidency: false,
      availabilitySchema: false,
    },
    calibration: {
      productionDigest: "production-digest",
      payloadDigest: "payload-digest",
      sourceDigest: "source-digest",
      calibratedAt: "2026-10-02T00:00:00.000Z",
      observations: 100,
      corpus: {
        pairedMessages: 100,
        sessions: 10,
        usageRows: 120,
        toolRows: 150,
        maxStartedAt: 1_790_000_000_000,
      },
      tokenizer: {
        encoding: "o200k_base",
        sampledInvocations: 80,
      },
      validation: {
        cvSessionWAPE: 0.26,
        cvSessionMedianAPE: 0.18,
        cvSessionP90APE: 0.56,
        maxAbsFoldBias: 0.23,
        labeledGaps: 1_000,
        boundaryRawError: 0.01,
        boundaryBalancedError: 0.02,
      },
    },
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
      promptRevisionProgressHandlers,
      promptRevisorRunHandlers,
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
          ...(input?.includeWorkload ? { workload: {
            scope: { since: input.since!, until: input.until! }, bucketWidthMs: 1,
            totals: { calls: 2, successes: 1, failures: 1, denied: 0, cancelled: 0, interrupted: 0,
              running: 0, unknown: 0, failureRate: 0.5, measuredDurations: 2, missingDurations: 0,
              toolWallMs: 35, p50Ms: null, p95Ms: null },
            tools: [], topFailures: [], topTime: [], otherTools: 0, otherCalls: 0,
            buckets: [{ start: input.since!, calls: 2, successes: 1, failures: 1 }],
            coverage: { historicalCompleteness: "unknown" as const, quantileSampleLimit: 5000,
              p50MinimumSamples: 5 as const, p95MinimumSamples: 20 as const },
          } } : {}),
          scope: {
            ...(input?.since === undefined ? {} : { since: input.since }),
            ...(input?.until === undefined ? {} : { until: input.until }),
            ...(input?.activityID === undefined ? {} : { activityID: input.activityID }),
          },
        }),
    }),
    Layer.mock(RevisionDraft.Service)({}),
    Layer.mock(RevisionProgress.Service)({ latest: () => Effect.succeed(undefined) }),
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
      const body = (yield* response.json) as Record<string, unknown>
      expect(body.workload).toBeUndefined()
      expect(body).toMatchObject({
        generatedAt: 123,
        scope: { since: 100, until: 200 },
        totals: { calls: 2, tokens: 90, estimatedTotalTokens: 300 },
        model: {
          kind: "empirical-tool-usage",
          calibration: {
            productionDigest: "production-digest",
            payloadDigest: "payload-digest",
            corpus: { maxStartedAt: 1_790_000_000_000 },
          },
        },
      })
      // Obsolete geometric-residency surface must not reappear on the wire.
      const serialized = JSON.stringify(body)
      for (const obsolete of ["uniqueTokens", "exposureTokens", "amplification", "rho", "causalAttribution"]) {
        expect(serialized).not.toContain(obsolete)
      }
    }),
  )

  it.live("serves an opt-in bounded OXP workload and rejects an unbounded range", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(`${GlobalPaths.oxpAttribution}?since=100&until=200&includeWorkload=true`).pipe(HttpClient.execute)
      expect(response.status).toBe(200)
      expect(yield* response.json).toMatchObject({ workload: {
        scope: { since: 100, until: 200 },
        totals: { calls: 2, failures: 1, failureRate: 0.5 },
        buckets: [{ start: 100, calls: 2 }],
      } })
      const missing = yield* HttpClientRequest.get(`${GlobalPaths.oxpAttribution}?includeWorkload=true`).pipe(HttpClient.execute)
      expect(missing.status).toBe(400)
      const oversized = yield* HttpClientRequest.get(`${GlobalPaths.oxpAttribution}?since=0&until=7776000001&includeWorkload=true`).pipe(HttpClient.execute)
      expect(oversized.status).toBe(400)
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
