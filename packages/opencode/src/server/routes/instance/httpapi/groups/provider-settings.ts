import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Connection } from "@opencode-ai/schema/connection"
import { Credential } from "@opencode-ai/schema/credential"
import { Integration } from "@opencode-ai/schema/integration"
import { Authorization } from "../middleware/authorization"
import { described } from "./metadata"

export const ProviderSettingsSource = Schema.Literals(["env", "api", "config", "custom"])

export const ProviderSettingsItem = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  source: ProviderSettingsSource,
  connected: Schema.Boolean,
  hasPaidModels: Schema.Boolean,
  connections: Schema.Array(Connection.Info),
})

export const ProviderSettingsCatalog = Schema.Struct({
  providers: Schema.Array(ProviderSettingsItem),
})

export const ProviderSettingsModel = Schema.Struct({
  providerID: Schema.String,
  providerName: Schema.String,
  modelID: Schema.String,
  name: Schema.String,
  family: Schema.optional(Schema.String),
  releaseDate: Schema.String,
})

export const ProviderSettingsModels = Schema.Struct({
  models: Schema.Array(ProviderSettingsModel),
})

export const ProviderSettingsPaths = {
  list: "/provider-settings",
  models: "/provider-settings/models",
  connectKey: "/provider-settings/:providerID/key",
  credential: "/provider-settings/credential/:credentialID",
  credentialSelect: "/provider-settings/credential/:credentialID/select",
} as const

/**
 * Process-global provider settings projection.
 *
 * This intentionally excludes workspace/plugin-resolved provider state. It is
 * the server-settings view: Models.dev + global config + global credentials and
 * environment availability. Workspace provider/model catalogs remain Tier 2
 * and require an explicit location on their existing APIs.
 */
export const ProviderSettingsApi = HttpApi.make("provider-settings").add(
  HttpApiGroup.make("provider-settings")
    .add(
      HttpApiEndpoint.get("list", ProviderSettingsPaths.list, {
        success: described(ProviderSettingsCatalog, "Global provider settings catalog"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "providerSettings.list",
          summary: "List server-level providers without workspace bootstrap",
          description:
            "List provider identities and global connection state from Models.dev, global configuration, credentials, and environment variables. This endpoint never materializes a workspace instance or plugin runtime.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("connectKey", ProviderSettingsPaths.connectKey, {
        params: { providerID: Integration.ID },
        payload: Schema.Struct({ key: Schema.String, label: Schema.optional(Schema.String) }),
        success: HttpApiSchema.NoContent,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "providerSettings.connectKey",
          summary: "Store a server-level provider key",
          description:
            "Store a provider API key in the process-global credential store without creating a workspace instance.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("models", ProviderSettingsPaths.models, {
        success: described(ProviderSettingsModels, "Server-level connected model catalog"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "providerSettings.models",
          summary: "List models for server-level connected providers",
          description:
            "Return only the model identity metadata required by server-level model visibility settings, without workspace/provider runtime bootstrap.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.patch("credentialUpdate", ProviderSettingsPaths.credential, {
        params: { credentialID: Credential.ID },
        payload: Schema.Struct({ label: Schema.String }),
        success: HttpApiSchema.NoContent,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "providerSettings.credential.update",
          summary: "Rename a server-level provider credential",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.delete("credentialRemove", ProviderSettingsPaths.credential, {
        params: { credentialID: Credential.ID },
        success: HttpApiSchema.NoContent,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "providerSettings.credential.remove",
          summary: "Remove a server-level provider credential",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("credentialSelect", ProviderSettingsPaths.credentialSelect, {
        params: { credentialID: Credential.ID },
        success: HttpApiSchema.NoContent,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "providerSettings.credential.select",
          summary: "Select a server-level provider credential",
        }),
      ),
    )
    .middleware(Authorization)
    .annotateMerge(
      OpenApi.annotations({
        title: "provider settings",
        description: "Bootstrap-free server-level provider settings metadata.",
      }),
    ),
)
