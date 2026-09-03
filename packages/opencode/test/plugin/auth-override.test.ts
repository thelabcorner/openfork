import { describe, expect, test } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Deferred, Effect } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EventV2 } from "@opencode-ai/core/event"
import { Integration } from "@opencode-ai/core/integration"
import { provideInstance, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { ProviderAuth } from "@/provider/auth"

import { RuntimeFlags } from "@/effect/runtime-flags"
import { TestConfig } from "../fixture/config"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Config } from "@/config/config"

const it = testEffect(LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node, FSUtil.node])))

function providerAuthLayer(directory: string, plugins: string[]) {
  return LayerNode.compile(LayerNode.group([ProviderAuth.node, EventV2.node]), [
    [
      Config.node,
      TestConfig.layer({
        get: () =>
          Effect.succeed({
            plugin: plugins,
            plugin_origins: plugins.map((plugin) => ({
              spec: plugin,
              source: path.join(directory, "opencode.json"),
              scope: "local" as const,
            })),
          }),
        directories: () => Effect.succeed([directory]),
      }),
    ],
    [RuntimeFlags.node, RuntimeFlags.layer()],
  ])
}

describe("plugin.auth-override", () => {
  it.instance(
    "user plugin overrides built-in github-copilot auth",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const fs = yield* FSUtil.Service
        const pluginDir = path.join(tmp.directory, ".opencode", "plugin")

        yield* fs.writeWithDirs(
          path.join(pluginDir, "custom-copilot-auth.ts"),
          [
            "export default {",
            '  id: "demo.custom-copilot-auth",',
            "  server: async () => ({",
            "    auth: {",
            '      provider: "github-copilot",',
            "      methods: [",
            '        { type: "api", label: "Test Override Auth" },',
            "      ],",
            "      loader: async () => ({ access: 'test-token' }),",
            "    },",
            "  }),",
            "}",
            "",
          ].join("\n"),
        )

        const plain = yield* tmpdirScoped({ git: true })
        const plugin = pathToFileURL(path.join(pluginDir, "custom-copilot-auth.ts")).href
        const methods = yield* ProviderAuth.use
          .methods()
          .pipe(Effect.provide(providerAuthLayer(tmp.directory, [plugin])))
        const plainMethods = yield* ProviderAuth.use
          .methods()
          .pipe(Effect.provide(providerAuthLayer(plain, [])), provideInstance(plain))

        const copilot = methods[ProviderV2.ID.make("github-copilot")]
        expect(copilot).toBeDefined()
        expect(copilot.length).toBe(1)
        expect(copilot[0].label).toBe("Test Override Auth")
        expect(plainMethods[ProviderV2.ID.make("github-copilot")][0].label).not.toBe("Test Override Auth")
      }),
    { git: true },
    30000,
  )

  it.instance(
    "publishes a connection update after provider auth succeeds",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const fs = yield* FSUtil.Service
        const pluginDir = path.join(tmp.directory, ".opencode", "plugin")
        const plugin = pathToFileURL(path.join(pluginDir, "provider-oauth.ts")).href
        const providerID = ProviderV2.ID.make("provider-oauth")

        yield* fs.writeWithDirs(
          path.join(pluginDir, "provider-oauth.ts"),
          [
            "export default {",
            '  id: "demo.provider-oauth",',
            "  server: async () => ({",
            "    auth: {",
            '      provider: "provider-oauth",',
            "      methods: [{",
            '        type: "oauth", label: "Test OAuth",',
            '        async authorize() { return { url: "", instructions: "", method: "auto", callback: async () => ({ type: "success", key: "test-key" }) } },',
            "      }],",
            "    },",
            "  }),",
            "}",
            "",
          ].join("\n"),
        )

        const update = yield* Effect.gen(function* () {
          const events = yield* EventV2.Service
          type ConnectionUpdatedData = typeof Integration.Event.ConnectionUpdated.data.Type
          const received = yield* Deferred.make<ConnectionUpdatedData>()
          const unsubscribe = yield* events.listen((event) => {
            if (event.type !== Integration.Event.ConnectionUpdated.type) return Effect.void
            const data = event.data as ConnectionUpdatedData
            if (data.integrationID !== Integration.ID.make(providerID)) return Effect.void
            return Deferred.succeed(received, data).pipe(Effect.asVoid)
          })
          yield* Effect.addFinalizer(() => unsubscribe)

          const auth = yield* ProviderAuth.Service
          yield* auth.authorize({ providerID, method: 0 })
          yield* auth.callback({ providerID, method: 0 })
          return yield* awaitWithTimeout(Deferred.await(received), "provider auth event was not published")
        }).pipe(Effect.provide(providerAuthLayer(tmp.directory, [plugin])))

        expect(update.integrationID).toBe(Integration.ID.make("provider-oauth"))
      }),
    { git: true },
  )
})

const file = path.join(import.meta.dir, "../../src/plugin/index.ts")

describe("plugin.config-hook-error-isolation", () => {
  test("config hooks are individually error-isolated in the layer factory", async () => {
    const src = await Bun.file(file).text()

    // Each hook's config call is wrapped in Effect.tryPromise with error logging + Effect.ignore
    expect(src).toContain("plugin config hook failed")

    const pattern =
      /for\s*\(const hook of hooks\)\s*\{[\s\S]*?Effect\.tryPromise[\s\S]*?\.config\?\.\([\s\S]*?plugin config hook failed[\s\S]*?Effect\.ignore/
    expect(pattern.test(src)).toBe(true)
  })
})
