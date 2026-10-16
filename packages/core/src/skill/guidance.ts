export * as SkillGuidance from "./guidance"

import { makeLocationNode } from "../effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { AgentV2 } from "../agent"
import { PermissionV2 } from "../permission"
import { SkillV2 } from "../skill"
import { SkillRevision } from "../skill/revision"
import { SystemContext } from "../system-context/index"

const Summary = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  origin: Schema.String,
  revision: Schema.String,
})
type Summary = typeof Summary.Type

const render = (skills: ReadonlyArray<Summary>) =>
  [
    "Skills provide specialized instructions and workflows for specific tasks.",
    "Use the skill tool to load a skill when a task matches its description.",
    ...(skills.length === 0
      ? ["No skills are currently available."]
      : [
          "<available_skills>",
          ...skills.flatMap((skill) => [
            "  <skill>",
            `    <name>${skill.name}</name>`,
            `    <description>${skill.description}</description>`,
            `    <origin>${skill.origin}</origin>`,
            `    <revision>${skill.revision}</revision>`,
            "  </skill>",
          ]),
          "</available_skills>",
        ]),
  ].join("\n")

export interface Interface {
  readonly load: (agent: AgentV2.Selection) => Effect.Effect<SystemContext.SystemContext>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SkillGuidance") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skills = yield* SkillV2.Service

    return Service.of({
      load: Effect.fn("SkillGuidance.load")(function* (selection) {
        const agent = selection.info
        if (!agent) return SystemContext.empty
        const permitted = (yield* skills.admitted()).filter((entry) => SkillV2.permitted(entry.info, agent))
        if (permitted.length === 0 && PermissionV2.evaluate("skill", "*", agent.permissions).effect === "deny")
          return SystemContext.empty
        const available = permitted
          // Semantic provenance only: which source published this skill and
          // which immutable revision was admitted. `info.location` stays
          // host-local — it is private filesystem topology, not prompt content.
          .flatMap((entry: SkillRevision.Admitted) =>
            entry.info.description === undefined
              ? []
              : [
                  {
                    name: entry.info.name,
                    description: entry.info.description,
                    origin: entry.revision.origin,
                    revision: SkillRevision.identity(entry.revision),
                  },
                ],
          )
          .toSorted((a, b) => a.name.localeCompare(b.name))
        return SystemContext.make({
          key: SystemContext.Key.make("core/skill-guidance"),
          load: Effect.succeed(available),
          render,
        })
      }),
    })
  }),
)

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: [SkillV2.node] })
