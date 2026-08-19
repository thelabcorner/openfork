import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import { BrokerClient } from "@/browser/broker-client"
import { DEFAULT_TIMEOUT_MS, FAMILY, OperationInput, permissionPattern } from "@/browser/shared"

export const Parameters = OperationInput.navigate

export const BrowserNavigateTool = Tool.define(
  "browser_navigate",
  Effect.gen(function* () {
    const broker = yield* BrokerClient.Service
    return {
      description:
        "Navigate this session's active owned browser tab to a new URL (or reload). waitUntil controls how long to wait for the page: commit (immediately), domcontentloaded, load (default), or networkidle. After navigating, call browser_snapshot to re-establish element refs — the previous snapshot's refs are stale and will be rejected with BrowserStaleRefError.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: FAMILY.navigate,
            patterns: [permissionPattern("navigate", params.url)],
            always: ["*"],
            metadata: { tool: "browser_navigate", url: params.url, waitUntil: params.waitUntil },
          })
          const { result, requestId, elapsedMs } = yield* broker.run({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            toolCallID: ctx.callID,
            operation: "navigate",
            input: params,
            timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS.navigate,
            abort: ctx.abort,
          })
          const navigated = result.navigated
          const redirect = navigated.redirectedFrom ? ` (redirected from ${navigated.redirectedFrom})` : ""
          const status = navigated.httpStatus !== undefined ? ` http ${navigated.httpStatus}` : ""
          return {
            title: "Navigated browser tab",
            output: `navigated tab ${navigated.tabId} -> ${navigated.url} "${navigated.title}" [${navigated.readyState}]${status}${redirect} viewport ${navigated.viewport.width}x${navigated.viewport.height}`,
            metadata: { op: "navigate", requestId, elapsedMs },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
