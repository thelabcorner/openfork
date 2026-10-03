import { Schema } from "effect"
import { HttpApi } from "effect/unstable/httpapi"
import { EventV2 } from "@opencode-ai/core/event"
import { EventManifest } from "@/event-manifest"
import { Credential } from "@opencode-ai/core/credential"
import { Integration } from "@opencode-ai/core/integration"
import { SkillV2 } from "@opencode-ai/core/skill"
import { InstanceDisposed } from "@/server/event"
import { Question } from "@/question"
import { ConfigApi } from "./groups/config"
import { AgentCatalogApi } from "./groups/agent-catalog"
import { ProviderCatalogApi } from "./groups/provider-catalog"
import { OpenRouterReferenceApi } from "./groups/openrouter-reference"
import { OpenRouterFreeUsageApi } from "./groups/openrouter-free-usage"
import { SessionCreateApi } from "./groups/session-create"
import { ControlApi } from "./groups/control"
import { ControlPlaneApi } from "./groups/control-plane"
import { DirectoryActivityFenceApi } from "./groups/directory-activity-fence"
import { DeviceApi } from "./groups/device"
import { ForkCredentialApi } from "./groups/fork-credential"
import { EventApi } from "./groups/event"
import { ExperimentalApi } from "./groups/experimental"
import { FileApi } from "./groups/file"
import { InstanceApi } from "./groups/instance"
import { McpApi } from "./groups/mcp"
import { OfxpApi } from "./groups/ofxp"
import { PairBeginApi, PairClaimApi } from "./groups/pair"
import { PermissionApi } from "./groups/permission"
import { PermissionControlApi } from "./groups/permission"
import { ProjectApi } from "./groups/project"
import { ProjectCopyApi } from "./groups/project-copy"
import { ProviderApi } from "./groups/provider"
import { ProviderSettingsApi } from "./groups/provider-settings"
import { PtyApi, PtyConnectApi, PtyShellApi } from "./groups/pty"
import { QuotaApi } from "./groups/quota"
import { QuestionApi } from "./groups/question"
import { QuestionControlApi } from "./groups/question"
import { SessionApi } from "./groups/session"
import { SessionReadApi } from "./groups/session-read"
import { SessionControlApi } from "./groups/session-control"
import { SessionContextApi } from "./groups/session-context"
import { SessionGroupApi } from "./groups/session-group"
import { GoalApi } from "./groups/goal"
import { ScheduledTaskApi } from "./groups/scheduled-task"
import { SwarmApi } from "./groups/swarm"
import { SystemOneApi } from "./groups/system-one"
import { SyncApi } from "./groups/sync"
import { ToolApi } from "./groups/tool"
import { TuiApi } from "./groups/tui"
import { UsageApi } from "./groups/usage"
import { WakaTimeApi } from "./groups/wakatime"
import { WorkspaceApi } from "./groups/workspace"
import { PromptRevisorApi } from "./groups/prompt-revisor"
import { RevisionDraftApi } from "./groups/revision-draft"
import { makeApi } from "@opencode-ai/protocol/api"
import { LocationMiddleware } from "@opencode-ai/server/location"
import { SessionLocationMiddleware } from "@opencode-ai/server/middleware/session-location"
import { GlobalApi } from "./groups/global"
import { Authorization } from "./middleware/authorization"
import { SchemaErrorMiddleware } from "./middleware/schema-error"

const EventSchema = Schema.Union([
  ...EventManifest.Latest.values()
    .map((definition) =>
      Schema.Struct({
        id: EventV2.ID,
        type: Schema.Literal(definition.type),
        properties: definition.data,
      }).annotate({ identifier: `Event.${definition.type}` }),
    )
    .toArray(),
  InstanceDisposed,
]).annotate({ identifier: "Event" })

export const ServerApi = makeApi({
  definitions: EventManifest.Latest.values().toArray(),
  locationMiddleware: LocationMiddleware,
  sessionLocationMiddleware: SessionLocationMiddleware,
})

export const RootHttpApi = HttpApi.make("opencode-root")
  .addHttpApi(ControlApi)
  .addHttpApi(ControlPlaneApi)
  .addHttpApi(DirectoryActivityFenceApi)
  .addHttpApi(ForkCredentialApi)
  .addHttpApi(GlobalApi)
  .addHttpApi(ProviderSettingsApi)
  .addHttpApi(UsageApi)
  // Tier-0 process-global WakaTime opt-in exporter control. Never routes
  // through a workspace Instance, never crosses InstanceContextMiddleware.
  .addHttpApi(WakaTimeApi)
  // Tier 0 quota/account metadata and calendar projections. Never route through a workspace Instance.
  .addHttpApi(QuotaApi)
  // Tier 0/1 OFXP operator control plane. Never route peer settings through a workspace Instance.
  .addHttpApi(OfxpApi)
  // Bootstrap-free revision mailbox: stable target identity + durable SQLite only.
  .addHttpApi(RevisionDraftApi)
  // Tier 0 scheduling: durable global catalog state, never behind instance middleware.
  .addHttpApi(ScheduledTaskApi)
  // Tier 0 Swarm projection: durable orchestration state only; live Session truth stays elsewhere.
  .addHttpApi(SwarmApi)
  .middleware(SchemaErrorMiddleware)
  .middleware(Authorization)

export const InstanceHttpApi = HttpApi.make("opencode-instance")
  .addHttpApi(ConfigApi)
  .addHttpApi(ExperimentalApi)
  .addHttpApi(FileApi)
  .addHttpApi(InstanceApi)
  .addHttpApi(McpApi)
  .addHttpApi(ProjectApi)
  .addHttpApi(ProjectCopyApi)
  .addHttpApi(PtyApi)
  .addHttpApi(QuestionApi)
  .addHttpApi(PermissionApi)
  .addHttpApi(ProviderApi)
  .addHttpApi(SessionApi)
  .addHttpApi(SessionContextApi)
  .addHttpApi(SessionGroupApi)
  .addHttpApi(GoalApi)
  // Tier 2 provider/catalog semantic inference; independent of Session/chat execution.
  .addHttpApi(SystemOneApi)
  .addHttpApi(SyncApi)
  .addHttpApi(ToolApi)
  .addHttpApi(TuiApi)
  .addHttpApi(WorkspaceApi)
  .addHttpApi(PromptRevisorApi)
  .middleware(SchemaErrorMiddleware)

export const OpenCodeHttpApi = HttpApi.make("opencode")
  .addHttpApi(RootHttpApi)
  .addHttpApi(AgentCatalogApi)
  .addHttpApi(ProviderCatalogApi)
  // Tier-0 public reference metadata. Keep this out of RootHttpApi as well as
  // InstanceHttpApi: narrow root/control test graphs should not acquire an
  // unrelated OpenRouter transport dependency.
  .addHttpApi(OpenRouterReferenceApi)
  // Tier-0 account-global OpenRouter quota report. Runtime mounting alone does
  // not publish an operation to PublicApi/SDK generation, so keep the dedicated
  // group in the same public aggregate as its reference-data sibling.
  .addHttpApi(OpenRouterFreeUsageApi)
  .addHttpApi(SessionCreateApi)
  // Active V1 user-response controls dispatch through process-local handles;
  // they never initialize the workspace execution Instance.
  .addHttpApi(PermissionControlApi)
  .addHttpApi(QuestionControlApi)
  .addHttpApi(EventApi)
  // Tier 1 session/history reads use durable storage and workspace routing, but
  // do not materialize a workspace execution Instance.
  .addHttpApi(SessionReadApi)
  .addHttpApi(SessionControlApi)
  .addHttpApi(PairBeginApi)
  .addHttpApi(PairClaimApi)
  .addHttpApi(DeviceApi)
  .addHttpApi(InstanceHttpApi)
  .addHttpApi(ServerApi)
  // Tier 0 shell discovery has process ownership and no workspace middleware.
  .addHttpApi(PtyShellApi)
  .addHttpApi(PtyConnectApi)
  .annotate(HttpApi.AdditionalSchemas, [
    EventSchema,
    Question.Replied,
    Question.Rejected,
    Credential.Value,
    Integration.Inputs,
    Integration.Method,
    Integration.Ref,
    SkillV2.Source,
  ])

export type RootHttpApiType = typeof RootHttpApi
export type InstanceHttpApiType = typeof InstanceHttpApi
