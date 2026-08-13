import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import { BrokerClient } from "@/browser/broker-client"
import { DEFAULT_TIMEOUT_MS, FAMILY, OperationInput, permissionPattern, formatViewport } from "@/browser/shared"

export const Parameters = OperationInput.screenshot

export const BrowserScreenshotTool = Tool.define(
  "browser_screenshot",
  Effect.gen(function* () {
    const broker = yield* BrokerClient.Service
    return {
      description:
        "Capture a screenshot of the visible Desktop browser page. Use this when visual layout, screenshots, canvas output, or pixel state matters beyond browser_snapshot's DOM/text data. Returns base64 image data in metadata plus viewport dimensions.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: FAMILY.screenshot,
            patterns: [permissionPattern("screenshot")],
            always: ["*"],
            metadata: { tool: "browser_screenshot", tabId: params.tabId, format: params.format, fullPage: params.fullPage },
          })
          const { result, requestId, elapsedMs } = yield* broker.run({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            toolCallID: ctx.callID,
            tabId: params.tabId,
            operation: "screenshot",
            input: params,
            timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS.screenshot,
            abort: ctx.abort,
          })
          const screenshot = result.screenshot
          return {
            title: `Screenshot of ${screenshot.url}`,
            output: `captured ${screenshot.mime} screenshot of tab ${screenshot.tabId} (${screenshot.width}x${screenshot.height}, ${formatViewport(screenshot.viewport)})`,
            metadata: {
              op: "screenshot",
              requestId,
              elapsedMs,
              mime: screenshot.mime,
              data: screenshot.data,
              width: screenshot.width,
              height: screenshot.height,
              capturedAt: screenshot.capturedAt,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
