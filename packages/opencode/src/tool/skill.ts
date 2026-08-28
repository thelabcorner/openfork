import path from "path"
import os from "node:os"
import fs from "node:fs/promises"
import { Effect, Schema } from "effect"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Skill } from "../skill"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import * as Tool from "./tool"
import DESCRIPTION from "./skill.txt"

export const Parameters = Schema.Struct({
  name: Schema.optional(Schema.String).annotate({
    description:
      "Skill name from available_skills, OR a filesystem path to a SKILL.md / skill folder (Downloads, another repo, absolute or ~ paths).",
  }),
  names: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Load several skills in one call. Each entry may be a registered name or a filesystem path.",
  }),
  filePath: Schema.optional(Schema.String).annotate({
    description:
      "Load a skill that is not in this project's skill folders. File or directory (SKILL.md is resolved inside directories). Absolute, ~, or relative to the working directory.",
  }),
  mode: Schema.optional(Schema.Literals(["load", "list", "search"])).annotate({
    description: "What to do (default: load by name or filePath)",
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

const describe = (info: Skill.Info) => `- ${info.name}: ${info.description ?? "No description."}`

type Metadata = {
  mode: string
  name?: string
  names?: readonly string[]
  dir?: string
  count?: number
  missing?: string[]
  source?: string
}

const matchesTags = (info: Skill.Info, tags: readonly string[] | undefined) => {
  if (!tags?.length) return true
  const haystack = `${info.name} ${info.description ?? ""}`.toLowerCase()
  return tags.every((tag) => haystack.includes(tag.toLowerCase()))
}

const normalizeLike = (a: string, b: string) =>
  a.toLowerCase().replace(/[^a-z0-9]/g, "") === b.toLowerCase().replace(/[^a-z0-9]/g, "") ||
  a.toLowerCase().includes(b.toLowerCase()) ||
  b.toLowerCase().includes(a.toLowerCase())

const looksLikePath = (value: string) => {
  const s = value.trim()
  if (!s) return false
  if (s.startsWith("~")) return true
  if (s.startsWith("/") || s.startsWith("\\")) return true
  if (/^[A-Za-z]:[\\/]/.test(s)) return true
  if (s.includes("/") || s.includes("\\")) return true
  if (/\.(md|markdown)$/i.test(s)) return true
  return false
}

const stripQuotes = (value: string) => value.trim().replace(/^['"]|['"]$/g, "")

const resolveUserPath = (raw: string, directory: string, home: string) => {
  let next = stripQuotes(raw)
  if (next === "~") next = home
  else if (next.startsWith("~/") || next.startsWith("~\\")) next = path.join(home, next.slice(2))
  if (!path.isAbsolute(next)) next = path.join(directory, next)
  return process.platform === "win32" ? FSUtil.normalizePath(next) : next
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

    const finish = Effect.fn("SkillTool.finish")(function* (info: Skill.Info, ctx: Tool.Context, source: string) {
      yield* ctx.ask({
        permission: "skill",
        patterns: [info.name],
        always: [info.name],
        metadata: { source, location: info.location },
      })
      const dir = path.dirname(info.location)
      const files = info.location === "<built-in>" ? [] : yield* listFiles(dir, ctx.abort)
      return { output: renderSkill(info, files, dir), dir, name: info.name, source }
    })

    const loadFromFilesystem = Effect.fn("SkillTool.loadFromFilesystem")(function* (
      abs: string,
      ctx: Tool.Context,
      instance: { directory: string; worktree: string },
    ) {
      const stat = yield* Effect.tryPromise(() => fs.stat(abs)).pipe(Effect.catch(() => Effect.succeed(undefined)))
      const kind = stat?.isDirectory() ? "directory" : "file"
      yield* assertExternalDirectoryEffect(ctx, abs, { kind })
      const rel = path.relative(instance.worktree, abs)
      yield* ctx.ask({
        permission: "read",
        patterns: [rel],
        always: [rel],
        metadata: { filepath: abs },
      })
      const info = yield* skill.loadFromPath(abs)
      return yield* finish(info, ctx, "path")
    })

    const loadOne = Effect.fn("SkillTool.loadOne")(function* (raw: string, ctx: Tool.Context) {
      const instance = yield* InstanceState.context
      const trimmed = stripQuotes(raw)
      if (!trimmed) {
        return yield* new Skill.NotFoundError({ name: raw, available: (yield* skill.all()).map((s) => s.name) })
      }

      if (looksLikePath(trimmed)) {
        const abs = resolveUserPath(trimmed, instance.directory, os.homedir())
        return yield* loadFromFilesystem(abs, ctx, instance)
      }

      const registered = yield* skill.get(trimmed)
      if (registered) return yield* finish(registered, ctx, "registry")

      const missing = yield* skill.require(trimmed)
      return yield* finish(missing, ctx, "registry")
    })

    const missOutput = (label: string, extra: string, all: Skill.Info[], tags?: readonly string[]) => {
      const suggestions =
        all
          .filter((info) => normalizeLike(info.name, label) || matchesTags(info, tags))
          .slice(0, 16)
          .map(describe)
          .join("\n") || all.slice(0, 12).map(describe).join("\n")
      return [
        extra,
        "",
        "Available skills (project folders + previously imported paths):",
        suggestions || "(none)",
        "",
        'Use skill({ mode: "list" }) to list all.',
        'Use skill({ filePath: "C:/Users/.../Downloads/my-skill" }) or skill({ name: "~/Downloads/my-skill/SKILL.md" }) to load a skill from anywhere on disk.',
      ]
        .filter(Boolean)
        .join("\n")
    }

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
                list.length === 0
                  ? `No skills matched${query ? ` query "${params.query}"` : ""}${params.tags?.length ? ` tags ${params.tags.join(",")}` : ""}.`
                  : "",
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

          const targets = [
            ...(params.filePath ? [params.filePath] : []),
            ...(params.names ?? []),
            ...(params.name && !params.filePath ? [params.name] : []),
          ]

          if (targets.length > 1 || params.names?.length) {
            const outputs: string[] = []
            const failed: string[] = []
            const loadedNames: string[] = []
            for (const target of targets) {
              const next = yield* loadOne(target, ctx).pipe(
                Effect.catch((error) =>
                  Effect.succeed({
                    failed: error instanceof Error ? error.message : String(error),
                  }),
                ),
              )
              if ("failed" in next) failed.push(next.failed)
              else {
                outputs.push(next.output)
                loadedNames.push(next.name)
              }
            }
            if (outputs.length === 0) {
              const all = yield* skill.all()
              return {
                title: "No skills loaded",
                output: missOutput(targets[0] ?? "", `Skills not found:\n${failed.join("\n")}`, all, params.tags),
                metadata: { mode: "load", names: targets, missing: failed, count: all.length },
              }
            }
            return {
              title: `Loaded ${outputs.length} skill${outputs.length === 1 ? "" : "s"}`,
              output: outputs.join("\n\n"),
              metadata: {
                mode: "load",
                names: loadedNames,
                missing: failed,
              },
            }
          }

          if (targets.length === 0) {
            const all = yield* skill.all()
            const avail = all.filter((info) => matchesTags(info, params.tags)).map(describe).join("\n")
            return {
              title: "No skill name provided",
              output: `No skill name or filePath provided.\n\nAvailable skills:\n${avail || "(none)"}\n\nUse mode:"list", a registered name, or filePath to a SKILL.md / skill folder anywhere on disk.`,
              metadata: { mode: "load", count: all.length },
            }
          }

          const loaded = yield* loadOne(targets[0], ctx).pipe(
            Effect.catchTag("Skill.NotFoundError", (error) =>
              Effect.gen(function* () {
                const all = yield* skill.all()
                return {
                  title: `Skill not found: ${targets[0]}`,
                  output: missOutput(targets[0], error.message, all, params.tags),
                  metadata: { mode: "load", name: targets[0], count: all.length },
                } as const
              }),
            ),
            Effect.catchTag("SkillInvalidError", (error) =>
              Effect.succeed({
                title: `Skill path failed: ${targets[0]}`,
                output: `${error.message}\n\nPass a SKILL.md file or a folder that contains one. Absolute, ~, and relative paths all work.`,
                metadata: { mode: "load", name: targets[0] },
              } as const),
            ),
          )
          if ("dir" in loaded) {
            return {
              title: `Loaded skill: ${loaded.name}`,
              output: loaded.output,
              metadata: {
                mode: "load",
                name: loaded.name,
                dir: loaded.dir,
                source: loaded.source,
              },
            }
          }
          return loaded
        }).pipe(Effect.orDie),
    }
  }),
)
