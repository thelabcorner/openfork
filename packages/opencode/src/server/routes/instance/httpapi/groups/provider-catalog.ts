import { Provider } from "@/provider/provider"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { described } from "./metadata"

export const ProviderCatalogQuery = Schema.Struct({
  directory: Schema.optional(Schema.String),
  workspace: Schema.optional(Schema.String),
})

export const ProviderCatalogApi = HttpApi.make("provider-catalog").add(
  HttpApiGroup.make("providerCatalog")
    .add(
      HttpApiEndpoint.get("list", "/provider", {
        query: ProviderCatalogQuery,
        success: described(Provider.ListResult, "Progressive provider catalog"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "provider.list",
          summary: "Read the progressive provider catalog",
          description:
            "Returns a cached Tier-2 baseline immediately and reports whether runtime provider contributions have materialized.",
        }),
      ),
    )
    .middleware(Authorization),
)
