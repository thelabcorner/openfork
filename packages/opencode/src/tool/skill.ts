import path from "path"
import { Effect, Schema } from "effect"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Skill } from "../skill"
import * as Tool from "./tool"
import DESCRIPTION from "./skill.txt"

export const Parameters = Schema.Struct({
  name: Schema.optional(Schema.String).annotate({ description: "The name of the skill from available_skills" }),
  names: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Load several registered skills in one call",
  }),
  mode: Schema.optional(Schema.Literals(["load", "list", "search"])).annotate({
    description: "What to do (default: load by name)",
  }),
  query: Schema.optional(Schema.String).annotate({
    description: "search mode: substring filter across skill names and descriptions",
  }),
  tags: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Filter registered skills by tag keywords matched against name/description",
  }),
})

const renderSkill = (info: Skill.Info, files: string[], base: string) => {
  return [
    `<skill_content name="${info.name}">`,
    `# Skill: ${info.name}`,
    "",
    info.content.trim(),
    "",
    `Base directory for this skill: ${base}`,
    "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
    "Note: file list is sampled.",
    "",
    "<skill_files>",
    files.map((file) => `<file>${path.resolve(base, file)}</file>`).join("\n"),
    "</skill_files>",
    "</skill_content>",
  ].join("\n")
}

const describe = (info: Skill.Info) =>
  `- ${info.name}: ${info.description ?? "No description."}`

// mode is string-typed so generator returns don't widen against the union.
type Metadata = {
  mode: string
  name?: string
  names?: readonly string[]
  dir?: string
  count?: number
  missing?: string[]
}

const matchesTags = (info: Skill.Info, tags: readonly string[] | undefined) => {
  if (!tags?.length) return true
  const haystack = `${info.name} ${info.description ?? ""}`.toLowerCase()
  return tags.every((tag) => haystack.includes(tag.toLowerCase()))
}

export const SkillTool = Tool.define<typeof Parameters, Metadata, Skill.Service | Ripgrep.Service>(
  "skill",
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const ripgrep = yield* Ripgrep.Service

    const listFiles = Effect.fn("SkillTool.listFiles")(function* (dir: string, abort: AbortSignal) {
      return yield* ripgrep
        .find({
          cwd: dir,
          pattern: "!**/SKILL.md",
          hidden: true,
          follow: false,
          signal: abort,
          limit: 10,
        })
        .pipe(Effect.map((files) => files.map((file) => path.resolve(dir, file.path))))
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
    })

    const loadOne = Effect.fn("SkillTool.loadOne")(function* (name: string, ctx: Tool.Context) {
      const info = yield* skill.require(name).pipe(
        Effect.catchTag("Skill.NotFoundError", (error) => Effect.fail(new Error(error.message))),
      )
      yield* ctx.ask({
        permission: "skill",
        patterns: [name],
        always: [name],
        metadata: {},
      })
      const dir = path.dirname(info.location)
      const files = yield* listFiles(dir, ctx.abort)
      return { output: renderSkill(info, files, dir), dir }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const mode = params.mode ?? "load"

          if (mode === "list" || mode === "search") {
            const all = yield* skill.all()
            const query = params.query?.toLowerCase()
            const filtered = all.filter(
              (info) =>
                matchesTags(info, params.tags) &&
                (query === undefined ||
                  info.name.toLowerCase().includes(query) ||
                  (info.description ?? "").toLowerCase().includes(query)),
            )
            const list = filtered.toSorted((a, b) => a.name.localeCompare(b.name))
            return {
              title: `skills (${mode})`,
              output: [
                `<skills mode="${mode}" count="${list.length}">`,
                ...list.map((info) => `  ${describe(info)}`),
                "</skills>",
                list.length === 0 ? `No skills matched${query ? ` query "${params.query}"` : ""}${params.tags?.length ? ` tags ${params.tags.join(",")}` : ""}.` : "",
              ]
                .filter(Boolean)
                .join("\n"),
              metadata: {
                mode,
                count: list.length,
                names: list.map((info) => info.name),
              },
            }
          }

          if (params.names?.length) {
            const outputs: string[] = []
            const failed: string[] = []
            for (const name of params.names) {
              const next = yield* loadOne(name, ctx).pipe(
                Effect.catch((error: Error) => Effect.sync(() => failed.push(error.message))),
              )
              if (typeof next === "object") outputs.push(next.output)
            }
            if (outputs.length === 0 && failed.length > 0) {
              const all = yield* skill.all()
              return yield* Effect.fail(
                new Error(
                  `Skills not found:\n${failed.join("\n")}\n\nAvailable skills:\n${all
                    .filter((info) => matchesTags(info, params.tags))
                    .map((info) => describe(info))
                    .join("\n")}`,
                ),
              )
            }
            return {
              title: `Loaded ${outputs.length} skill${outputs.length === 1 ? "" : "s"}`,
              output: outputs.join("\n\n"),
              metadata: {
                mode: "load",
                names: params.names,
                missing: failed,
              },
            }
          }

          if (!params.name) {
            const all = yield* skill.all()
            return yield* Effect.fail(
              new Error(`No skill name provided.\nAvailable skills:\n${all.filter((info) => matchesTags(info, params.tags)).map((info) => describe(info)).join("\n")}`),
            )
          }

          // Single-name path unchanged (back-compat).
          const loaded = yield* loadOne(params.name, ctx)
          return {
            title: `Loaded skill: ${params.name}`,
            output: loaded.output,
            metadata: {
              mode: "load",
              name: params.name,
              dir: loaded.dir,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
