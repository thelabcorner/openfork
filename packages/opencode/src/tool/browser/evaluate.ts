import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import { BrokerClient } from "@/browser/broker-client"
import { DEFAULT_TIMEOUT_MS, FAMILY, OperationInput, permissionPattern } from "@/browser/shared"

export const Parameters = OperationInput.evaluate

export const BrowserEvaluateTool = Tool.define(
  "browser_evaluate",
  Effect.gen(function* () {
    const broker = yield* BrokerClient.Service
    return {
      description:
        "Evaluate a JavaScript expression in the page context and return its JSON-serializable result. Use for reading state (window/document values, DOM reads) that the accessibility snapshot does not expose, including React/Babel inspection: read window.__REACT_DEVTOOLS_GLOBAL_HOOK__ (React DevTools hook), React Fiber via DOM expando keys (__reactFiber$ / __reactInternalInstance$), Babel-compiled JSX sources, source maps (e.g. document.querySelectorAll('script[src]'), fetch()+sourcemap comments, or performance.getEntriesByType('resource')), and transpiled chunk URLs. The result is capped by maxResultBytes (default the host's cap); oversized results are truncated and flagged, or rejected with BrowserResultTooLarge when they cannot be capped. Arguments are JSON values referenced as args[0..n]. This is read/compute-only: prefer browser_click/type/press for interaction. For structured React component inspection prefer browser_react_inspect; for DevTools UI use browser_open_devtools and browser_extensions_list to verify React DevTools is installed.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: FAMILY.evaluate,
            patterns: [permissionPattern("evaluate")],
            always: ["*"],
            metadata: { tool: "browser_evaluate", script: params.script.slice(0, 200), awaitPromise: params.awaitPromise, maxResultBytes: params.maxResultBytes },
          })
          const { result, requestId, elapsedMs } = yield* broker.run({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            toolCallID: ctx.callID,
            operation: "evaluate",
            input: params,
            timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS.evaluate,
            abort: ctx.abort,
          })
          const evaluated = result.evaluated
          const error = evaluated.error ? ` error: ${evaluated.error}` : ""
          const truncated = evaluated.truncated ? " (result truncated)" : ""
          return {
            title: "Evaluated page expression",
            output: `result (${evaluated.type}): ${JSON.stringify(evaluated.result)}${truncated}${error}`,
            metadata: { op: "evaluate", requestId, elapsedMs },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
