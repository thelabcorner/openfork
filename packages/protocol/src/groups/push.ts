import { PushSubscription } from "@opencode-ai/schema/push-subscription"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"

export const PushGroup = HttpApiGroup.make("server.push")
  .add(
    HttpApiEndpoint.get("push.publicKey.get", "/api/push/public-key", {
      success: Schema.Struct({ data: Schema.Struct({ publicKey: Schema.String }) }),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.push.publicKey.get",
        summary: "Get Web Push VAPID public key",
        description: "Retrieve the server's VAPID public key for PushManager.subscribe().",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("push.subscription.create", "/api/push/subscription", {
      payload: PushSubscription.SubscribeInput,
      success: Schema.Struct({ data: PushSubscription.Info }),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.push.subscription.create",
        summary: "Create or update a push subscription",
        description: "Register (or refresh) a browser PushSubscription so the server can send Web Push notifications.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.delete("push.subscription.delete", "/api/push/subscription", {
      query: Schema.Struct({ endpoint: Schema.String }),
      success: HttpApiSchema.NoContent,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.push.subscription.delete",
        summary: "Delete a push subscription",
        description: "Unsubscribe a browser PushSubscription by its endpoint.",
      }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "push", description: "Web Push (VAPID) notification routes." }))
