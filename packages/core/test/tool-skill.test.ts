import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillRevision } from "@opencode-ai/core/skill/revision"
import { SkillTool } from "@opencode-ai/core/tool/skill"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_skill_tool_test")
const encode = (value: string) => new TextEncoder().encode(value)

/**
 * Build the admission a real SkillV2 would have published for `info`. Using the
 * production digest helpers keeps the pinned revision honest: the tool
 * re-derives the package from disk and compares it against exactly this.
 */
const admit = (
  info: SkillV2.Info,
  origin: SkillRevision.Origin,
  resources: SkillRevision.Resource[],
): SkillRevision.Admitted => ({
  info,
  revision: SkillRevision.identify(origin, info.content, resources),
  directory: path.dirname(info.location),
})

describe("SkillTool", () => {
  it.live("lists available skills, authorizes the selected name, and loads model-facing content", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const directory = path.join(tmp.path, "effect")
          const location = path.join(directory, "SKILL.md")
          const reference = path.join(directory, "reference.md")
          yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
          yield* Effect.promise(() =>
            Promise.all([fs.writeFile(location, "unused"), fs.writeFile(reference, "reference")]),
          )

          const info: SkillV2.Info = {
            name: "effect",
            description: "Use Effect",
            location: AbsolutePath.make(location),
            content: "# Effect\n\nGuidance",
          }
          let current = [
            admit(info, "directory", [{ path: "reference.md", digest: SkillRevision.fileDigest(encode("reference")) }]),
          ]
          const assertions: PermissionV2.AssertInput[] = []
          const calls = { list: 0, refresh: 0 }
          let deny = false
          const permission = Layer.succeed(
            PermissionV2.Service,
            PermissionV2.Service.of({
              assert: (input) =>
                Effect.sync(() => assertions.push(input)).pipe(
                  Effect.andThen(deny ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void),
                ),
              ask: () => Effect.die("unused"),
              reply: () => Effect.die("unused"),
              get: () => Effect.die("unused"),
              forSession: () => Effect.die("unused"),
              list: () => Effect.die("unused"),
            }),
          )
          // Selection reads the admitted snapshot only. It must never discover or
          // re-admit, or the model could be served a revision other than the one
          // it was shown.
          const skills = Layer.succeed(
            SkillV2.Service,
            SkillV2.Service.of({
              transform: (_transform) => Effect.die("unused"),
              reload: () => Effect.die("unused"),
              sources: () => Effect.die("unused"),
              admitted: () => Effect.succeed(current),
              admit: (name: string) => Effect.succeed(current.find((entry) => entry.info.name === name)),
              list: () =>
                Effect.sync(() => {
                  calls.list++
                  return current.map((entry) => entry.info)
                }),
              refresh: () => Effect.sync(() => void calls.refresh++),
            }),
          )
          const skillToolLayer = AppNodeBuilder.build(
            LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, SkillTool.node]),
            [
              [PermissionV2.node, permission],
              [SkillV2.node, skills],
              [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
            ],
          )

          return yield* Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            expect((yield* toolDefinitions(registry))[0]).toMatchObject({
              name: "skill",
              description: SkillTool.description,
            })
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-skill", name: "skill", input: { name: "effect" } },
              }),
            ).toEqual({
              type: "text",
              value: SkillTool.toModelOutput(info, [reference]),
            })
            expect(SkillTool.toModelOutput(info, [reference])).toContain(`Base directory for this skill: ${directory}`)
            expect(
              yield* settleTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-skill-overflow", name: "skill", input: { name: "effect" } },
              }),
            ).toMatchObject({
              result: { type: "text", value: SkillTool.toModelOutput(info, [reference]) },
              output: { structured: { name: "effect" } },
            })
            expect(assertions).toMatchObject([
              { sessionID, action: "skill", resources: ["effect"], save: ["effect"] },
              { sessionID, action: "skill", resources: ["effect"], save: ["effect"] },
            ])
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-missing-skill", name: "skill", input: { name: "missing" } },
              }),
            ).toEqual({ type: "error", value: "Unable to load skill missing" })
            deny = true
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-denied-skill", name: "skill", input: { name: "effect" } },
              }),
            ).toEqual({ type: "error", value: "Unable to load skill effect" })
            deny = false
            const authorizedBeforeDrift = assertions.length
            // Same byte length, different bytes: the pinned package no longer
            // describes these bytes, so the load must fail closed instead of
            // mixing admitted instructions with replaced resources.
            yield* Effect.promise(() => fs.writeFile(reference, "referencf"))
            const drifted = yield* executeTool(registry, {
              sessionID,
              ...toolIdentity,
              call: { type: "tool-call", id: "call-drifted-skill", name: "skill", input: { name: "effect" } },
            })
            expect(drifted.type).toBe("error")
            expect(drifted.value).toContain("no longer matches the revision it was admitted at")
            // It must not fall back to refreshing into a different revision, and
            // it must tell the model how to recover.
            expect(drifted.value).toContain("Load the skill again")
            expect(drifted.value).not.toContain(directory)
            // A drifted selection is never authorized.
            expect(assertions).toHaveLength(authorizedBeforeDrift)

            const flat = SkillV2.Info.make({
              name: "public",
              description: "Public guidance",
              location: AbsolutePath.make(path.join(tmp.path, "public.md")),
              content: "Public",
            })
            yield* Effect.promise(() =>
              Promise.all([
                fs.writeFile(flat.location, "public"),
                fs.writeFile(path.join(tmp.path, "secret.md"), "secret"),
              ]),
            )
            current = [admit(flat, "directory", [])]
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-flat-skill", name: "skill", input: { name: "public" } },
              }),
            ).toEqual({ type: "text", value: SkillTool.toModelOutput(flat, []) })

            // Selection performed no discovery and no refresh at any point.
            expect(calls).toEqual({ list: 0, refresh: 0 })
          }).pipe(Effect.provide(skillToolLayer))
        }),
      ),
    ),
  )
})