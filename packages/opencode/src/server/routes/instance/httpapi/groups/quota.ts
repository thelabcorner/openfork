import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Quota } from "@/quota/quota"
import { ApiNotFoundError } from "../errors"
import { described } from "./metadata"
import { Authorization } from "../middleware/authorization"

export const QuotaPaths = {
  providers: "/quota/providers",
  resets: "/quota/resets",
  get: "/quota/:providerID",
} as const

export const ResetAgendaQuery = Schema.Struct({
  from: Schema.NumberFromString,
  to: Schema.NumberFromString,
})

export const QuotaApi = HttpApi.make("quota").add(
  HttpApiGroup.make("quota")
    .add(
      HttpApiEndpoint.get("providers", QuotaPaths.providers, {
        success: described(Quota.ProvidersResult, "Registered quota providers with configured state"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "quota.providers",
          summary: "List quota providers",
          description:
            "Lists every registered provider-account quota source and whether credentials are present. Purely informational; never blocks inference.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("resets", QuotaPaths.resets, {
        query: ResetAgendaQuery,
        success: described(Quota.ResetAgendaResult, "Known provider quota reset deadlines for a bounded calendar range"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "quota.resets",
          summary: "Quota reset calendar agenda",
          description:
            "Tier 0 bounded projection of reset deadlines already known by the quota/fork usage owners. It does not synthesize future recurrences and never materializes a workspace Instance.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("get", QuotaPaths.get, {
        params: { providerID: Schema.String },
        success: described(Quota.ProviderResult, "Normalized provider quota result"),
        error: [HttpApiError.BadRequest, ApiNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "quota.get",
          summary: "Get provider quota",
          description:
            "Fetches the provider's account usage/balance endpoint and normalizes it into quota windows. Failures are reported inside the result envelope (ok=false), not as HTTP errors.",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "quota",
        description: "Proactive provider-account quota status. Advisory display state only.",
      }),
    )
    .middleware(Authorization),
)
