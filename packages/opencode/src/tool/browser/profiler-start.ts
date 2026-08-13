import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import { BrokerClient } from "@/browser/broker-client"
import { DEFAULT_TIMEOUT_MS, FAMILY, OperationInput, permissionPattern } from "@/browser/shared"

export const Parameters = OperationInput.profiler_start

export const BrowserProfilerStartTool = Tool.define(
  "browser_profiler_start",
  Effect.gen(function* () {
    const broker = yield* BrokerClient.Service
    return {
      description:
        "Start React profiling on the guest page (observation-only). The host installs the React DevTools commit hook if absent and records commit timings + per-component render counts between start and stop. Fails with BrowserNotAReactAppError on non-React pages. IMPORTANT HONESTY CONSTRAINT: render counts come from a fiber-walk approximation — they are NOT wall-clock profiling; treat them as relative signals only. Pair with browser_profiler_stop.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: FAMILY.profiler_start,
            patterns: [permissionPattern("profiler_start")],
            always: ["*"],
            metadata: { tool: "browser_profiler_start", tabId: params.tabId },
          })
          const { result, requestId, elapsedMs } = yield* broker.run({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            toolCallID: ctx.callID,
            tabId: params.tabId,
            operation: "profiler_start",
            input: params,
            timeoutMs: DEFAULT_TIMEOUT_MS.profiler_start,
            abort: ctx.abort,
          })
          return {
            title: "Started browser React profiler",
            output: `React profiler started (snapshotVersion ${result.started.snapshotVersion}) — record activity, then call browser_profiler_stop`,
            metadata: { op: "profiler_start", requestId, elapsedMs },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
