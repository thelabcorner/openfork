import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import { BrokerClient } from "@/browser/broker-client"
import { DEFAULT_TIMEOUT_MS, FAMILY, OperationInput, permissionPattern } from "@/browser/shared"

export const Parameters = OperationInput.open_devtools

export const BrowserOpenDevtoolsTool = Tool.define(
  "browser_open_devtools",
  Effect.gen(function* () {
    const broker = yield* BrokerClient.Service
    return {
      description:
        "Open Chrome DevTools for the browser tab (detached window). Use to inspect the live page with Chrome DevTools / React DevTools. The DevTools window opens detached (mode: detach) on the host desktop — pair with browser_evaluate for headless inspection (React Fiber via browser_react_inspect, or reading window.__REACT_DEVTOOLS_GLOBAL_HOOK__ / Babel-compiled sources via browser_evaluate). The tab is resolved to this session's most-recently-active owned tab when tabId is omitted. Requires an attached guest tab — call browser_open first if the session has no tab.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: FAMILY.open_devtools,
            patterns: [permissionPattern("open_devtools")],
            always: ["*"],
            metadata: { tool: "browser_open_devtools", tabId: params.tabId },
          })
          const { result, requestId, elapsedMs } = yield* broker.run({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            toolCallID: ctx.callID,
            ...(params.tabId ? { tabId: params.tabId } : {}),
            operation: "open_devtools",
            input: params,
            timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS.open_devtools,
            abort: ctx.abort,
          })
          return {
            title: "Opened DevTools",
            output: `DevTools opened for tab ${result.devtools.tabId} (open: ${result.devtools.open})`,
            metadata: { op: "open_devtools", requestId, elapsedMs },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
