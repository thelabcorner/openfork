import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import { BrokerClient } from "@/browser/broker-client"
import { DEFAULT_TIMEOUT_MS, FAMILY, OperationInput, formatOwner, permissionPattern } from "@/browser/shared"

export const Parameters = OperationInput.open

export const BrowserOpenTool = Tool.define(
  "browser_open",
  Effect.gen(function* () {
    const broker = yield* BrokerClient.Service
    return {
      description:
        "Open a URL in a browser tab owned by this session. With tabId + claim: true, claims a user-owned tab for this session and navigates it in one call. With no tabId and newTab unset, reuses the session's most-recently-active owned tab (navigates it); otherwise creates a new owned tab. The result reports the tab's owner. Use this after BrowserTabNotFound / BrowserGuestCrashed / BrowserHostUnavailable, or to claim a user tab.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: FAMILY.open,
            patterns: [permissionPattern("open", params.url)],
            always: ["*"],
            metadata: { tool: "browser_open", url: params.url, tabId: params.tabId, claim: params.claim, newTab: params.newTab, activate: params.activate, appearance: params.appearance },
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
            output: `opened tab ${opened.tabId} (owner ${formatOwner(opened.owner)}) -> ${opened.url} "${opened.title}" [${opened.readyState}] viewport ${opened.viewport.width}x${opened.viewport.height}`,
            metadata: { op: "open", requestId, elapsedMs },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
