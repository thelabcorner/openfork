import { afterEach, describe, expect } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { OxpRuntimeRefresh } from "@/oxp/runtime-refresh"
import { RuntimeRefreshTool } from "@/tool/runtime-refresh"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "@/session/schema"
import * as Tool from "@/tool/tool"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Truncate.node])))

const runtimeID = "sha256:" + "0".repeat(64)
const trialID = "trial-runtime-refresh"

afterEach(() => OxpRuntimeRefresh.install(undefined))

function context(asks: string[]): Tool.Context {
  return {
    sessionID: SessionID.make("ses_runtime_refresh"),
    messageID: MessageID.make("msg_runtime_refresh"),
    callID: "call_runtime_refresh",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: (request) =>
      Effect.sync(() => {
        asks.push(request.permission)
      }),
  }
}

describe("tool.runtime_refresh", () => {
  it.effect("fails closed without a host refresh controller", () =>
    Effect.gen(function* () {
      OxpRuntimeRefresh.install(undefined)
      const tool = yield* Tool.init(yield* RuntimeRefreshTool)
      const asks: string[] = []
      const result = yield* tool.execute({ action: "status" }, context(asks))
      expect(asks).toEqual(["runtime.refresh"])
      expect(result.metadata).toMatchObject({ action: "status", state: "stable" })
      expect(result.output).toContain("Transactional runtime refresh is unavailable")
    }),
  )

  it.effect("requires the observed runtime id, arms the staged trial, and resolves it", () =>
    Effect.gen(function* () {
      const armed: string[] = []
      const accepted: string[] = []
      OxpRuntimeRefresh.install({
        status: async (): Promise<OxpRuntimeRefresh.RuntimeStatus> => ({
          refreshable: true,
          state: "stable",
          runtimeID,
        }),
        refresh: async (input): Promise<OxpRuntimeRefresh.RuntimeMutationResult> => ({
          action: "refresh",
          changed: input.expectedRuntimeID === runtimeID,
          status: {
            refreshable: true,
            state: "scheduled",
            runtimeID,
            trial: {
              id: trialID,
              previousRuntimeID: runtimeID,
              candidateRuntimeID: runtimeID,
              phase: "scheduled",
            },
          },
        }),
        arm: async (id) => {
          armed.push(id)
        },
        accept: async (id): Promise<OxpRuntimeRefresh.RuntimeMutationResult> => {
          accepted.push(id)
          return { action: "accept", changed: true, status: { refreshable: true, state: "stable", runtimeID } }
        },
        rollback: async (): Promise<OxpRuntimeRefresh.RuntimeMutationResult> => ({
          action: "rollback",
          changed: true,
          status: { refreshable: true, state: "stable", runtimeID },
        }),
      })
      const tool = yield* Tool.init(yield* RuntimeRefreshTool)

      const missing = yield* tool.execute({ action: "refresh" }, context([])).pipe(Effect.exit)
      expect(Exit.isFailure(missing)).toBe(true)
      if (Exit.isFailure(missing)) expect(Cause.pretty(missing.cause)).toContain("expectedRuntimeID")

      const asks: string[] = []
      const result = yield* tool.execute({ action: "refresh", expectedRuntimeID: runtimeID }, context(asks))
      expect(asks).toEqual(["runtime.refresh"])
      expect(armed).toEqual([trialID])
      expect(result.metadata).toMatchObject({ action: "refresh", changed: true, state: "scheduled", trialID })

      const acceptedResult = yield* tool.execute({ action: "accept", trialID }, context([]))
      expect(accepted).toEqual([trialID])
      expect(acceptedResult.metadata).toMatchObject({ action: "accept", state: "stable" })
    }),
  )
})
