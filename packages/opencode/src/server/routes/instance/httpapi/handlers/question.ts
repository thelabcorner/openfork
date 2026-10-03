import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { PendingResponseRegistry } from "@/server/pending-response-registry"
import { WorkspaceRouteContext } from "../middleware/workspace-routing"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { QuestionV1 } from "@opencode-ai/schema/question-v1"

export const questionHandlers = HttpApiBuilder.group(InstanceHttpApi, "question", (handlers) =>
  Effect.gen(function* () {
    const responses = yield* PendingResponseRegistry.Service

    const list = Effect.fn("QuestionHttpApi.list")(function* () {
      const route = yield* WorkspaceRouteContext
      return (yield* responses.list({ kind: "question", directory: FSUtil.resolve(route.directory) })) as ReadonlyArray<
        typeof QuestionV1.Request.Type
      >
    })

    return handlers.handle("list", list)
  }),
)
