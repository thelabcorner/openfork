import { Git } from "@/git"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { VcsBranchApi } from "../groups/instance"
import { WorkspaceRouteContext } from "../middleware/workspace-routing"

export const vcsBranchHandlers = HttpApiBuilder.group(VcsBranchApi, "vcs-branch", (handlers) =>
  Effect.gen(function* () {
    const git = yield* Git.Service
    return handlers.handle("vcs", () =>
      Effect.gen(function* () {
        const location = yield* WorkspaceRouteContext
        const [branch, defaultBranch] = yield* Effect.all(
          [git.branch(location.directory), git.defaultBranch(location.directory)],
          { concurrency: 2 },
        )
        return { branch, default_branch: defaultBranch?.name }
      }),
    )
  }),
)
