import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { PendingResponseRegistry } from "@/server/pending-response-registry"
import { WorkspaceRouteContext } from "../middleware/workspace-routing"
import { FSUtil } from "@opencode-ai/core/fs-util"

export const permissionHandlers = HttpApiBuilder.group(InstanceHttpApi, "permission", (handlers) =>
  Effect.gen(function* () {
    const responses = yield* PendingResponseRegistry.Service

    const list = Effect.fn("PermissionHttpApi.list")(function* () {
      const route = yield* WorkspaceRouteContext
      return (yield* responses.list({ kind: "permission", directory: FSUtil.resolve(route.directory) })) as ReadonlyArray<
        typeof PermissionV1.Request.Type
      >
    })

    return handlers.handle("list", list)
  }),
)
