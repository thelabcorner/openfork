import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { Effect, Layer, Context, Schema } from "effect"

import type { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"
import { Global } from "@opencode-ai/core/global"
import { SkillPlugin } from "@opencode-ai/core/plugin/skill"
import { Permission } from "@/permission"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Config } from "@/config/config"
import { FrontmatterError } from "@opencode-ai/core/v1/config/error"
import { ConfigMarkdown } from "@/config/markdown"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Glob } from "@opencode-ai/core/util/glob"
import { Discovery } from "./discovery"
import { isRecord } from "@/util/record"
import { escapeHtml } from "@/util/html"

const CLAUDE_EXTERNAL_DIR = ".claude"
const AGENTS_EXTERNAL_DIR = ".agents"
const EXTERNAL_SKILL_PATTERN = "skills/**/SKILL.md"
const OPENCODE_SKILL_PATTERN = "{skill,skills}/**/SKILL.md"
const SKILL_PATTERN = "**/SKILL.md"
const LOCAL_SKILL_DIR_NAMES = ["agent-skills", "skills", ".skills", "agent_skills", ".agent-skills", "custom-skills"]
const SKILL_MD_CANDIDATES = ["SKILL.md", "skill.md", "Skill.md"]

// Built-in skill that ships with opencode. The model's intuition for what an
// opencode.json should look like is often wrong, and opencode hard-fails on
// invalid config, so users hit cryptic startup errors. Loading this skill
// when the model is asked to touch opencode's own config files gives it the
// actual schemas instead of guesses.
const CUSTOMIZE_OPENCODE_SKILL_NAME = "customize-opencode"
const CUSTOMIZE_OPENCODE_SKILL_DESCRIPTION =
  "Use ONLY when the user is editing or creating opencode's own configuration: opencode.json, opencode.jsonc, files under .opencode/, or files under ~/.config/opencode/. Also use when creating or fixing opencode agents, subagents, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring opencode itself."
const CUSTOMIZE_OPENCODE_SKILL_BODY = SkillPlugin.CustomizeOpencodeContent

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  location: Schema.String,
  content: Schema.String,
})
export type Info = Schema.Schema.Type<typeof Info>

const Issue = Schema.StructWithRest(
  Schema.Struct({
    message: Schema.String,
    path: Schema.Array(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)

function isSkillFrontmatter(data: unknown): data is { name: string; description?: string } {
  return (
    isRecord(data) &&
    typeof data.name === "string" &&
    (data.description === undefined || typeof data.description === "string")
  )
}

// Self-healing helpers: normalize names (kebab/snake/case/space tolerant) for local agent-skills
const normalizeSkillName = (n: string) =>
  n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")

const findByNormalized = (skills: Record<string, Info>, name: string) => {
  const norm = normalizeSkillName(name)
  for (const [k, v] of Object.entries(skills)) {
    if (normalizeSkillName(k) === norm) return v
    if (normalizeSkillName(v.name) === norm) return v
  }
  return undefined
}

const deriveSkillName = (file: string) => {
  const base = path.basename(file)
  if (SKILL_MD_CANDIDATES.some((c) => c.toLowerCase() === base.toLowerCase())) {
    return normalizeSkillName(path.basename(path.dirname(file))) || "imported-skill"
  }
  return normalizeSkillName(base.replace(/\.(md|markdown)$/i, "")) || "imported-skill"
}

const resolveSkillMarkdown = Effect.fnUntraced(function* (fsys: FSUtil.Interface, fileOrDir: string) {
  if (yield* fsys.isFile(fileOrDir)) return fileOrDir
  if (yield* fsys.isDir(fileOrDir)) {
    for (const candidate of SKILL_MD_CANDIDATES) {
      const next = path.join(fileOrDir, candidate)
      if (yield* fsys.isFile(next)) return next
    }
    const matches = yield* Effect.tryPromise({
      try: () =>
        Glob.scan("*.md", {
          cwd: fileOrDir,
          absolute: true,
          include: "file",
        }),
      catch: (error) => error,
    }).pipe(Effect.catch(() => Effect.succeed([] as string[])))
    const named = matches.find((m) => SKILL_MD_CANDIDATES.some((c) => path.basename(m).toLowerCase() === c.toLowerCase()))
    if (named) return named
    if (matches[0]) return matches[0]
    return yield* new InvalidError({
      path: fileOrDir,
      message: `No SKILL.md (or other markdown skill file) in directory: ${fileOrDir}`,
    })
  }
  return yield* new InvalidError({
    path: fileOrDir,
    message: `Skill path not found (file or directory): ${fileOrDir}`,
  })
})

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("SkillInvalidError", {
  path: Schema.String,
  message: Schema.optional(Schema.String),
  issues: Schema.optional(Schema.Array(Issue)),
}) {}

export class NameMismatchError extends Schema.TaggedErrorClass<NameMismatchError>()("SkillNameMismatchError", {
  path: Schema.String,
  expected: Schema.String,
  actual: Schema.String,
}) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Skill.NotFoundError", {
  name: Schema.String,
  available: Schema.Array(Schema.String),
}) {
  override get message() {
    const list = this.available.join(", ") || "none"
    return `Skill "${this.name}" not found. Not in local skills folders (agent-skills/, skills/, .skills/, etc.) or registered.\nAvailable: ${list}\nTip: Use skill({ mode: "list" }), a normalized name, or skill({ filePath: "..." }) for a skill outside this project (Downloads, another repo, etc.).`
  }
}

type State = {
  skills: Record<string, Info>
  dirs: Set<string>
}

type DiscoveryState = {
  matches: string[]
  dirs: string[]
}

type ScanState = {
  matches: Set<string>
  dirs: Set<string>
}

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly require: (name: string) => Effect.Effect<Info, NotFoundError>
  readonly all: () => Effect.Effect<Info[]>
  readonly dirs: () => Effect.Effect<string[]>
  readonly available: (agent?: Agent.Info) => Effect.Effect<Info[]>
  readonly loadFromPath: (fileOrDir: string) => Effect.Effect<Info, InvalidError>
}

const add = Effect.fnUntraced(function* (state: State, match: string) {
  const md = yield* Effect.tryPromise({
    try: () => ConfigMarkdown.parse(match),
    catch: (err) => err,
  }).pipe(
    Effect.catch(
      Effect.fnUntraced(function* (err) {
        yield* Effect.logError("failed to load skill", {
          skill: match,
          error: FrontmatterError.isInstance(err) ? err.data.message : err,
        })
        return undefined
      }),
    ),
  )

  if (!md) return

  if (!isSkillFrontmatter(md.data)) return

  if (state.skills[md.data.name]) {
    yield* Effect.logWarning("duplicate skill name", {
      name: md.data.name,
      existing: state.skills[md.data.name].location,
      duplicate: match,
    })
  }

  state.dirs.add(path.dirname(match))
  state.skills[md.data.name] = {
    name: md.data.name,
    description: md.data.description,
    location: match,
    content: md.content,
  }
})

const scan = Effect.fnUntraced(function* (
  state: ScanState,
  root: string,
  pattern: string,
  opts?: { dot?: boolean; scope?: string },
) {
  const matches = yield* Effect.tryPromise({
    try: () =>
      Glob.scan(pattern, {
        cwd: root,
        absolute: true,
        include: "file",
        symlink: true,
        dot: opts?.dot,
      }),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) => {
      if (!opts?.scope) return Effect.die(error)
      return Effect.logError(`failed to scan ${opts.scope} skills`, { dir: root, error: error }).pipe(
        Effect.as([] as string[]),
      )
    }),
  )

  for (const match of matches) {
    state.matches.add(match)
    state.dirs.add(path.dirname(match))
  }
})

const discoverSkills = Effect.fnUntraced(function* (
  config: Config.Interface,
  discovery: Discovery.Interface,
  fsys: FSUtil.Interface,
  global: Global.Interface,
  disableExternalSkills: boolean,
  disableClaudeCodeSkills: boolean,
  directory: string,
  worktree: string,
) {
  const state: ScanState = { matches: new Set(), dirs: new Set() }

  const externalDirs: string[] = []
  if (!disableExternalSkills) {
    if (!disableClaudeCodeSkills) externalDirs.push(CLAUDE_EXTERNAL_DIR)
    externalDirs.push(AGENTS_EXTERNAL_DIR)

    for (const dir of externalDirs) {
      const root = path.join(global.home, dir)
      if (!(yield* fsys.isDir(root))) continue
      yield* scan(state, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "global" })
    }

    const upDirs = yield* fsys
      .up({ targets: externalDirs, start: directory, stop: worktree })
      .pipe(Effect.catch(() => Effect.succeed([] as string[])))

    for (const root of upDirs) {
      yield* scan(state, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "project" })
    }
  }

  const configDirs = yield* config.directories()
  for (const dir of configDirs) {
    yield* scan(state, dir, OPENCODE_SKILL_PATTERN)
  }

  const cfg = yield* config.get()
  for (const item of cfg.skills?.paths ?? []) {
    const expanded = item.startsWith("~/") ? path.join(global.home, item.slice(2)) : item
    const dir = path.isAbsolute(expanded) ? expanded : path.join(directory, expanded)
    if (!(yield* fsys.isDir(dir))) {
      yield* Effect.logWarning("skill path not found", { path: dir })
      continue
    }

    yield* scan(state, dir, SKILL_PATTERN)
  }

  // Self-healing local discovery: support many folder names for skills (agent-skills, skills, .skills, etc.)
  // Multiple folders are allowed and all are scanned. Uses **/SKILL.md so subdir-per-skill works.
  for (const dirName of LOCAL_SKILL_DIR_NAMES) {
    const localDir = path.join(worktree, dirName)
    if (yield* fsys.isDir(localDir)) {
      yield* scan(state, localDir, SKILL_PATTERN, { scope: `local ${dirName}` })
    }
    // upward for monorepos / nested
    const ups = yield* fsys
      .up({ targets: [dirName], start: directory, stop: worktree })
      .pipe(Effect.catch(() => Effect.succeed([] as string[])))
    for (const root of ups) {
      yield* scan(state, root, SKILL_PATTERN, { scope: `local ${dirName}` })
    }
  }

  for (const url of cfg.skills?.urls ?? []) {
    const pulledDirs = yield* discovery.pull(url)
    for (const dir of pulledDirs) {
      yield* scan(state, dir, SKILL_PATTERN)
    }
  }

  return {
    matches: Array.from(state.matches),
    dirs: Array.from(state.dirs),
  }
})

const loadSkills = Effect.fnUntraced(function* (state: State, discovered: DiscoveryState) {
  yield* Effect.forEach(discovered.matches, (match) => add(state, match), {
    concurrency: 8,
    discard: true,
  })

  yield* Effect.logInfo("init", { count: Object.keys(state.skills).length })
})

export class Service extends Context.Service<Service, Interface>()("@opencode/Skill") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* Discovery.Service
    const config = yield* Config.Service
    const fsys = yield* FSUtil.Service
    const global = yield* Global.Service
    const flags = yield* RuntimeFlags.Service
    const discovered = yield* InstanceState.make(
      Effect.fn("Skill.discovery")(function* (ctx) {
        return yield* discoverSkills(
          config,
          discovery,
          fsys,
          global,
          flags.disableExternalSkills,
          flags.disableClaudeCodeSkills,
          ctx.directory,
          ctx.worktree,
        )
      }),
    )
    const state = yield* InstanceState.make(
      Effect.fn("Skill.state")(function* () {
        const s: State = { skills: {}, dirs: new Set() }
        // Register the built-in skill BEFORE disk discovery so a user-disk
        // skill with the same name can override it.
        s.skills[CUSTOMIZE_OPENCODE_SKILL_NAME] = {
          name: CUSTOMIZE_OPENCODE_SKILL_NAME,
          description: CUSTOMIZE_OPENCODE_SKILL_DESCRIPTION,
          location: "<built-in>",
          content: CUSTOMIZE_OPENCODE_SKILL_BODY,
        }
        yield* loadSkills(s, yield* InstanceState.get(discovered))
        return s
      }),
    )

    const get = Effect.fn("Skill.get")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      return s.skills[name] ?? findByNormalized(s.skills, name)
    })

    const require = Effect.fn("Skill.require")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      const info = s.skills[name] ?? findByNormalized(s.skills, name)
      if (info) return info
      return yield* new NotFoundError({ name, available: Object.keys(s.skills).toSorted() })
    })

    const loadFromPath = Effect.fn("Skill.loadFromPath")(function* (fileOrDir: string) {
      const file = yield* resolveSkillMarkdown(fsys, fileOrDir)
      const md = yield* Effect.tryPromise({
        try: () => ConfigMarkdown.parse(file),
        catch: (err) => err,
      }).pipe(
        Effect.catch((err) =>
          Effect.fail(
            new InvalidError({
              path: file,
              message: FrontmatterError.isInstance(err)
                ? err.data.message
                : `Failed to parse skill markdown: ${err instanceof Error ? err.message : String(err)}`,
            }),
          ),
        ),
      )
      const name = isSkillFrontmatter(md.data) ? md.data.name : deriveSkillName(file)
      const description = isSkillFrontmatter(md.data) ? md.data.description : undefined
      const info: Info = {
        name,
        description,
        location: file,
        content: md.content,
      }
      const s = yield* InstanceState.get(state)
      s.skills[name] = info
      s.dirs.add(path.dirname(file))
      return info
    })

    const all = Effect.fn("Skill.all")(function* () {
      const s = yield* InstanceState.get(state)
      return Object.values(s.skills)
    })

    const dirs = Effect.fn("Skill.dirs")(function* () {
      return (yield* InstanceState.get(discovered)).dirs
    })

    const available = Effect.fn("Skill.available")(function* (agent?: Agent.Info) {
      const s = yield* InstanceState.get(state)
      const list = Object.values(s.skills).toSorted((a, b) => a.name.localeCompare(b.name))
      if (!agent) return list
      return list.filter((skill) => Permission.evaluate("skill", skill.name, agent.permission).action !== "deny")
    })

    return Service.of({ get, require, all, dirs, available, loadFromPath })
  }),
)

export function fmt(list: Info[], opts: { verbose: boolean }) {
  const described = list.filter((skill) => skill.description !== undefined)
  if (described.length === 0) return "No skills are currently available."
  if (opts.verbose) {
    return [
      "<available_skills>",
      ...described
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .flatMap((skill) => [
          "  <skill>",
          `    <name>${skill.name}</name>`,
          `    <description>${skill.description}</description>`,
          `    <location>${escapeHtml(skill.location)}</location>`,
          "  </skill>",
        ]),
      "</available_skills>",
    ].join("\n")
  }

  return [
    "## Available Skills",
    ...described
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((skill) => `- **${skill.name}**: ${skill.description}`),
  ].join("\n")
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Discovery.node, Config.node, FSUtil.node, Global.node, RuntimeFlags.node],
})

export * as Skill from "."
