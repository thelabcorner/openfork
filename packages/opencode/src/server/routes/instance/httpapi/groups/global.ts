import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { EventV2 } from "@opencode-ai/core/event"
import { EventManifest } from "@/event-manifest"
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
  config: "/global/config",
  preferences: "/global/preferences",
  dispose: "/global/dispose",
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
