import { expect, test } from "bun:test"
import { ConfigPlugin } from "@/config/plugin"
import { ConfigPluginV1 } from "@opencode-ai/core/v1/config/plugin"

test("external plugins remain session-critical unless the host lane is explicitly selected", () => {
  const legacy = ["legacy-plugin", { apiKey: "secret" }] satisfies ConfigPluginV1.Spec
  expect(ConfigPlugin.pluginStartupLane(legacy)).toBe("session")
  expect(ConfigPlugin.pluginOptions(legacy)).toEqual({ apiKey: "secret" })

  const background = [
    "observer-plugin",
    { $openfork: { startup: "background-events" }, endpoint: "https://example.test" },
  ] satisfies ConfigPluginV1.Spec
  expect(ConfigPlugin.pluginStartupLane(background)).toBe("background-events")
  expect(ConfigPlugin.pluginOptions(background)).toEqual({ endpoint: "https://example.test" })
  expect(background[1]).toHaveProperty("$openfork.startup", "background-events")
})

test("unknown host lane metadata fails closed to session-critical loading", () => {
  const plugin = ["plugin", { $openfork: { startup: "later" }, option: true }] satisfies ConfigPluginV1.Spec
  expect(ConfigPlugin.pluginStartupLane(plugin)).toBe("session")
  expect(ConfigPlugin.pluginOptions(plugin)).toEqual({ option: true })
})
