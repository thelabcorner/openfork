import { describe, expect } from "bun:test"
import { NodeHttpServer } from "@effect/platform-node"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import { SessionStatus } from "../../src/session/status"
import { Context, Effect, Layer, Option, Ref } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
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
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionUsage } from "@opencode-ai/core/session/usage"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { SwarmProfilePreflight } from "../../src/swarm/profile-preflight"
import { Auth } from "../../src/auth"
import { Capacity } from "../../src/capacity/capacity"
import { Config } from "../../src/config/config"
import { ForkCredentials } from "../../src/fork/credentials"
import { Installation } from "../../src/installation"
import { ServerAuth } from "../../src/server/auth"
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
import { OfxpRoot } from "../../src/ofxp/root"
import { OfxpRuntime } from "../../src/ofxp/runtime"
import { SwarmMemberSessionWake } from "../../src/swarm/member-session-wake"
import { Usage } from "../../src/usage/usage"
import { WakaTime } from "@opencode-ai/core/wakatime"
import { Quota } from "../../src/quota/quota"
import { testEffect } from "../lib/effect"

const input = MoveSession.Input.make({
  sessionID: SessionV2.ID.make("ses_move"),
  destination: { directory: AbsolutePath.make("/destination") },
  moveChanges: true,
})
const called = Ref.makeUnsafe<MoveSession.Input | undefined>(undefined)

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
    Layer.provide(Layer.mock(DirectoryActivityFence.Service)({})),
    Layer.provide(instancePin),
    // Raw HttpApi routes expose an opaque handler context at the request boundary.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provide(Layer.mergeAll(
      Layer.mock(SessionExecutionOwner.Service)({}),
      Layer.mock(SessionStatus.Service)({}),
    )),
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
  Layer.provide(Layer.mock(OxpActivity.Service)({})),
  Layer.provide(Layer.mock(OxpActivityInspection.Service)({})),
  Layer.provide(Layer.mock(RevisionDraft.Service)({})),
  Layer.provide(Layer.mock(ScheduledTask.Service)({})),
  Layer.provide(Layer.mock(ScheduledTaskSessionBinding.Service)({})),
  Layer.provide([
    Layer.mock(SwarmV2.Service)({}),
    Layer.mock(SwarmProfilePreflight.Service)({ check: () => Effect.die("unused Swarm profile preflight") }),
    Layer.mock(SwarmMemberSessionWake.Service)({}),
  ]),
  Layer.provide(Layer.mock(WakaTime.Service)({})),
).pipe(
  Layer.provide(Layer.mock(OxpAttribution.Service)({})),
  Layer.provide(
    Layer.mock(Usage.Service)({
      summary: () => Effect.die("unused usage summary"),
      modelProfile: () => Effect.succeed({ models: [] }),
      recordMaintenance: () => Effect.void,
    }),
  ),
  Layer.provide(Layer.mock(Installation.Service)({})),
  Layer.provide(Layer.mock(MoveSession.Service)({ moveSession: (value) => Ref.set(called, value) })),
  Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode", publicUrl: "" })),
)

const it = testEffect(apiLayer)

describe("control-plane HttpApi", () => {
  it.live("moves a session through the root control-plane route", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post("/experimental/control-plane/move-session").pipe(
        HttpClientRequest.setBody(HttpBody.jsonUnsafe(input)),
        HttpClient.execute,
      )

      expect(response.status).toBe(204)
      expect(yield* Ref.get(called)).toEqual(input)
    }),
  )
})
