import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import { BrokerClient } from "@/browser/broker-client"
import { DEFAULT_TIMEOUT_MS, FAMILY, OperationInput, permissionPattern } from "@/browser/shared"

export const Parameters = OperationInput.visual_artifact

type VisualArtifactMetadata = {
  [key: string]: unknown
  op: "visual_artifact"
  requestId: string
  elapsedMs: number
  artifact: unknown
}

export const BrowserVisualArtifactTool = Tool.define(
  "browser_visual_artifact",
  Effect.gen(function* () {
    const broker = yield* BrokerClient.Service
    return {
      description:
        "Resolve one SnapEye baseline/run artifact to a bounded project-relative descriptor. Use visual_history first when the run/name is unknown. The result contains path, MIME type, and byte length only; use the normal project/file inspection path when the actual image, SVG, JSON, GIF, or video must be opened.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: FAMILY.visual_artifact,
            patterns: [permissionPattern("visual_artifact")],
            always: ["*"],
            metadata: { tool: "browser_visual_artifact", source: params.source, ...("name" in params ? { name: params.name } : { runId: params.runId }), artifact: params.artifact },
          })
          const { result, requestId, elapsedMs } = yield* broker.run({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            toolCallID: ctx.callID,
            operation: "visual_artifact",
            input: params,
            timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS.visual_artifact,
            abort: ctx.abort,
          })
          const artifact = result.artifact
          const metadata: VisualArtifactMetadata = { op: "visual_artifact", requestId, elapsedMs, artifact }
          if (!artifact) {
            return {
              title: "Visual artifact not found",
              output: "The requested SnapEye artifact does not exist in the current project's .snapeye store.",
              metadata,
            }
          }
          return {
            title: `Visual artifact: ${artifact.kind}`,
            output: `${artifact.kind}: ${artifact.path} (${artifact.mime}, ${artifact.byteLength} bytes)`,
            metadata,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
