import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Option, Ref } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { OxpActivity } from "@opencode-ai/core/oxp-activity/activity"
import { OxpActivityInspection } from "@opencode-ai/core/oxp-activity/inspection"
import { RevisionDraft } from "@opencode-ai/core/revision-draft"
import { ScheduledTask } from "@opencode-ai/core/scheduled-task"
import { ScheduledTaskSessionBinding } from "@opencode-ai/core/scheduled-task/session-binding"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionUsage } from "@opencode-ai/core/session/usage"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { ForkCredentials } from "../../src/fork/credentials"
import { Installation } from "../../src/installation"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { forkCredentialHandlers } from "../../src/server/routes/instance/httpapi/handlers/fork-credential"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { providerSettingsHandlers } from "../../src/server/routes/instance/httpapi/handlers/provider-settings"
import { usageHandlers } from "../../src/server/routes/instance/httpapi/handlers/usage"
import { quotaHandlers } from "../../src/server/routes/instance/httpapi/handlers/quota"
import { revisionDraftHandlers } from "../../src/server/routes/instance/httpapi/handlers/revision-draft"
import { scheduledTaskHandlers } from "../../src/server/routes/instance/httpapi/handlers/scheduled-task"
import { swarmHandlers } from "../../src/server/routes/instance/httpapi/handlers/swarm"
import { SwarmMemberSessionWake } from "../../src/swarm/member-session-wake"
import { Usage } from "../../src/usage/usage"
import { Quota } from "../../src/quota/quota"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
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
      forkCredentialHandlers,
      globalHandlers,
      providerSettingsHandlers,
      usageHandlers,
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
  Layer.provide(Layer.mock(Config.Service)({})),
  Layer.provide(Layer.mock(ForkCredentials.Service)({})),
  Layer.provide(Layer.mock(SessionUsage.Service)({})),
  Layer.provide(
    Layer.mock(Quota.Service)({
      providers: () => Effect.succeed({ providers: [] }),
      get: () => Effect.die("unused quota get"),
      resets: ({ from, to }) =>
        Effect.succeed({ from, to, generatedAt: from, occurrences: [], failures: [] }),
    }),
  ),
  Layer.provide(Layer.mock(OxpActivity.Service)({})),
  Layer.provide(Layer.mock(OxpActivityInspection.Service)({})),
  Layer.provide(Layer.mock(RevisionDraft.Service)({})),
  Layer.provide(Layer.mock(ScheduledTask.Service)({})),
  Layer.provide(Layer.mock(ScheduledTaskSessionBinding.Service)({})),
  Layer.provide(Layer.mock(SwarmV2.Service)({})),
  Layer.provide(Layer.mock(SwarmMemberSessionWake.Service)({})),
  Layer.provide(
    Layer.mock(Usage.Service)({
      summary: () => Effect.die("unused usage summary"),
      modelProfile: () => Effect.succeed({ models: [] }),
      recordMaintenance: () => Effect.void,
    }),
  ),
  Layer.provide(Layer.mock(Installation.Service)({})),
  Layer.provide(
    Layer.mock(MoveSession.Service)({
      moveSession: (value) => Ref.set(called, value),
    }),
  ),
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
