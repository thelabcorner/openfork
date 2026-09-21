import { SystemOne } from "@opencode-ai/schema/system-one"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import {
  ForbiddenError,
  InvalidRequestError,
  ModelNotFoundError,
  QuotaExceededError,
  RateLimitError,
  TimeoutError,
  UnauthorizedError,
  UpstreamError,
} from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { ExplicitWorkspaceLocationMiddleware } from "../middleware/explicit-workspace-location"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

export const SystemOnePaths = {
  infer: "/system-one/infer",
} as const

/**
 * Tier 2 semantic inference. Provider/catalog/config resolution is
 * workspace-scoped, but this operation does not create or mutate a Session.
 */
export const SystemOneApi = HttpApi.make("system-one").add(
  HttpApiGroup.make("system-one")
    .add(
      HttpApiEndpoint.post("infer", SystemOnePaths.infer, {
        query: WorkspaceRoutingQuery,
        payload: SystemOne.InferInput,
        success: described(SystemOne.InferResult, "Typed System One semantic inference result"),
        error: [
          InvalidRequestError,
          ModelNotFoundError,
          UnauthorizedError,
          ForbiddenError,
          RateLimitError,
          QuotaExceededError,
          UpstreamError,
          TimeoutError,
        ],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "systemOne.infer",
          summary: "Run typed System One semantic inference",
          description:
            "Runs a non-generative semantic model over shared structured state and typed Noul, Choice, or Score questions. Raw probabilities and scores are preserved in the response.",
        }),
      ),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(ExplicitWorkspaceLocationMiddleware)
    .middleware(Authorization),
)
