import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import * as AgentCatalog from "@opencode-ai/core/agent/catalog"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { testEffect } from "./lib/effect"

const directory = process.cwd()
const decoded = Schema.decodeUnknownSync(Config.Info)({
  default_agent: "reviewer",
  agents: {
    reviewer: {
      description: "Reviews code",
      mode: "primary",
      system: "Review carefully.",
      request: { body: { temperature: 0.2 } },
    },
  },
})
const config = Config.Service.of({
  entries: () =>
    Effect.succeed([
      new Config.Document({
        type: "document",
        path: `${directory}/openfork.jsonc`,
        info: decoded,
      }),
    ]),
})
const ref = Location.Ref.make({ directory: AbsolutePath.make(directory) })
const location = Location.Service.of({
  directory: ref.directory,
  project: { id: "global" as never, directory: ref.directory },
})
const layer = AppNodeBuilder.build(AgentCatalog.node, [
  [Config.node, Layer.succeed(Config.Service, config)],
  [Location.node, Layer.succeed(Location.Service, location)],
])
const it = testEffect(layer)

describe("AgentCatalog", () => {
  it.effect("projects configured and built-in agents without runtime plugin services", () =>
    Effect.gen(function* () {
      const agents = yield* AgentCatalog.Service.use((service) => service.list())
      const reviewer = agents.find((agent) => agent.id === AgentV2.ID.make("reviewer"))
      const build = agents.find((agent) => agent.id === AgentV2.ID.make("build"))

      expect(reviewer).toMatchObject({
        description: "Reviews code",
        mode: "primary",
        system: "Review carefully.",
        request: { body: { temperature: 0.2 } },
      })
      expect(build).toMatchObject({ mode: "primary" })
      expect(agents.some((agent) => agent.id === AgentV2.ID.make("explore"))).toBe(true)
    }),
  )
})
