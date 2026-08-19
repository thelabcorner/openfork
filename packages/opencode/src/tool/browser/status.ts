import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import { BrokerClient } from "@/browser/broker-client"
import { DEFAULT_TIMEOUT_MS, FAMILY, OperationInput, formatOwner, permissionPattern } from "@/browser/shared"

export const Parameters = OperationInput.status

export const BrowserStatusTool = Tool.define(
  "browser_status",
  Effect.gen(function* () {
    const broker = yield* BrokerClient.Service
    return {
      description:
        "Check whether a Desktop browser is attached and report its live state: host connection (hostId/epoch), guest state (attached/crashed), active tab url/title/viewport, appearance, and recording status. Also returns the FULL tab list of the shared browser — every tab with its owner (user or agent(sessionId)), url, title, active and muted flags. Call this first to learn whether browser_open is needed, and after any BrowserHostUnavailable error to see if the host reconnected.",
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
          const tabs = result.tabs ?? []
          const tabLines =
            tabs.length === 0
              ? "(none)"
              : tabs
                  .map((tab) => {
                    const flags = [tab.active ? "active" : undefined, tab.muted ? "muted" : undefined]
                      .filter((flag): flag is string => flag !== undefined)
                      .join(",")
                    const mine = tab.owner.kind === "agent" && tab.owner.sessionId === ctx.sessionID ? " (mine)" : ""
                    return `${tab.tabId} ${tab.url} "${tab.title}"${flags ? ` [${flags}]` : ""} owner=${formatOwner(tab.owner)}${mine}`
                  })
                  .join("\n")
          return {
            title: "Browser status",
            output: `connected=${state.connected}; ${host}; ${guest}; appearance=${state.appearance}; ${recording}\ntabs (${tabs.length} total):\n${tabLines}`,
            metadata: { op: "status", requestId, elapsedMs, tabCount: tabs.length },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
