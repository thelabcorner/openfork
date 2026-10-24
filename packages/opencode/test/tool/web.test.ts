import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Effect, Exit, Layer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { Agent } from "@/agent/agent"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Plugin } from "@/plugin"
import { Truncate } from "@/tool/truncate"
import { WebTool } from "@/tool/web"
import { MessageID, SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const pluginLayer = Layer.succeed(
  Plugin.Service,
  Plugin.Service.of({
    init: () => Effect.void,
    list: () => Effect.succeed([]),
    trigger: ((_name: unknown, _input: unknown, output: unknown) => Effect.succeed(output)) as Plugin.Interface["trigger"],
    transformChatMessages: (messages) => Effect.succeed(messages),
  }),
)
const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(LayerNode.group([httpClient, Truncate.node, Agent.node, RuntimeFlags.node]), [
      [httpClient, FetchHttpClient.layer as Layer.Layer<HttpClient.HttpClient>],
      [RuntimeFlags.node, RuntimeFlags.layer()],
    ]),
    pluginLayer,
  ),
)
const ctx = {
  sessionID: SessionID.make("ses_web_ax"),
  messageID: MessageID.make("msg_web_ax"),
  callID: "call_web_ax",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

describe("tool.web github AX facade parity", () => {
  it.instance("facade routes known GitHub source before network/permission and preserves delegated metadata", () =>
    Effect.gen(function* () {
      const info = yield* WebTool
      const tool = yield* info.init()
      const result = yield* tool.execute({
        url: "https://raw.githubusercontent.com/storytold/vectorcraft/main/crates/geom/src/projective.rs",
      }, {
        ...ctx,
        ask: () => Effect.die(new Error("unexpected web permission: no network should be attempted")),
      })
      expect(result.metadata.action).toBe("fetch")
      expect(result.metadata.delegatedTool).toBe("webfetch")
      expect(result.metadata.contentFetched).toBe(false)
      expect(result.metadata.recommendedTool).toBe("github")
      expect(result.output).toContain('crates/geom/src/projective.rs')
      expect(result.output).toContain('tool({action:"describe",tool:"github"})')
    }),
  )

  it.instance("facade forwards forceWeb=true and reaches ordinary WebFetch permission", () =>
    Effect.gen(function* () {
      const info = yield* WebTool
      const tool = yield* info.init()
      let asks = 0
      const exit = yield* Effect.exit(tool.execute({
        action: "fetch",
        url: "https://raw.githubusercontent.com/storytold/vectorcraft/main/crates/geom/src/projective.rs",
        forceWeb: true,
      }, {
        ...ctx,
        ask: () => Effect.gen(function* () {
          asks++
          return yield* Effect.die(new Error("permission reached"))
        }),
      }))
      expect(asks).toBe(1)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
})
