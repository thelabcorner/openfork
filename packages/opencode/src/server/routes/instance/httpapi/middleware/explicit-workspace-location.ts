import { Effect, Layer } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { Flag } from "@opencode-ai/core/flag/flag"
import { InvalidRequestError } from "../errors"

export class ExplicitWorkspaceLocationMiddleware extends HttpApiMiddleware.Service<ExplicitWorkspaceLocationMiddleware>()(
  "@opencode/HttpApiExplicitWorkspaceLocation",
  {
    error: InvalidRequestError,
  },
) {}

function present(value: string | undefined | null) {
  return typeof value === "string" && value.trim().length > 0
}

function hasExplicitLocation(request: HttpServerRequest.HttpServerRequest) {
  const url = new URL(request.url, "http://localhost")
  return (
    present(url.searchParams.get("directory")) ||
    present(url.searchParams.get("workspace")) ||
    present(request.headers["x-opencode-directory"]) ||
    present(Flag.OPENCODE_WORKSPACE_ID)
  )
}

export const explicitWorkspaceLocationLayer = Layer.succeed(
  ExplicitWorkspaceLocationMiddleware,
  ExplicitWorkspaceLocationMiddleware.of((effect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (!hasExplicitLocation(request)) {
        return yield* new InvalidRequestError({
          message: "An explicit directory or workspace is required for this operation",
          kind: "MissingLocation",
          field: "directory",
        })
      }
      return yield* effect
    }),
  ),
)
