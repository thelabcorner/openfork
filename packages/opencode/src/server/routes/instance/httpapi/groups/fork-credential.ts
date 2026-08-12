import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"

const DirectoryQuery = Schema.Struct({
  directory: Schema.optional(Schema.String),
})

export const ForkCredentialInfo = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  active: Schema.Boolean,
  timeCreated: Schema.Finite,
})

export const ForkWindowUsage = Schema.Struct({
  label: Schema.Literals(["5h", "week", "month"]),
  spentUSD: Schema.Finite,
  limitUSD: Schema.Finite,
  estimatedPercent: Schema.optional(Schema.Finite),
  resetsAt: Schema.Finite,
  clearsAt: Schema.Finite,
  lastUsedAt: Schema.optional(Schema.Finite),
  callsInWindow: Schema.Finite,
  source: Schema.optional(Schema.Literals(["api", "local"])),
  status: Schema.optional(Schema.String),
})

export const ForkCredentialUsage = Schema.Struct({
  credentialID: Schema.String,
  windows: Schema.Array(ForkWindowUsage),
  // Additive envelope metadata about the official snapshot served for this
  // credential (age/status of the remote OpenCode Go usage data). Absent for
  // old servers / local-only responses; clients must treat as optional.
  official: Schema.optional(
    Schema.Struct({
      fetchedAt: Schema.Finite,
      ageMs: Schema.Finite,
      status: Schema.Literals(["ok", "stale", "error"]),
    }),
  ),
})

export const ForkUsageResult = Schema.Struct({
  aggregate: Schema.Array(ForkWindowUsage),
  byCredential: Schema.Array(ForkCredentialUsage),
})

const root = "/fork/credential"

export const ForkCredentialApi = HttpApi.make("fork-credential").add(
  HttpApiGroup.make("fork-credential")
    .add(
      HttpApiEndpoint.get("list", root, {
        success: described(Schema.Array(ForkCredentialInfo), "Stored OpenCode credentials"),
      }).annotateMerge(
        OpenApi.annotations({ identifier: "fork.credential.list", summary: "List OpenCode credentials" }),
      ),
    )
    .add(
      HttpApiEndpoint.post("add", root, {
        query: DirectoryQuery,
        payload: Schema.Struct({ key: Schema.String, label: Schema.optional(Schema.String) }),
        success: described(ForkCredentialInfo, "Added credential"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(OpenApi.annotations({ identifier: "fork.credential.add", summary: "Add an OpenCode key" })),
    )
    .add(
      HttpApiEndpoint.post("select", `${root}/:id/select`, {
        params: { id: Schema.String },
        query: DirectoryQuery,
        success: described(Schema.Boolean, "Selected credential"),
      }).annotateMerge(
        OpenApi.annotations({ identifier: "fork.credential.select", summary: "Select the active credential" }),
      ),
    )
    .add(
      HttpApiEndpoint.patch("rename", `${root}/:id`, {
        params: { id: Schema.String },
        payload: Schema.Struct({ label: Schema.String }),
        success: described(Schema.Boolean, "Renamed credential"),
      }).annotateMerge(OpenApi.annotations({ identifier: "fork.credential.rename", summary: "Rename a credential" })),
    )
    .add(
      HttpApiEndpoint.delete("remove", `${root}/:id`, {
        params: { id: Schema.String },
        query: DirectoryQuery,
        success: described(Schema.Boolean, "Removed credential"),
      }).annotateMerge(OpenApi.annotations({ identifier: "fork.credential.remove", summary: "Remove a credential" })),
    )
    .add(
      HttpApiEndpoint.get("usage", "/fork/usage", {
        success: described(ForkUsageResult, "Aggregate and per-credential OpenCode Go usage"),
      }).annotateMerge(OpenApi.annotations({ identifier: "fork.usage.get", summary: "Get OpenCode Go usage" })),
    )
    .annotateMerge(OpenApi.annotations({ title: "fork-credential", description: "Fork-owned OpenCode credential store." })),
)
