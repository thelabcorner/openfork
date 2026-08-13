import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import { BrokerClient } from "@/browser/broker-client"
import { DEFAULT_TIMEOUT_MS, FAMILY, OperationInput, permissionPattern } from "@/browser/shared"

export const Parameters = OperationInput.recording_start

export const BrowserRecordingStartTool = Tool.define(
  "browser_recording_start",
  Effect.gen(function* () {
    const broker = yield* BrokerClient.Service
    return {
      description:
        "Start recording the visible browser guest (format: webm video or gif). Bounded by maxDurationMs/maxBytes. Returns a recordingId to pass to browser_recording_stop. The host must support recording (capability supportsRecording); otherwise BrowserUnsupportedOperation.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: FAMILY.recording_start,
            patterns: [permissionPattern("recording_start")],
            always: ["*"],
            metadata: { tool: "browser_recording_start", format: params.format, includeAudio: params.includeAudio },
          })
          const { result, requestId, elapsedMs } = yield* broker.run({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            toolCallID: ctx.callID,
            operation: "recording_start",
            input: params,
            timeoutMs: DEFAULT_TIMEOUT_MS.recording_start,
            abort: ctx.abort,
          })
          const recording = result.recording
          return {
            title: "Started browser recording",
            output: `recording ${recording.recordingId} (${recording.format}) on tab ${recording.tabId} since ${new Date(recording.startedAt).toISOString()}`,
            metadata: { op: "recording_start", requestId, elapsedMs, recordingId: recording.recordingId },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
