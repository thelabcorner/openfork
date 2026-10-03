import path from "node:path"
import os from "node:os"
import { describe, expect } from "bun:test"
import { NodeHttpServer } from "@effect/platform-node"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import { DirectoryActivityFence } from "@opencode-ai/core/directory-activity-fence"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { OfxpInvocation } from "@opencode-ai/core/ofxp-invocation"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { OxpActivity } from "@opencode-ai/core/oxp-activity/activity"
import { OxpActivityInspection } from "@opencode-ai/core/oxp-activity/inspection"
import { OxpAttribution } from "@opencode-ai/core/oxp-attribution/attribution"
import { RevisionDraft } from "@opencode-ai/core/revision-draft"
import { ScheduledTask } from "@opencode-ai/core/scheduled-task"
import { ScheduledTaskSessionBinding } from "@opencode-ai/core/scheduled-task/session-binding"
import { SessionUsage } from "@opencode-ai/core/session/usage"
import { WakaTime } from "@opencode-ai/core/wakatime"
import { Context, DateTime, Effect, Layer, Option, Ref } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { Agent as AgentModel } from "@opencode-ai/schema/agent"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Swarm } from "@opencode-ai/schema/swarm"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Capacity } from "../../src/capacity/capacity"
import { Config } from "../../src/config/config"
import { InstanceRef } from "../../src/effect/instance-ref"
import { ForkCredentials } from "../../src/fork/credentials"
import { Installation } from "../../src/installation"
import { OfxpRoot } from "../../src/ofxp/root"
import { OfxpRuntime } from "../../src/ofxp/runtime"
import { Provider } from "../../src/provider/provider"
import { Quota } from "../../src/quota/quota"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { directoryActivityFenceHandlers } from "../../src/server/routes/instance/httpapi/handlers/directory-activity-fence"
import { forkCredentialHandlers } from "../../src/server/routes/instance/httpapi/handlers/fork-credential"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { ofxpHandlers } from "../../src/server/routes/instance/httpapi/handlers/ofxp"
import { providerSettingsHandlers } from "../../src/server/routes/instance/httpapi/handlers/provider-settings"
import { quotaHandlers } from "../../src/server/routes/instance/httpapi/handlers/quota"
import { revisionDraftHandlers } from "../../src/server/routes/instance/httpapi/handlers/revision-draft"
import { scheduledTaskHandlers } from "../../src/server/routes/instance/httpapi/handlers/scheduled-task"
import { swarmHandlers } from "../../src/server/routes/instance/httpapi/handlers/swarm"
import { usageHandlers } from "../../src/server/routes/instance/httpapi/handlers/usage"
import { wakatimeHandlers } from "../../src/server/routes/instance/httpapi/handlers/wakatime"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { instancePin } from "../../src/server/routes/instance/httpapi/middleware/instance-pin"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { ServerAuth } from "../../src/server/auth"
import { SessionStatus } from "../../src/session/status"
import { SwarmMemberSessionWake } from "../../src/swarm/member-session-wake"
import { SwarmProfilePreflight } from "../../src/swarm/profile-preflight"
import { Usage } from "../../src/usage/usage"
import { testEffect } from "../lib/effect"

/**
 * Admission gate for durable managed-worker execution profiles over HTTP.
 *
 * Core is the only durable writer, so the exact invariant proven here is that the
 * route never *reaches* the writer with a profile the shared preflight refuses.
 * The preflight itself is real — only the provider/model catalog is mocked — so
 * the refusal is genuine rather than a stub, and the recorded Swarm service
 * proves the mutation entry point was never invoked at all.
 *
 * Directory identity between the request instance and the Swarm row is covered
 * directly in test/swarm/profile-preflight.test.ts; this file keeps to the
 * route-level wiring.
 */

const directory = path.join(os.tmpdir(), "opencode-http-swarm-profile")

const swarmID = Swarm.ID.make("swr_http_member_profile")
const memberID = Swarm.MemberID.make("swm_http_member_profile")

const swarmInfo = Swarm.Info.make({
  id: swarmID,
  projectID: ProjectV2.ID.make("proj_http_member_profile"),
  directory,
  name: "HTTP profile admission",
  status: "active",
  policy: {},
  revision: 1,
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
})

/** `reasoning` and `input_image` are deliberately unpublished by this catalog. */
const catalog = {
  variants: {},
  capabilities: {
    toolcall: true,
    reasoning: false,
    attachment: true,
    temperature: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
  },
} as unknown as Provider.Model

const runnableProfile = {
  agent: AgentModel.ID.make("build"),
  model: { providerID: ProviderV2.ID.make("anthropic"), id: ModelV2.ID.make("claude-opus-5") },
  permissionBoundary: [],
  modelRequirements: ["toolcall" as const],
} satisfies Swarm.MemberExecutionProfile

const unsatisfiableProfile = { ...runnableProfile, modelRequirements: ["input_image" as const] }

const agentMock = Layer.mock(Agent.Service, {
  get: (name: string) => Effect.succeed(name === "build" ? ({ name: "build" } as any) : (undefined as any)),
})

const providerMock = Layer.mock(Provider.Service, {
  getModel: (providerID, modelID) =>
    providerID === "anthropic" && modelID === "claude-opus-5"
      ? Effect.succeed(catalog as any)
      : Effect.fail(new Error(`no model ${providerID}/${modelID}`) as any),
})

const addMemberCalls = Ref.makeUnsafe<unknown[]>([])
const configureMemberCalls = Ref.makeUnsafe<unknown[]>([])

/**
 * Both member endpoints declare `Swarm.Member` as their success schema, so the
 * recording mock must still return a decodable member. Returning the recorded
 * array instead would fail the *response* decode and mask the status code.
 */
const member = Swarm.Member.make({
  id: memberID,
  swarmID,
  name: "worker",
  kind: "managed_worker",
  role: "implement",
  lifecycle: "stopped",
  bindingGeneration: 1,
  desiredProfile: runnableProfile,
  workspacePolicy: { mode: "shared-read" },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
})

const swarmMock = Layer.mock(SwarmV2.Service, {
  info: () => Effect.succeed(swarmInfo),
  addMember: (input) => Ref.update(addMemberCalls, (rows) => [...rows, input]).pipe(Effect.as(member)),
  configureMember: (input) =>
    Ref.update(configureMemberCalls, (rows) => [...rows, input]).pipe(Effect.as(member)),
})

const instance = { directory, worktree: directory, project: { id: swarmInfo.projectID } } as never

const apiBaseLayer = HttpRouter.serve(
  HttpApiBuilder.layer(RootHttpApi).pipe(
    // `swarmHandlers` is bound to `RootHttpApi`, so every declared group needs a
    // handler implementation even though only the two swarm member routes are
    // exercised. The sibling handler layers are the real production ones; their
    // services are inert `Layer.mock`s below.
    Layer.provide([
      controlHandlers,
      controlPlaneHandlers,
      directoryActivityFenceHandlers,
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
    Layer.provide(Layer.provide(SwarmProfilePreflight.layer, Layer.mergeAll(agentMock, providerMock))),
    Layer.provide(swarmMock),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
    Layer.provide(Layer.mock(DirectoryActivityFence.Service)({})),
    Layer.provide(instancePin),
    // Raw HttpApi routes expose an opaque handler context at the request
    // boundary. The preflight deliberately refuses to validate without the
    // instance that owns the catalog, so supply one per request.
    HttpRouter.provideRequest(Layer.succeedContext(Context.make(InstanceRef, instance) as Context.Context<never>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(
    Layer.mergeAll(Layer.mock(SessionExecutionOwner.Service)({}), Layer.mock(SessionStatus.Service)({})),
  ),
  Layer.provide(Layer.mock(Auth.Service)({})),
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
  Layer.provide(Layer.mock(Config.Service)({})),
  Layer.provide(Layer.mock(ForkCredentials.Service)({})),
  Layer.provide(Layer.mock(SessionUsage.Service)({})),
  Layer.provide(
    Layer.mock(Quota.Service)({
      providers: () => Effect.succeed({ providers: [] }),
      get: () => Effect.die("unused quota get"),
      resets: ({ from, to }) => Effect.succeed({ from, to, generatedAt: from, occurrences: [], failures: [] }),
    }),
  ),
  Layer.provide(Layer.mock(OfxpInvocation.Service)({})),
  Layer.provide(Layer.mock(OfxpPeer.Service)({ subscribe: () => () => {} })),
  Layer.provide(Layer.mock(OfxpRoot.Service)({})),
  Layer.provide(Layer.mock(OfxpRuntime.Service)({})),
)

const apiLayer = apiBaseLayer.pipe(
  Layer.provide(Layer.mock(OxpActivity.Service)({})),
  Layer.provide(Layer.mock(OxpActivityInspection.Service)({})),
  Layer.provide(Layer.mock(RevisionDraft.Service)({})),
  Layer.provide(Layer.mock(ScheduledTask.Service)({})),
  Layer.provide(Layer.mock(ScheduledTaskSessionBinding.Service)({})),
  Layer.provide(Layer.mock(SwarmMemberSessionWake.Service)({})),
  Layer.provide(Layer.mock(WakaTime.Service)({})),
  Layer.provide(Layer.mock(OxpAttribution.Service)({})),
  Layer.provide(
    Layer.mock(Usage.Service)({
      summary: () => Effect.die("unused usage summary"),
      modelProfile: () => Effect.succeed({ models: [] }),
      recordMaintenance: () => Effect.void,
    }),
  ),
  Layer.provide(Layer.mock(Installation.Service)({})),
  Layer.provide(Layer.mock(MoveSession.Service)({})),
  Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode", publicUrl: "" })),
)

// Splitting the long provider chain keeps Effect's pipe overload bounded, but
// loses the final input-environment reduction to `unknown` at the type level.
// The server builds successfully and the test below exercises every route through
// the fully provided layer, so close only that inference hole here.
const closedApiLayer = apiLayer as Layer.Layer<Layer.Success<typeof apiLayer>, Layer.Error<typeof apiLayer>>
const it = testEffect(closedApiLayer)

const memberAddBody = (desiredProfile: Swarm.MemberExecutionProfile) => ({
  name: "worker",
  role: "implement",
  desiredProfile,
  workspacePolicy: { mode: "shared-read" },
})

const postMember = (desiredProfile: Swarm.MemberExecutionProfile) =>
  HttpClientRequest.post(`/swarm/${swarmID}/member`).pipe(
    HttpClientRequest.setBody(HttpBody.jsonUnsafe(memberAddBody(desiredProfile))),
    HttpClient.execute,
  )

const patchMember = (desiredProfile: Swarm.MemberExecutionProfile) =>
  HttpClientRequest.patch(`/swarm/${swarmID}/member/${memberID}/configure`).pipe(
    HttpClientRequest.setBody(
      HttpBody.jsonUnsafe({
        expectedBindingGeneration: 1,
        desiredProfile,
        workspacePolicy: { mode: "shared-read" },
      }),
    ),
    HttpClient.execute,
  )

describe("Swarm HttpApi managed-member profile admission", () => {
  /**
   * A bare 400 is not proof of anything: a malformed body or an unrelated
   * handler failure produces the same status. Assert the refusal is the
   * preflight's own typed rejection so these negatives cannot pass vacuously.
   */
  const expectPreflightRefusal = (response: HttpClientResponse.HttpClientResponse, reason: string) =>
    Effect.gen(function* () {
      expect(response.status).toBe(400)
      const body = JSON.parse(yield* response.text) as Record<string, unknown>
      expect(body).toMatchObject({
        _tag: "InvalidRequestError",
        kind: "swarm_validation",
        message: expect.stringContaining(reason),
      })
    })

  it.live("rejects memberAdd with an unsatisfied model requirement and writes no member", () =>
    Effect.gen(function* () {
      const response = yield* postMember(unsatisfiableProfile)

      yield* expectPreflightRefusal(response, "does not satisfy required model capabilities")
      // Negative invariant: the durable writer was never invoked.
      expect(yield* Ref.get(addMemberCalls)).toEqual([])
    }),
  )

  it.live("rejects memberAdd with an unknown agent and writes no member", () =>
    Effect.gen(function* () {
      const response = yield* postMember({ ...runnableProfile, agent: AgentModel.ID.make("ghost") })

      yield* expectPreflightRefusal(response, "Agent not found")
      expect(yield* Ref.get(addMemberCalls)).toEqual([])
    }),
  )

  it.live("admits a profile the catalog proves runnable through to the durable writer", () =>
    Effect.gen(function* () {
      const response = yield* postMember(runnableProfile)

      // Surface the refusal reason on failure instead of only the status code.
      expect({ status: response.status, body: yield* response.text }).toMatchObject({ status: 200 })
      expect(yield* Ref.get(addMemberCalls)).toHaveLength(1)
    }),
  )

  it.live("rejects memberConfigure with an unsatisfied model requirement and writes no config change", () =>
    Effect.gen(function* () {
      const response = yield* patchMember(unsatisfiableProfile)

      yield* expectPreflightRefusal(response, "does not satisfy required model capabilities")
      // The previously good profile must survive untouched.
      expect(yield* Ref.get(configureMemberCalls)).toEqual([])
    }),
  )

  it.live("admits a proven profile through to configureMember so Core keeps fence ownership", () =>
    Effect.gen(function* () {
      const response = yield* patchMember(runnableProfile)

      expect({ status: response.status, body: yield* response.text }).toMatchObject({ status: 200 })
      const calls = yield* Ref.get(configureMemberCalls)
      expect(calls).toHaveLength(1)
      // The gate only proves runnability. The stopped/unbound fence stays Core's
      // exclusive decision, so nothing here may pre-judge it.
      expect(calls[0]).toMatchObject({ memberID, expectedBindingGeneration: 1 })
    }),
  )
})