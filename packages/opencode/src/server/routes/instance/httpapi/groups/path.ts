import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const PathInfo = Schema.Struct({
  home: Schema.String,
  state: Schema.String,
  config: Schema.String,
  worktree: Schema.String,
  directory: Schema.String,
}).annotate({ identifier: "Path" })

// Path metadata is a Tier-1 explicit-location read. It must stay outside the
// execution Instance middleware used by the neighboring instance operations.
export const PathApi = HttpApi.make("path")
  .add(
    HttpApiGroup.make("path")
      .add(
        HttpApiEndpoint.get("get", "/path", {
          query: WorkspaceRoutingQuery,
          success: described(PathInfo, "Path information"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "path.get",
            summary: "Get paths",
            description: "Retrieve process path metadata for the explicitly routed workspace.",
          }),
        ),
      )
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "OpenFork path metadata",
      version: "0.0.1",
      description: "Explicit-location path metadata without execution instance bootstrap.",
    }),
  )
