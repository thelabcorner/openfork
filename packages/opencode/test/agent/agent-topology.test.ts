import { afterEach, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { Agent as AgentContract } from "@opencode-ai/schema/agent"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const layer = LayerNode.compile(
  LayerNode.group([Agent.node, Plugin.node, Provider.node, Auth.node, Config.node, Skill.node, RuntimeFlags.node]),
  [[RuntimeFlags.node, RuntimeFlags.layer({})]],
)

const it = testEffect(layer)

afterEach(async () => {
  await disposeAllInstances()
})

/**
 * The built-in agent topology is a single product-visible contract shared with
 * presentation. These tests fail if the runtime catalog and
 * `@opencode-ai/schema/agent` ever disagree, which is what keeps that contract a
 * source of truth instead of a second registry that silently drifts.
 */
it.instance("built-in catalog matches the shared agent contract topology", () =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service.use((svc) => svc.list())
    const builtIn = agents.filter((item) => item.native === true)
    expect(builtIn.map((item) => item.name).toSorted()).toEqual(
      AgentContract.BuiltInTopology.map((item) => item.id).toSorted(),
    )
    for (const item of builtIn) {
      const topology = AgentContract.builtIn(item.name)
      expect(topology, `missing contract entry for built-in ${item.name}`).toBeDefined()
      if (!topology) throw new Error(`missing contract entry for built-in ${item.name}`)
      expect(item.mode).toBe(topology.mode)
      expect(item.hidden === true).toBe(topology.hidden)
    }
  }),
)

it.instance("built-in modes split exactly into composer-only and delegation-only", () =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service.use((svc) => svc.list())
    for (const item of agents.filter((entry) => entry.native === true)) {
      const mode = item.mode ?? "all"
      const hidden = item.hidden === true
      const seen = AgentContract.exposure({ mode, hidden })
      // No shipped built-in may claim `all`: that would blur the line between a
      // generalist and a specialist, and both halves are separately owned.
      expect(mode, `built-in ${item.name} must not use mode "all"`).not.toBe("all")
      // `mode` is the delegation capability; `hidden` only removes a surface
      // from the two choosers. Both must follow the contract exactly.
      expect(seen.delegation, `built-in ${item.name} delegation`).toBe(mode !== "primary")
      expect(seen.composer, `built-in ${item.name} composer`).toBe(mode !== "subagent" && !hidden)
      expect(seen.mention, `built-in ${item.name} mentions`).toBe(mode !== "primary" && !hidden)
    }
  }),
)

it.instance("custom agents default to all and honor configured exposure", () =>
  Effect.gen(function* () {
    const byName = new Map(
      (yield* Agent.Service.use((svc) => svc.list())).map((item) => [item.name, item]),
    )
    expect(byName.get("studio-default")?.mode).toBe("all")
    expect(byName.get("studio-primary")?.mode).toBe("primary")
    expect(byName.get("studio-subagent")?.mode).toBe("subagent")
    expect(byName.get("studio-subagent")?.hidden).toBe(true)
  }),
  {
    config: {
      agent: {
        "studio-default": { description: "no mode override" },
        "studio-primary": { mode: "primary" },
        "studio-subagent": { mode: "subagent", hidden: true },
      },
    },
  },
)

it.instance("hidden removes chooser discoverability but never delegation capability", () =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service.use((svc) => svc.list())
    expect(agents.map((item) => item.name)).toContain("studio-subagent")
    const hidden = agents.find((item) => item.name === "studio-subagent")
    expect(
      AgentContract.exposure({ mode: hidden?.mode ?? "all", hidden: hidden?.hidden === true }),
    ).toEqual({
      composer: false,
      mention: false,
      // `hidden` is a chooser flag. A hidden subagent is undiscoverable but
      // still delegatable, because Task resolves the name against the catalog.
      delegation: true,
    })
    // A hidden primary agent stays non-delegatable: that gate is `mode`, not
    // discoverability.
    expect(AgentContract.exposure({ mode: "primary", hidden: true }).delegation).toBe(false)
  }),
  {
    config: {
      agent: {
        "studio-subagent": { mode: "subagent", hidden: true },
      },
    },
  },
)

it.instance("built-in agents keep contract mode when config overrides copy only", () =>
  Effect.gen(function* () {
    const explore = yield* Agent.Service.use((svc) => svc.get("explore"))
    expect(explore?.mode).toBe("subagent")
    expect(explore?.hidden).toBeFalsy()
    expect(explore?.description).toBe("Overridden explore copy.")
  }),
  {
    config: {
      agent: {
        explore: { description: "Overridden explore copy." },
      },
    },
  },
)

it.instance(
  "configured built-in exposure overrides its shipped default",
  () =>
    Effect.gen(function* () {
      const explore = yield* Agent.Service.use((svc) => svc.get("explore"))
      expect(explore?.mode).toBe("primary")
      expect(explore?.hidden).toBe(true)
      expect(
        AgentContract.exposure({ mode: explore?.mode ?? "all", hidden: explore?.hidden === true }),
      ).toEqual({ composer: false, mention: false, delegation: false })
    }),
  {
    config: {
      agent: {
        explore: { mode: "primary", hidden: true },
      },
    },
  },
)

it.instance("disabled agents leave the catalog entirely", () =>
  Effect.gen(function* () {
    const names = (yield* Agent.Service.use((svc) => svc.list())).map((item) => item.name)
    expect(names).not.toContain("studio-retired")
  }),
  {
    config: {
      agent: {
        "studio-retired": { mode: "all", disable: true },
      },
    },
  },
)
