import { PromptRevisorRuns } from "@/prompt-revisor/run-registry"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { RootHttpApi } from "../api"
import { PromptRevisorRunCancelPayload, PromptRevisorRunQuery } from "../groups/prompt-revisor-runs"

/**
 * The registry is module-global process memory (no Database, no Location, no
 * Instance), so these handlers require no services from the route graph.
 */
export const promptRevisorRunHandlers = HttpApiBuilder.group(RootHttpApi, "promptRevisorRuns", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle("status", (ctx: { query: typeof PromptRevisorRunQuery.Type }) =>
        PromptRevisorRuns.status({ kind: ctx.query.kind, key: ctx.query.key }).pipe(
          Effect.map((value) => value ?? null),
        ),
      )
      .handle("cancel", (ctx: { payload: typeof PromptRevisorRunCancelPayload.Type }) =>
        PromptRevisorRuns.cancel({
          locator: { kind: ctx.payload.kind, key: ctx.payload.key },
          ...(ctx.payload.operationID === undefined ? {} : { operationID: ctx.payload.operationID }),
        }),
      )
  }),
)
