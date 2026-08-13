import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import { BrokerClient } from "@/browser/broker-client"
import { DEFAULT_TIMEOUT_MS, FAMILY, OperationInput, permissionPattern } from "@/browser/shared"

export const Parameters = OperationInput.open

export const BrowserOpenTool = Tool.define(
  "browser_open",
  Effect.gen(function* () {
    const broker = yield* BrokerClient.Service
    return {
      description:
        "Open a URL in the visible Desktop browser guest for this session. Use this when BrowserTabNotFound / BrowserGuestCrashed / BrowserNotAttached says there is no live page, or when the session has no browser yet. After opening, call browser_snapshot to get numbered element refs (e1..eN) for targeting.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: FAMILY.open,
            patterns: [permissionPattern("open", params.url)],
            always: ["*"],
            metadata: { tool: "browser_open", url: params.url, newTab: params.newTab, activate: params.activate, appearance: params.appearance },
          })
          const { result, requestId, elapsedMs } = yield* broker.run({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            toolCallID: ctx.callID,
            operation: "open",
            input: params,
            timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS.open,
            abort: ctx.abort,
          })
          const opened = result.opened
          return {
            title: "Opened browser tab",
            output: `opened tab ${opened.tabId} -> ${opened.url} "${opened.title}" [${opened.readyState}] viewport ${opened.viewport.width}x${opened.viewport.height}`,
            metadata: { op: "open", requestId, elapsedMs },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
