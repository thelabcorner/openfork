import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import { BrokerClient } from "@/browser/broker-client"
import { DEFAULT_TIMEOUT_MS, FAMILY, OperationInput, permissionPattern } from "@/browser/shared"

export const Parameters = OperationInput.visual_record

type VisualRecordMetadata = {
  [key: string]: unknown
  op: "visual_record"
  requestId: string
  elapsedMs: number
  runId: string
  status: "ok" | "error"
}

export const BrowserVisualRecordTool = Tool.define(
  "browser_visual_record",
  Effect.gen(function* () {
    const broker = yield* BrokerClient.Service
    return {
      description:
        "Record a bounded deterministic SnapEye visual sample of the current browser state. Use this for animations, transitions, loading states, and other motion where capture/diff of one instant is insufficient. The compact result includes frame timing and filmstrip metadata; frames.png and optional GIF/video stay under the project .snapeye/runs directory and are not inserted into model context. Target may be the document, CSS, or {kind:'element',target:<snapshot ref/locator/coords>}.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: FAMILY.visual_record,
            patterns: [permissionPattern("visual_record")],
            always: ["*"],
            metadata: {
              tool: "browser_visual_record",
              name: params.name,
              target: params.target,
              duration: params.duration,
              fps: params.fps,
              format: params.format,
            },
          })
          const { result, requestId, elapsedMs } = yield* broker.run({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            toolCallID: ctx.callID,
            tabId: params.tabId,
            operation: "visual_record",
            input: params,
            timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS.visual_record,
            abort: ctx.abort,
          })
          const visual = result.visual
          const metadata: VisualRecordMetadata = visual.status === "error"
            ? { op: "visual_record", requestId, elapsedMs, runId: visual.runId, status: "error", error: visual.error }
            : {
                op: "visual_record",
                requestId,
                elapsedMs,
                runId: visual.runId,
                status: "ok",
                name: visual.name,
                image: visual.image,
                record: visual.record,
                artifacts: visual.artifacts,
                environment: visual.opencode,
              }
          if (visual.status === "error") {
            return {
              title: `Visual record failed: ${params.name}`,
              output: `SnapEye record failed (${visual.error.code}): ${visual.error.message}`,
              metadata,
            }
          }
          const record = visual.record
          return {
            title: `Recorded visual motion: ${params.name}`,
            output:
              `SnapEye recorded ${params.name}: ${record.frameCount} frames, ${record.durationActualMs}ms actual, ${record.fpsActual.toFixed(2)} fps; run=${visual.runId}; filmstrip=${visual.artifacts.frames ?? "frames.png"}`,
            metadata,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
