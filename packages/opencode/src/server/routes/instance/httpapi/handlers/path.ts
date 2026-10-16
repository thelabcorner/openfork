import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/core/global"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { PathApi } from "../groups/path"
import { WorkspaceRouteContext } from "../middleware/workspace-routing"

export const pathHandlers = HttpApiBuilder.group(PathApi, "path", (handlers) =>
  Effect.gen(function* () {
    const project = yield* ProjectV2.Service
    return handlers.handle("get", () =>
      Effect.gen(function* () {
        const location = yield* WorkspaceRouteContext
        const resolved = yield* project.resolve(AbsolutePath.make(location.directory))
        return {
          home: Global.Path.home,
          state: Global.Path.state,
          config: Global.Path.config,
          worktree: resolved.directory,
          directory: location.directory,
        }
      }),
    )
  }),
)
