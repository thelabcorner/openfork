import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { EventV2 } from "@opencode-ai/core/event"
import {
  STREAM_INTEREST_MAX_SESSION_CHARS,
  STREAM_INTEREST_MAX_SESSIONS,
  STREAM_INTEREST_MAX_SUBSCRIBER_CHARS,
} from "@opencode-ai/core/session-stream-content"
import { EventManifest } from "@/event-manifest"
import { Session } from "@/session/session"
import { Project } from "@/project/project"
import { SessionTelemetry } from "@opencode-ai/schema/session-telemetry"
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
  sessionTelemetry: "/global/session/telemetry",
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
          description: "Get health information about the OpenCode server.",
        }),
      ),
      HttpApiEndpoint.get("event", GlobalPaths.event, {
        success: GlobalEventSchema,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.event",
          summary: "Get global events",
          description: "Subscribe to global events from the OpenCode system using server-sent events.",
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
            "List recent non-archived root sessions for one directory directly from durable session storage. This read-only startup surface intentionally does not materialize directory config, plugins, providers, or tools.",
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
          description: "Retrieve the current global OpenCode configuration settings and preferences.",
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
          description: "Update global OpenCode configuration settings and preferences.",
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
          description: "Clean up and dispose all OpenCode instances, releasing all resources.",
        }),
      ),
      HttpApiEndpoint.post("resetLocalData", GlobalPaths.resetLocalData, {
        payload: Schema.Struct({ confirmation: Schema.Literal("RESET") }),
        success: described(GlobalResetLocalDataResult, "Local history reset result"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.resetLocalData",
          summary: "Reset local OpenCode history",
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
