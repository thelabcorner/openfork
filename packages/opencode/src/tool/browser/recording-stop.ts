import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import { BrokerClient } from "@/browser/broker-client"
import { DEFAULT_TIMEOUT_MS, FAMILY, OperationInput, permissionPattern } from "@/browser/shared"

export const Parameters = OperationInput.recording_stop

export const BrowserRecordingStopTool = Tool.define(
  "browser_recording_stop",
  Effect.gen(function* () {
    const broker = yield* BrokerClient.Service
    return {
      description:
        "Stop an active browser recording (omit recordingId to stop the current one). Returns the recording file artifact (mime video/webm or image/gif) attached to the result so the model can reference it. Call browser_recording_start first.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: FAMILY.recording_stop,
            patterns: [permissionPattern("recording_stop")],
            always: ["*"],
            metadata: { tool: "browser_recording_stop", recordingId: params.recordingId },
          })
          const { result, requestId, elapsedMs } = yield* broker.run({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            toolCallID: ctx.callID,
            operation: "recording_stop",
            input: params,
            timeoutMs: DEFAULT_TIMEOUT_MS.recording_stop,
            abort: ctx.abort,
          })
          const recording = result.recording
          return {
            title: "Stopped browser recording",
            output: `recording ${recording.recordingId} stopped at ${new Date(recording.stoppedAt).toISOString()}: ${recording.durationMs}ms, ${recording.sizeBytes} bytes, artifact ${recording.artifact.mime} at ${recording.artifact.url}`,
            metadata: { op: "recording_stop", requestId, elapsedMs, recordingId: recording.recordingId, sizeBytes: recording.sizeBytes },
            attachments: [
              {
                type: "file" as const,
                mime: recording.artifact.mime,
                url: recording.artifact.url,
              },
            ],
          }
        }).pipe(Effect.orDie),
    }
  }),
)
