import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import { BrokerClient } from "@/browser/broker-client"
import { DEFAULT_TIMEOUT_MS, FAMILY, OperationInput, permissionPattern } from "@/browser/shared"

export const Parameters = OperationInput.visual_capture

type VisualCaptureMetadata = {
  [key: string]: unknown
  op: "visual_capture"
  requestId: string
  elapsedMs: number
  runId: string
  status: "ok" | "error"
}

export const BrowserVisualCaptureTool = Tool.define(
  "browser_visual_capture",
  Effect.gen(function* () {
    const broker = yield* BrokerClient.Service
    return {
      description:
        "Create or deliberately replace a deterministic SnapEye visual baseline for the current browser state. Use before a visual refactor/change, then use visual_diff afterward. The baseline is written under the current project .snapeye/baselines directory; run artifacts are bounded and do not enter model context. Target defaults to the document and also accepts CSS or {kind:'element',target:<snapshot ref/locator/coords>}. Optional redact policy is fingerprinted into the baseline contract. Never recapture after a change merely to make a diff pass.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: FAMILY.visual_capture,
            patterns: [permissionPattern("visual_capture")],
            always: ["*"],
            metadata: { tool: "browser_visual_capture", name: params.name, target: params.target },
          })
          const { result, requestId, elapsedMs } = yield* broker.run({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            toolCallID: ctx.callID,
            tabId: params.tabId,
            operation: "visual_capture",
            input: params,
            timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS.visual_capture,
            abort: ctx.abort,
          })
          const visual = result.visual
          const metadata: VisualCaptureMetadata = visual.status === "error"
            ? { op: "visual_capture", requestId, elapsedMs, runId: visual.runId, status: "error", error: visual.error }
            : {
                op: "visual_capture",
                requestId,
                elapsedMs,
                runId: visual.runId,
                status: "ok",
                name: visual.name,
                image: visual.image,
                timing: visual.timing,
                artifacts: visual.artifacts,
                environment: visual.opencode,
              }
          if (visual.status === "error") {
            return {
              title: `Visual capture failed: ${params.name}`,
              output: `SnapEye capture failed (${visual.error.code}): ${visual.error.message}`,
              metadata,
            }
          }
          return {
            title: `Captured visual baseline: ${params.name}`,
            output: `captured deterministic baseline ${params.name} (run ${visual.runId}, ${visual.image.cssWidth}x${visual.image.cssHeight} CSS px, ${visual.image.pixelWidth}x${visual.image.pixelHeight} raster px, ${Math.round(visual.timing.captureMs)}ms SnapDOM capture)`,
            metadata,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
