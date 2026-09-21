export * as ExchangeSkill from "./skill"

import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Schema } from "effect"
import type { FSUtil } from "@opencode-ai/core/fs-util"
import { Skill } from "@/skill"
import { LEGACY_PROJECT_CONFIG_DIRNAME, PROJECT_CONFIG_DIRNAME } from "@opencode-ai/core/storage-identity"
import { ExchangeError } from "./error"

const MAX_DISCOVERED = 500
const MAX_SCAN_DEPTH = 12
const RESOURCE_SAMPLE = 10
const RESOURCE_DEPTH = 6
const ROOT_SKILL_DIRS = [
  `${PROJECT_CONFIG_DIRNAME}/skill`,
  `${PROJECT_CONFIG_DIRNAME}/skills`,
  `${LEGACY_PROJECT_CONFIG_DIRNAME}/skill`,
  `${LEGACY_PROJECT_CONFIG_DIRNAME}/skills`,
  ".claude/skills",
  ".agents/skills",
  "agent-skills",
  "skills",
  ".skills",
  "agent_skills",
  ".agent-skills",
  "custom-skills",
] as const

export const Parameters = Schema.Struct({
  mode: Schema.optional(Schema.Literals(["load", "list", "search"])),
  name: Schema.optional(Schema.String),
  names: Schema.optional(Schema.Array(Schema.String)),
  filePath: Schema.optional(Schema.String).annotate({
    description: "Root-relative SKILL.md path or skill directory inside the approved root.",
  }),
  query: Schema.optional(Schema.String),
  tags: Schema.optional(Schema.Array(Schema.String)),
  offset: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(100_000))),
  limit: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(200))),
})
export type Input = Schema.Schema.Type<typeof Parameters>

export interface ResolvedPath {
  readonly path: string
  readonly virtualPath: string
}

export interface Context {
  readonly rootPath: string
  readonly signal?: AbortSignal
  readonly resolvePath: (input: string) => Effect.Effect<ResolvedPath, ExchangeError.Error>
  readonly toVirtualPath: (absolutePath: string) => string
  readonly revalidate: () => Effect.Effect<void, ExchangeError.Error>
}

export interface Result {
  readonly title: string
  readonly output: string
  readonly metadata: Readonly<Record<string, unknown>>
}

type CatalogItem = {
  readonly info: Skill.Info
  readonly virtualLocation: string
}

function escapeXml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function looksLikePath(value: string) {
  const next = value.trim()
  return next.startsWith("/") || next.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(next) || next.includes("/") || next.includes("\\") || /\.(?:md|markdown)$/i.test(next)
}

function matchesTags(info: Skill.Info, tags: readonly string[] | undefined) {
  if (!tags?.length) return true
  const haystack = `${info.name} ${info.description ?? ""}`.toLowerCase()
  return tags.every((tag) => haystack.includes(tag.toLowerCase()))
}

async function scanSkillFiles(rootPath: string) {
  const found = new Set<string>()
  const addRootCandidate = async (candidate: string) => {
    if (found.size >= MAX_DISCOVERED) return
    const stat = await fs.lstat(candidate).catch(() => undefined)
    if (stat?.isFile() && !stat.isSymbolicLink()) found.add(candidate)
  }
  for (const candidate of ["SKILL.md", "skill.md", "Skill.md"]) {
    await addRootCandidate(path.join(rootPath, candidate))
  }
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_SCAN_DEPTH || found.size >= MAX_DISCOVERED) return
    const stat = await fs.lstat(directory).catch(() => undefined)
    if (!stat?.isDirectory() || stat.isSymbolicLink()) return
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (found.size >= MAX_DISCOVERED) return
      if (entry.isSymbolicLink()) continue
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(target, depth + 1)
      } else if (entry.isFile() && entry.name.toLowerCase() === "skill.md") {
        found.add(target)
      }
    }
  }
  for (const relative of ROOT_SKILL_DIRS) {
    await walk(path.join(rootPath, relative), 0)
    if (found.size >= MAX_DISCOVERED) break
  }
  return [...found].toSorted()
}

async function sampleResources(base: string) {
  const files: string[] = []
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > RESOURCE_DEPTH || files.length >= RESOURCE_SAMPLE) return
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= RESOURCE_SAMPLE) return
      if (entry.isSymbolicLink()) continue
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(target, depth + 1)
      else if (entry.isFile() && entry.name.toLowerCase() !== "skill.md") files.push(target)
    }
  }
  await walk(base, 0)
  return files
}

export const execute = Effect.fn("ExchangeSkill.execute")(function* (
  fsys: FSUtil.Interface,
  input: Input,
  context: Context,
) {
  if (context.signal?.aborted) return yield* new ExchangeError.Cancelled({ detail: "Skill operation was cancelled" })

  const parseExplicit = Effect.fn("ExchangeSkill.parseExplicit")(function* (inputPath: string) {
    const target = yield* context.resolvePath(inputPath)
    const info = yield* Skill.readInfoFromPath(fsys, target.path).pipe(
      Effect.mapError(() => new ExchangeError.InvalidArgument({ detail: `Invalid skill markdown at ${target.virtualPath}` })),
    )
    return { info, virtualLocation: context.toVirtualPath(info.location) } satisfies CatalogItem
  })

  const discover = Effect.fn("ExchangeSkill.discover")(function* () {
    if (context.signal?.aborted) return yield* new ExchangeError.Cancelled({ detail: "Skill discovery was cancelled" })
    const matches = yield* Effect.tryPromise({
      try: () => scanSkillFiles(context.rootPath),
      catch: () => new ExchangeError.DependencyUnavailable({ detail: "Unable to scan project-local skills" }),
    })
    const parsed = yield* Effect.forEach(
      matches,
      (match) =>
        Skill.readInfoFromPath(fsys, match).pipe(
          Effect.map((info) => ({ info, virtualLocation: context.toVirtualPath(info.location) }) satisfies CatalogItem),
          Effect.catch(() => Effect.succeed(undefined)),
        ),
      { concurrency: 8 },
    )
    if (context.signal?.aborted) return yield* new ExchangeError.Cancelled({ detail: "Skill discovery was cancelled" })
    const byName = new Map<string, CatalogItem>()
    for (const item of parsed) {
      if (!item) continue
      byName.set(Skill.normalizeSkillName(item.info.name), item)
    }
    yield* context.revalidate()
    return [...byName.values()].toSorted((a, b) => a.info.name.localeCompare(b.info.name))
  })

  const renderLoaded = Effect.fn("ExchangeSkill.renderLoaded")(function* (item: CatalogItem) {
    const base = path.dirname(item.info.location)
    const resources = yield* Effect.tryPromise({
      try: () => sampleResources(base),
      catch: () => new ExchangeError.DependencyUnavailable({ detail: "Unable to sample skill resources" }),
    })
    return [
      `<skill_content name="${escapeXml(item.info.name)}">`,
      `# Skill: ${item.info.name}`,
      "",
      item.info.content.trim(),
      "",
      `Base directory for this skill: ${context.toVirtualPath(base)}`,
      "Relative paths in this skill are relative to this base directory.",
      "Note: file list is sampled.",
      "",
      "<skill_files>",
      ...resources.map((file) => `  <file>${escapeXml(context.toVirtualPath(file))}</file>`),
      "</skill_files>",
      "</skill_content>",
    ].join("\n")
  })

  const mode = input.mode ?? "load"
  if (mode === "list" || mode === "search") {
    const all = yield* discover()
    const query = input.query?.trim().toLowerCase()
    const filtered = all.filter(
      (item) => matchesTags(item.info, input.tags) &&
        (query === undefined || item.info.name.toLowerCase().includes(query) || (item.info.description ?? "").toLowerCase().includes(query)),
    )
    const offset = input.offset ?? 0
    const limit = input.limit ?? 100
    const page = filtered.slice(offset, offset + limit)
    const truncated = offset + page.length < filtered.length
    return {
      title: `skills (${mode})`,
      output: [
        `<skills mode="${mode}" count="${page.length}" total="${filtered.length}" offset="${offset}" truncated="${truncated}">`,
        ...page.map((item) => `  <skill name="${escapeXml(item.info.name)}" description="${escapeXml(item.info.description ?? "No description.")}" />`),
        "</skills>",
        ...(truncated ? ["More skills are available; continue with a larger offset or narrow the query."] : []),
      ].join("\n"),
      metadata: { mode, count: page.length, total: filtered.length, offset, truncated, names: page.map((item) => item.info.name) },
    } satisfies Result
  }

  const targets = [
    ...(input.filePath ? [input.filePath] : []),
    ...(input.names ?? []),
    ...(input.name && !input.filePath ? [input.name] : []),
  ]
  if (targets.length === 0) return yield* new ExchangeError.InvalidArgument({ detail: "skill.load requires name, names, or filePath" })
  if (targets.length > 32) return yield* new ExchangeError.InvalidArgument({ detail: "skill.load accepts at most 32 targets per call" })

  let catalog: readonly CatalogItem[] | undefined
  const loaded: CatalogItem[] = []
  const missing: string[] = []
  for (const target of targets) {
    if (context.signal?.aborted) return yield* new ExchangeError.Cancelled({ detail: "Skill load was cancelled" })
    if (target === input.filePath || looksLikePath(target)) {
      loaded.push(yield* parseExplicit(target))
      continue
    }
    catalog ??= yield* discover()
    const normalized = Skill.normalizeSkillName(target)
    const match = catalog.find((item) => Skill.normalizeSkillName(item.info.name) === normalized)
    if (match) loaded.push(match)
    else missing.push(target)
  }

  if (loaded.length === 0) {
    const available = (catalog ?? (yield* discover())).slice(0, 24).map((item) => item.info.name)
    return yield* new ExchangeError.NotFound({
      detail: `No requested project-local skill was found. Available inside this approved root: ${available.join(", ") || "none"}`,
    })
  }
  const rendered = yield* Effect.forEach(loaded, renderLoaded, { concurrency: 4 })
  yield* context.revalidate()
  return {
    title: loaded.length === 1 ? `Loaded skill: ${loaded[0]!.info.name}` : `Loaded ${loaded.length} skills`,
    output: rendered.join("\n\n"),
    metadata: { mode: "load", names: loaded.map((item) => item.info.name), missing, count: loaded.length },
  } satisfies Result
})
