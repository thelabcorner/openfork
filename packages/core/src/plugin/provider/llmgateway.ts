import { Effect } from "effect"
import { define } from "../internal"
import { Integration } from "../../integration"
import { PRODUCT_NAME, PRODUCT_REPOSITORY_URL, PRODUCT_SLUG } from "../../brand"

export const LLMGatewayPlugin = define({
  id: "llmgateway",
  effect: Effect.fn(function* (ctx) {
    const integrations = yield* Integration.Service
    yield* ctx.catalog.transform(
      Effect.fn(function* (evt) {
        for (const item of evt.provider.list()) {
          if (item.provider.disabled) continue
          if (item.provider.api.type !== "aisdk") continue
          if (item.provider.api.package !== "@ai-sdk/openai-compatible") continue
          if (item.provider.api.url !== "https://api.llmgateway.io/v1") continue
          if (!(yield* integrations.get(Integration.ID.make(item.provider.id)))) continue
          evt.provider.update(item.provider.id, (provider) => {
            provider.request.headers["HTTP-Referer"] = PRODUCT_REPOSITORY_URL
            provider.request.headers["X-Title"] = PRODUCT_NAME
            provider.request.headers["X-Source"] = PRODUCT_SLUG
          })
        }
      }),
    )
  }),
})
