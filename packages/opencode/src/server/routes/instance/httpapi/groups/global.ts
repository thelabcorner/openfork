import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { EventV2 } from "@opencode-ai/core/event"
import {
  STREAM_INTEREST_MAX_SESSION_CHARS,
  STREAM_INTEREST_MAX_SESSIONS,
  STREAM_INTEREST_MAX_SUBSCRIBER_CHARS,
} from "@opencode-ai/core/session-stream-content"
import { EventManifest } from "@/event-manifest"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Project } from "@/project/project"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionTelemetry } from "@opencode-ai/schema/session-telemetry"
import { OxpActivitySchema } from "@opencode-ai/core/oxp-activity/schema"
import { InstanceDisposed } from "@/server/event"
import "@opencode-ai/core/account"
import "@/server/event"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import semver from "semver"
import { described } from "./metadata"

const GlobalHealth = Schema.Struct({
  healthy: Schema.Literal(true),
  version: Schema.String,
  // Bootstrap metadata that is intrinsically process-global. Keeping it on the
  // bootstrap-free health surface avoids materializing an Instance merely to
  // discover $HOME/state/config during desktop startup. Optional for wire
  // compatibility with older generated clients/servers.
  path: Schema.optional(
    Schema.Struct({
      home: Schema.String,
      state: Schema.String,
      config: Schema.String,
      worktree: Schema.String,
      directory: Schema.String,
    }),
  ),
})

const SyncEventSchemas = EventManifest.Latest.values()
  .flatMap((definition) => {
    if (!definition.durable) return []
    return [
      Schema.Struct({
        type: Schema.Literal("sync"),
        id: EventV2.ID,
        syncEvent: Schema.Struct({
          type: Schema.Literal(EventV2.versionedType(definition.type, definition.durable.version)),
          id: EventV2.ID,
          seq: Schema.Finite,
          aggregateID: Schema.String,
          data: definition.data,
        }),
      }).annotate({ identifier: `SyncEvent.${definition.type}` }),
    ]
  })
  .toArray()

const ManifestEventTypes = new Set(EventManifest.Latest.values().map((definition) => definition.type).toArray())
const GlobalTransportControlSchemas = [
  {
    type: "server.heartbeat",
    schema: Schema.Struct({ id: EventV2.ID, type: Schema.Literal("server.heartbeat"), properties: Schema.Struct({}) }),
  },
  {
    type: "server.stream.gap",
    schema: Schema.Struct({
      id: EventV2.ID,
      type: Schema.Literal("server.stream.gap"),
      properties: Schema.Struct({
        requested: Schema.Number,
        oldest: Schema.optional(Schema.Number),
        latest: Schema.Number,
      }),
    }),
  },
  {
    type: "server.stream.session-stale",
    schema: Schema.Struct({
      id: EventV2.ID,
      type: Schema.Literal("server.stream.session-stale"),
      properties: Schema.Struct({ sessionID: Schema.String }),
    }),
  },
  {
    type: "server.stream.progress",
    schema: Schema.Struct({
      id: EventV2.ID,
      type: Schema.Literal("server.stream.progress"),
      properties: Schema.Struct({ latest: Schema.Number }),
    }),
  },
] as const

const MissingGlobalTransportControlSchemas = GlobalTransportControlSchemas.filter(
  (control) => !ManifestEventTypes.has(control.type),
).map((control) => control.schema)

const GlobalEventSchema = Schema.Struct({
  directory: Schema.String,
  project: Schema.optional(Schema.String),
  workspace: Schema.optional(Schema.String),
  payload: Schema.Union([
    ...EventManifest.Latest.values()
      .map((definition) =>
        Schema.Struct({ id: EventV2.ID, type: Schema.Literal(definition.type), properties: definition.data }),
      )
      .toArray(),
    ...MissingGlobalTransportControlSchemas,
    InstanceDisposed,
    ...SyncEventSchemas,
  ]),
}).annotate({ identifier: "GlobalEvent" })

export const GlobalUpgradeInput = Schema.Struct({
  target: Schema.String.check(
    Schema.makeFilter((value) => (semver.valid(value) === null ? "Expected a semantic version" : undefined)),
  ),
})

const GlobalUpgradeResult = Schema.Union([
  Schema.Struct({
    success: Schema.Literal(true),
    version: Schema.String,
  }),
  Schema.Struct({
    success: Schema.Literal(false),
    error: Schema.String,
  }),
])

const GlobalResetLocalDataResult = Schema.Struct({
  success: Schema.Literal(true),
  sessionsDeleted: Schema.Number,
  memoriesDeleted: Schema.Number,
  compacted: Schema.Boolean,
})

export const GlobalSessionRootsQuery = Schema.Struct({
  directory: Schema.String,
  projectID: Schema.optional(ProjectV2.ID),
  limit: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(500)),
  ),
})

export const GlobalSessionTelemetryInput = Schema.Struct({
  sessions: Schema.Array(Schema.String).check(Schema.isMaxLength(500)),
}).annotate({ identifier: "GlobalSessionTelemetryInput" })

const GlobalSessionTelemetryResult = Schema.Record(Schema.String, SessionTelemetry.Info).annotate({
  identifier: "GlobalSessionTelemetryResult",
})

const OxpActivitySummary = Schema.Struct({
  id: OxpActivitySchema.ActivityID,
  title: Schema.optional(Schema.String),
  firstSeenAt: Schema.Finite,
  lastSeenAt: Schema.Finite,
  callCount: Schema.Number,
  failureCount: Schema.Number,
  augmentationCalls: Schema.Number,
  supervisionCalls: Schema.Number,
  delegationCalls: Schema.Number,
  observedEpochCount: Schema.Number,
  lastTool: Schema.optional(Schema.String),
  lastRootAlias: Schema.optional(Schema.String),
  archivedAt: Schema.optional(Schema.Finite),
}).annotate({ identifier: "OxpParentActivitySummary" })

const OxpInvocationLinkInfo = Schema.Struct({
  kind: OxpActivitySchema.LinkKind,
  ref: Schema.String,
  relation: Schema.String,
  label: Schema.optional(Schema.String),
}).annotate({ identifier: "OxpInvocationLinkInfo" })

const OxpInvocationInfo = Schema.Struct({
  id: OxpActivitySchema.InvocationID,
  activityID: OxpActivitySchema.ActivityID,
  hostRunID: Schema.String,
  observedEpoch: Schema.optional(Schema.Number),
  plane: OxpActivitySchema.Plane,
  tool: Schema.String,
  action: Schema.optional(Schema.String),
  rootID: Schema.optional(Schema.String),
  rootAlias: Schema.optional(Schema.String),
  status: OxpActivitySchema.Status,
  continuityMarker: Schema.optional(OxpActivitySchema.ContinuityMarker),
  errorCode: Schema.optional(Schema.String),
  mutationAttempted: Schema.Boolean,
  mutationCommitted: Schema.Boolean,
  startedAt: Schema.Finite,
  completedAt: Schema.optional(Schema.Finite),
  links: Schema.Array(OxpInvocationLinkInfo),
}).annotate({ identifier: "OxpInvocationInfo" })

export const GlobalOxpActivityListQuery = Schema.Struct({
  limit: Schema.optional(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(100),
    ),
  ),
  includeArchived: Schema.optional(Schema.Literals(["true", "false"])),
  beforeLastSeenAt: Schema.optional(Schema.NumberFromString),
  beforeID: Schema.optional(OxpActivitySchema.ActivityID),
})

export const GlobalOxpInvocationQuery = Schema.Struct({
  limit: Schema.optional(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(200),
    ),
  ),
  beforeStartedAt: Schema.optional(Schema.NumberFromString),
  beforeID: Schema.optional(OxpActivitySchema.InvocationID),
})

export const GlobalOxpResourceQuery = Schema.Struct({
  kind: OxpActivitySchema.LinkKind,
  ref: Schema.String.check(Schema.isMaxLength(2048)),
  limit: Schema.optional(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(50),
    ),
  ),
})

const OxpResourceProvenanceInfo = Schema.Struct({
  activityID: OxpActivitySchema.ActivityID,
  invocationID: OxpActivitySchema.InvocationID,
  kind: OxpActivitySchema.LinkKind,
  ref: Schema.String,
  relation: Schema.String,
  label: Schema.optional(Schema.String),
  tool: Schema.String,
  action: Schema.optional(Schema.String),
  startedAt: Schema.Finite,
}).annotate({ identifier: "OxpResourceProvenanceInfo" })

const OxpInvocationPage = Schema.Struct({
  items: Schema.Array(OxpInvocationInfo),
  more: Schema.Boolean,
  before: Schema.optional(
    Schema.Struct({
      startedAt: Schema.Finite,
      id: OxpActivitySchema.InvocationID,
    }),
  ),
}).annotate({ identifier: "OxpInvocationPage" })

export const GlobalOxpActivityPatch = Schema.Struct({
  title: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  clearTitle: Schema.optional(Schema.Boolean),
  archived: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "GlobalOxpActivityPatch" })

const GlobalOxpActivityDeleteResult = Schema.Struct({
  deleted: Schema.Boolean,
}).annotate({ identifier: "GlobalOxpActivityDeleteResult" })

export const GlobalEventInterestInput = Schema.Struct({
  subscriber: Schema.String.check(Schema.isMaxLength(STREAM_INTEREST_MAX_SUBSCRIBER_CHARS)),
  sessions: Schema.Array(
    Schema.String.check(Schema.isMaxLength(STREAM_INTEREST_MAX_SESSION_CHARS)),
  ).check(Schema.isMaxLength(STREAM_INTEREST_MAX_SESSIONS)),
}).annotate({ identifier: "GlobalEventInterestInput" })

const GlobalEventInterestResult = Schema.Struct({ updated: Schema.Boolean }).annotate({
  identifier: "GlobalEventInterestResult",
})

// Model-selector preferences shared by every client of this server (desktop
// renderer and paired PWA). Bounds are generous but finite: the document is
// written by a UI, so an unbounded payload here would be a disk sink for any
// buggy or hostile client holding a device token. Array lengths are checked
// here; record *key counts* have no schema filter, so the store clamps those
// (see `preference/model-preferences.ts`).
const PREF_MAX_ENTRIES = 2048

const ModelRecentEntry = Schema.Struct({
  providerID: Schema.String.check(Schema.isMaxLength(128)),
  modelID: Schema.String.check(Schema.isMaxLength(256)),
}).annotate({ identifier: "ModelPreferencesRecentEntry" })

const ModelKey = Schema.String.check(Schema.isMaxLength(512))
const OrderSnapshot = Schema.Array(ModelKey).check(Schema.isMaxLength(PREF_MAX_ENTRIES))

const ModelPreferencesInfo = Schema.Struct({
  order: Schema.optional(Schema.Record(Schema.String, OrderSnapshot)),
  favorite: Schema.optional(Schema.Array(ModelKey).check(Schema.isMaxLength(PREF_MAX_ENTRIES))),
  recent: Schema.optional(Schema.Array(ModelRecentEntry).check(Schema.isMaxLength(PREF_MAX_ENTRIES))),
  subProvider: Schema.optional(Schema.Record(ModelKey, Schema.String.check(Schema.isMaxLength(128)))),
  variant: Schema.optional(Schema.Record(ModelKey, Schema.String.check(Schema.isMaxLength(128)))),
  updatedAt: Schema.optional(Schema.Finite),
}).annotate({ identifier: "ModelPreferencesInfo" })

/**
 * A partial write. Only the fields a client actually changed are sent, so a
 * phone toggling one favorite cannot roll back a desktop rail reorder it never
 * observed. Deletions travel in `remove` rather than as null record values:
 * the OpenAPI emitter collapses a nullable union to its non-null branch, so a
 * null would work here but never reach the published contract or the generated
 * client's types.
 */
export const ModelPreferencesPatch = Schema.Struct({
  order: Schema.optional(Schema.Record(Schema.String, OrderSnapshot)),
  favorite: Schema.optional(Schema.Array(ModelKey).check(Schema.isMaxLength(PREF_MAX_ENTRIES))),
  recent: Schema.optional(Schema.Array(ModelRecentEntry).check(Schema.isMaxLength(PREF_MAX_ENTRIES))),
  subProvider: Schema.optional(Schema.Record(ModelKey, Schema.String.check(Schema.isMaxLength(128)))),
  variant: Schema.optional(Schema.Record(ModelKey, Schema.String.check(Schema.isMaxLength(128)))),
  remove: Schema.optional(
    Schema.Struct({
      order: Schema.optional(Schema.Array(Schema.String).check(Schema.isMaxLength(PREF_MAX_ENTRIES))),
      subProvider: Schema.optional(Schema.Array(ModelKey).check(Schema.isMaxLength(PREF_MAX_ENTRIES))),
      variant: Schema.optional(Schema.Array(ModelKey).check(Schema.isMaxLength(PREF_MAX_ENTRIES))),
    }).annotate({ identifier: "ModelPreferencesRemoval" }),
  ),
}).annotate({ identifier: "ModelPreferencesPatch" })

export const GlobalPaths = {
  health: "/global/health",
  event: "/global/event",
  eventInterest: "/global/event/interest",
  sessionRoots: "/global/session/roots",
  sessionGet: "/global/session/:sessionID",
  sessionTelemetry: "/global/session/telemetry",
  oxpActivities: "/global/oxp/activity",
  oxpActivity: "/global/oxp/activity/:activityID",
  oxpInvocations: "/global/oxp/activity/:activityID/invocations",
  oxpResource: "/global/oxp/resource",
  projects: "/global/project",
  config: "/global/config",
  preferences: "/global/preferences",
  dispose: "/global/dispose",
  resetLocalData: "/global/reset-local-data",
  upgrade: "/global/upgrade",
} as const

export const GlobalApi = HttpApi.make("global").add(
  HttpApiGroup.make("global")
    .add(
      HttpApiEndpoint.get("health", GlobalPaths.health, {
        success: described(GlobalHealth, "Health information"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.health",
          summary: "Get health",
          description: "Get health information about the OpenFork server.",
        }),
      ),
      HttpApiEndpoint.get("event", GlobalPaths.event, {
        success: GlobalEventSchema,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.event",
          summary: "Get global events",
          description: "Subscribe to global events from the OpenFork system using server-sent events.",
        }),
      ),
      HttpApiEndpoint.post("eventInterest", GlobalPaths.eventInterest, {
        payload: GlobalEventInterestInput,
        success: GlobalEventInterestResult,
        }).annotateMerge(
          OpenApi.annotations({
            // Keep this operation flat under `global` in generated SDKs. A
            // dotted `global.event.interest` identifier creates a nested Event
            // client that collides with the existing event clients and causes
            // generator renumbering (`Event2`, `Event3`).
            identifier: "global.eventInterest",
            summary: "Update event stream interest",
          description:
            "Update the foreground session set for one SSE subscriber so reconstructible background content can be suppressed upstream.",
        }),
      ),
      HttpApiEndpoint.get("sessionRoots", GlobalPaths.sessionRoots, {
        query: GlobalSessionRootsQuery,
        success: described(Schema.Array(Session.Info), "Recent root sessions"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.sessionRoots",
          summary: "List recent root sessions without instance bootstrap",
          description:
            "List recent non-archived root sessions directly from durable session storage. When projectID is supplied it is authoritative and the directory is retained only as the caller's canonical cache location; otherwise the read is directory-scoped. This startup surface never materializes directory config, plugins, providers, or tools.",
        }),
      ),
      HttpApiEndpoint.get("sessionGet", GlobalPaths.sessionGet, {
        params: { sessionID: SessionID },
        success: described(Schema.NullOr(Session.Info), "Durable session metadata"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.sessionGet",
          summary: "Locate a session without instance bootstrap",
          description:
            "Read one durable session record directly from global storage. Returns null when absent and never materializes directory config, plugins, providers, tools, or a workspace runtime.",
        }),
      ),
      HttpApiEndpoint.post("sessionTelemetry", GlobalPaths.sessionTelemetry, {
        payload: GlobalSessionTelemetryInput,
        success: described(GlobalSessionTelemetryResult, "Compact session telemetry snapshots"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.sessionTelemetry",
          summary: "Get compact session telemetry without instance bootstrap",
          description:
            "Read bounded live/settled session telemetry directly from global memory and durable telemetry storage. This endpoint never materializes directory config, plugins, providers, tools, or a workspace runtime.",
        }),
      ),
      HttpApiEndpoint.get("oxpActivities", GlobalPaths.oxpActivities, {
        query: GlobalOxpActivityListQuery,
        success: described(
          Schema.Array(OxpActivitySummary),
          "OXP parent activity summaries",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.oxpActivities",
          summary: "List OXP parent activities without workspace bootstrap",
          description:
            "List compact durable ChatGPT/OXP parent-activity summaries. The response contains no upstream correlation identifiers and never materializes a workspace runtime.",
        }),
      ),
      HttpApiEndpoint.get("oxpActivityGet", GlobalPaths.oxpActivity, {
        params: { activityID: OxpActivitySchema.ActivityID },
        success: described(
          Schema.NullOr(OxpActivitySummary),
          "OXP parent activity summary",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.oxpActivityGet",
          summary: "Get one OXP parent activity",
          description:
            "Read one durable OXP parent-activity summary directly from global storage without workspace bootstrap.",
        }),
      ),
      HttpApiEndpoint.get("oxpInvocations", GlobalPaths.oxpInvocations, {
        params: { activityID: OxpActivitySchema.ActivityID },
        query: GlobalOxpInvocationQuery,
        success: described(
          OxpInvocationPage,
          "Paginated OXP invocation history",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.oxpInvocations",
          summary: "Read OXP invocation history",
          description:
            "Read one parent activity's bounded invocation spans and causal links without hydrating Sessions, messages, providers, plugins, or workspace runtime state.",
        }),
      ),
      HttpApiEndpoint.get("oxpResource", GlobalPaths.oxpResource, {
        query: GlobalOxpResourceQuery,
        success: described(
          Schema.Array(OxpResourceProvenanceInfo),
          "Reverse OXP provenance for one durable resource handle",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.oxpResource",
          summary: "Find OXP provenance for a native resource",
          description:
            "Reverse lookup over durable OXP causal links. This is observability-only history and never grants authority over the referenced resource.",
        }),
      ),
      HttpApiEndpoint.patch("oxpActivityUpdate", GlobalPaths.oxpActivity, {
        params: { activityID: OxpActivitySchema.ActivityID },
        payload: GlobalOxpActivityPatch,
        success: described(Schema.Boolean, "OXP activity updated"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.oxpActivityUpdate",
          summary: "Rename or archive OXP activity history",
          description:
            "Update local presentation/history state only. This never mutates resources referenced by the activity.",
        }),
      ),
      HttpApiEndpoint.delete("oxpActivityDelete", GlobalPaths.oxpActivity, {
        params: { activityID: OxpActivitySchema.ActivityID },
        success: described(
          GlobalOxpActivityDeleteResult,
          "OXP activity deletion result",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.oxpActivityDelete",
          summary: "Delete OXP activity history",
          description:
            "Delete only OXP activity-history rows. Native Sessions, workers, tasks, files, commits, and other linked resources are never cascaded by this operation.",
        }),
      ),
      HttpApiEndpoint.get("projects", GlobalPaths.projects, {
        success: described(Schema.Array(Project.Info), "Projects"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.projects",
          summary: "List projects without instance bootstrap",
          description:
            "List durable project metadata without materializing directory config, plugins, providers, or tools. Intended for startup navigation/catalog hydration.",
        }),
      ),
      HttpApiEndpoint.get("configGet", GlobalPaths.config, {
        success: described(ConfigV1.Info, "Get global config info"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.config.get",
          summary: "Get global configuration",
          description: "Retrieve the current global OpenFork configuration settings and preferences.",
        }),
      ),
      HttpApiEndpoint.patch("configUpdate", GlobalPaths.config, {
        payload: ConfigV1.Info,
        success: described(ConfigV1.Info, "Successfully updated global config"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.config.update",
          summary: "Update global configuration",
          description: "Update global OpenFork configuration settings and preferences.",
        }),
      ),
      HttpApiEndpoint.get("preferencesGet", GlobalPaths.preferences, {
        success: described(ModelPreferencesInfo, "Model selector preferences"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.preferences.get",
          summary: "Get model selector preferences",
          description:
            "Read the model selector preferences shared by every client of this server: provider rail order, per-section model order, favorites, recents, and per-model routing pins.",
        }),
      ),
      HttpApiEndpoint.patch("preferencesUpdate", GlobalPaths.preferences, {
        payload: ModelPreferencesPatch,
        success: described(ModelPreferencesInfo, "Updated model selector preferences"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.preferences.update",
          summary: "Update model selector preferences",
          description:
            "Merge a partial model selector preferences document. Only the supplied fields are changed; a null value removes the key it is keyed under.",
        }),
      ),
      HttpApiEndpoint.post("dispose", GlobalPaths.dispose, {
        success: described(Schema.Boolean, "Global disposed"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.dispose",
          summary: "Dispose instance",
          description: "Clean up and dispose all OpenFork instances, releasing all resources.",
        }),
      ),
      HttpApiEndpoint.post("resetLocalData", GlobalPaths.resetLocalData, {
        payload: Schema.Struct({ confirmation: Schema.Literal("RESET") }),
        success: described(GlobalResetLocalDataResult, "Local history reset result"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.resetLocalData",
          summary: "Reset local OpenFork history",
          description:
            "Delete sessions, goals, memory, usage history, and derived database indexes while preserving provider authentication, credentials, accounts, paired devices, application settings, project/workspace configuration, saved project permissions, and database migration state.",
        }),
      ),
      HttpApiEndpoint.post("upgrade", GlobalPaths.upgrade, {
        payload: GlobalUpgradeInput,
        success: described(GlobalUpgradeResult, "Upgrade result"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.upgrade",
          summary: "Upgrade opencode",
          description: "Upgrade opencode to the specified version.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "global", description: "Global server routes." })),
)
