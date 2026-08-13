import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

export const WindowUsage = Schema.Struct({
  label: Schema.Literals(["5h", "week", "month"]),
  spentUSD: Schema.Finite,
  limitUSD: Schema.Finite,
  resetsAt: Schema.Finite,
  callsInWindow: Schema.Finite,
})

export const UsageGroup = HttpApiGroup.make("server.usage").add(
  HttpApiEndpoint.get("usage.go", "/api/usage/go", {
    success: Schema.Array(WindowUsage),
  }).annotateMerge(
    OpenApi.annotations({
      identifier: "v2.usage.go",
      summary: "Get OpenCode Go usage",
      description: "Retrieve OpenCode Go plan spend against its 5-hour, weekly, and monthly budgets.",
    }),
  ),
)
