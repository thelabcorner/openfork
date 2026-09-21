import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemSurface } from "@opencode-ai/core/system-surface"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { it } from "../lib/effect"
import { observeReady, renderReady } from "../lib/system-context"

const build = AgentV2.ID.make("build")
const effect = SkillV2.Info.make({
  name: "effect",
  description: "Build applications with Effect",
  location: AbsolutePath.make(path.resolve("/skills/effect/SKILL.md")),
  content: "Effect guidance",
})
const hidden = SkillV2.Info.make({
  name: "hidden",
  location: AbsolutePath.make(path.resolve("/skills/hidden/SKILL.md")),
  content: "Undescribed guidance",
})
const denied = SkillV2.Info.make({
  name: "denied",
  description: "Must not be advertised",
  location: AbsolutePath.make(path.resolve("/skills/denied/SKILL.md")),
  content: "Denied guidance",
})

const layer = (list: () => SkillV2.Info[]) =>
  AppNodeBuilder.build(SkillGuidance.node, [
    [SkillV2.node, Layer.mock(SkillV2.Service, { list: () => Effect.succeed(list()) })],
  ])

describe("SkillGuidance", () => {
  it.effect("renders described agent skills and reconciles the complete available list", () => {
    const agent = AgentV2.Info.make({
      ...AgentV2.Info.empty(build),
      permissions: [{ action: "skill", resource: "denied", effect: "deny" }],
    })
    let skills = [hidden, denied, effect]
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      const initialized = yield* observeReady(yield* guidance.load({ id: agent.id, info: agent }))

      expect(SystemSurface.render(initialized.snapshot)).toBe(
        [
          "Skills provide specialized instructions and workflows for specific tasks.",
          "Use the skill tool to load a skill when a task matches its description.",
          "<available_skills>",
          "  <skill>",
          "    <name>effect</name>",
          "    <description>Build applications with Effect</description>",
          "  </skill>",
          "</available_skills>",
        ].join("\n"),
      )

      skills = []
      const refreshed = yield* observeReady(yield* guidance.load({ id: agent.id, info: agent }), initialized.snapshot)
      expect(SystemSurface.render(refreshed.snapshot)).toContain("No skills are currently available.")
      expect(refreshed.surfaceChanged).toBe(true)
    }).pipe(Effect.provide(layer(() => skills)))
  })

  it.effect("omits guidance when the selected agent denies all skills", () => {
    const agent = AgentV2.Info.make({
      ...AgentV2.Info.empty(build),
      permissions: [{ action: "skill", resource: "*", effect: "deny" }],
    })
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      expect(yield* renderReady(yield* guidance.load({ id: agent.id, info: agent }))).toBe("")
    }).pipe(Effect.provide(layer(() => [effect])))
  })

  it.effect("omits guidance when a resource-specific denial follows the global denial", () => {
    const agent = AgentV2.Info.make({
      ...AgentV2.Info.empty(build),
      permissions: [
        { action: "skill", resource: "*", effect: "deny" },
        { action: "skill", resource: "hidden", effect: "deny" },
      ],
    })
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      expect(yield* renderReady(yield* guidance.load({ id: agent.id, info: agent }))).toBe("")
    }).pipe(Effect.provide(layer(() => [effect])))
  })

  it.effect("retains specifically allowed skills after a global denial", () => {
    const agent = AgentV2.Info.make({
      ...AgentV2.Info.empty(build),
      permissions: [
        { action: "skill", resource: "*", effect: "deny" },
        { action: "skill", resource: "effect", effect: "allow" },
      ],
    })
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      expect(yield* renderReady(yield* guidance.load({ id: agent.id, info: agent }))).toContain("<name>effect</name>")
    }).pipe(Effect.provide(layer(() => [effect])))
  })

  it.effect("omits guidance when a specifically allowed skill is denied again", () => {
    const agent = AgentV2.Info.make({
      ...AgentV2.Info.empty(build),
      permissions: [
        { action: "skill", resource: "*", effect: "deny" },
        { action: "skill", resource: "effect", effect: "allow" },
        { action: "skill", resource: "effect", effect: "deny" },
      ],
    })
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      expect(yield* renderReady(yield* guidance.load({ id: agent.id, info: agent }))).toBe("")
    }).pipe(Effect.provide(layer(() => [effect])))
  })
})
