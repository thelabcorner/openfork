import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillRevision } from "@opencode-ai/core/skill/revision"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemSurface } from "@opencode-ai/core/system-surface"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { it } from "../lib/effect"
import { observeReady, renderReady } from "../lib/system-context"

const build = AgentV2.ID.make("build")

const admit = (input: {
  name: string
  description?: string
  location: string
  content: string
  origin?: SkillRevision.Origin
  resources?: SkillRevision.Resource[]
}): SkillRevision.Admitted => ({
  info: SkillV2.Info.make({
    name: input.name,
    description: input.description,
    location: AbsolutePath.make(input.location),
    content: input.content,
  }),
  revision: SkillRevision.identify(input.origin ?? "directory", input.content, input.resources ?? []),
  directory: path.dirname(input.location),
})

const effect = admit({
  name: "effect",
  description: "Build applications with Effect",
  location: path.resolve("/skills/effect/SKILL.md"),
  content: "Effect guidance",
})
const hidden = admit({
  name: "hidden",
  location: path.resolve("/skills/hidden/SKILL.md"),
  content: "Undescribed guidance",
})
const denied = admit({
  name: "denied",
  description: "Must not be advertised",
  location: path.resolve("/skills/denied/SKILL.md"),
  content: "Denied guidance",
})
const remote = admit({
  name: "deploy",
  description: "Deploy production",
  location: path.resolve("/cache/skills/deadbeef/deploy/SKILL.md"),
  content: "Deploy guidance",
  origin: "remote",
  resources: [{ path: "reference.md", digest: SkillRevision.fileDigest(new TextEncoder().encode("notes")) }],
})

/**
 * The mock models the admitted snapshot rather than the discovery list, because
 * production guidance reads `admitted()`. `list`/`refresh` are counted so a test
 * can prove prompt projection never reaches them.
 */
const layer = (entries: () => SkillRevision.Admitted[], counters?: { list: number; refresh: number }) =>
  AppNodeBuilder.build(SkillGuidance.node, [
    [
      SkillV2.node,
      Layer.mock(SkillV2.Service, {
        admitted: () => Effect.succeed(entries()),
        admit: (name: string) => Effect.succeed(entries().find((entry) => entry.info.name === name)),
        list: () =>
          Effect.sync(() => {
            if (counters) counters.list++
            return []
          }),
        refresh: () =>
          Effect.sync(() => {
            if (counters) counters.refresh++
          }),
      }),
    ],
  ])

describe("SkillGuidance", () => {
  it.effect("renders described agent skills and reconciles the complete available list", () => {
    const agent = AgentV2.Info.make({
      ...AgentV2.Info.empty(build),
      permissions: [{ action: "skill", resource: "denied", effect: "deny" }],
    })
    let entries = [hidden, denied, effect]
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
          "    <origin>directory</origin>",
          `    <revision>${SkillRevision.identity(effect.revision)}</revision>`,
          "  </skill>",
          "</available_skills>",
        ].join("\n"),
      )

      entries = []
      const refreshed = yield* observeReady(yield* guidance.load({ id: agent.id, info: agent }), initialized.snapshot)
      expect(SystemSurface.render(refreshed.snapshot)).toContain("No skills are currently available.")
      expect(refreshed.surfaceChanged).toBe(true)
    }).pipe(Effect.provide(layer(() => entries)))
  })

  it.effect("projects semantic provenance without leaking local skill locations", () => {
    const agent = AgentV2.Info.make(AgentV2.Info.empty(build))
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      const rendered = yield* renderReady(yield* guidance.load({ id: agent.id, info: agent }))

      expect(rendered).toContain("<origin>remote</origin>")
      expect(rendered).toContain(`<revision>${SkillRevision.identity(remote.revision)}</revision>`)
      // Private local filesystem topology stays host-local.
      expect(rendered).not.toContain("/cache/skills")
      expect(rendered).not.toContain("/skills/deploy")
      expect(rendered).not.toContain("SKILL.md")
    }).pipe(Effect.provide(layer(() => [remote])))
  })

  it.effect("never lists or refreshes while projecting prompt guidance", () => {
    const agent = AgentV2.Info.make(AgentV2.Info.empty(build))
    const counters = { list: 0, refresh: 0 }
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      yield* renderReady(yield* guidance.load({ id: agent.id, info: agent }))
      yield* renderReady(yield* guidance.load({ id: agent.id, info: agent }))
      expect(counters).toEqual({ list: 0, refresh: 0 })
    }).pipe(Effect.provide(layer(() => [effect, remote], counters)))
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