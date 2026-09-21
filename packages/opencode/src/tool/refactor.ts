import { Effect } from "effect"
import { AppProcess } from "@opencode-ai/core/process"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ExchangeRefactor } from "@/exchange/refactor"
import { InstanceState } from "@/effect/instance-state"
import * as Tool from "./tool"
import DESCRIPTION from "./refactor.txt"

export * from "@/exchange/refactor"

export const RefactorTool = Tool.define<
  typeof ExchangeRefactor.Parameters,
  ExchangeRefactor.Metadata,
  AppProcess.Service | FSUtil.Service
>(
  "refactor",
  Effect.gen(function* () {
    const app = yield* AppProcess.Service
    const fs = yield* FSUtil.Service
    return {
      exposure: "lazy" as const,
      description: DESCRIPTION,
      parameters: ExchangeRefactor.Parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          return yield* ExchangeRefactor.execute(params, {
            worktree: instance.directory,
            abort: ctx.abort,
            ask: (request) =>
              ctx.ask({
                ...request,
                metadata: request.metadata ?? {},
              }),
          })
        }).pipe(
          Effect.provideService(AppProcess.Service, app),
          Effect.provideService(FSUtil.Service, fs),
          Effect.orDie,
        ),
    }
  }),
)
