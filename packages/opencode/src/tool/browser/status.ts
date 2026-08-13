import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import { BrokerClient } from "@/browser/broker-client"
import { DEFAULT_TIMEOUT_MS, FAMILY, OperationInput, permissionPattern } from "@/browser/shared"

export const Parameters = OperationInput.status

export const BrowserStatusTool = Tool.define(
  "browser_status",
  Effect.gen(function* () {
    const broker = yield* BrokerClient.Service
    return {
      description:
        "Check whether a Desktop browser is attached to this session and report its live state: host connection (hostId/epoch), guest state (attached/crashed), active tab url/title/viewport, appearance, and recording status. Call this first to learn whether browser_open is needed, and after any BrowserHostUnavailable error to see if the host reconnected.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: FAMILY.status,
            patterns: [permissionPattern("status")],
            always: ["*"],
            metadata: { tool: "browser_status", tabId: params.tabId },
          })
          const { result, requestId, elapsedMs } = yield* broker.run({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            toolCallID: ctx.callID,
            tabId: params.tabId,
            operation: "status",
            input: params,
            timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS.status,
            abort: ctx.abort,
          })
          const state = result.status
          const host = state.host ? `host ${state.host.hostId} (v${state.host.protocolVersion}, epoch ${state.host.hostEpoch})` : "no host"
          const guest = state.guest
            ? state.guest.activeTab
              ? `guest attached (${state.guest.state}): ${state.guest.activeTab.url} "${state.guest.activeTab.title}" [${state.guest.activeTab.readyState}] viewport ${state.guest.activeTab.viewport.width}x${state.guest.activeTab.viewport.height}`
              : `guest ${state.guest.state}, no active tab`
            : "no guest"
          const recording = state.recording.active ? `recording ${state.recording.recordingId ?? ""}`.trim() : "not recording"
          return {
            title: "Browser status",
            output: `connected=${state.connected}; ${host}; ${guest}; appearance=${state.appearance}; ${recording}`,
            metadata: { op: "status", requestId, elapsedMs },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
