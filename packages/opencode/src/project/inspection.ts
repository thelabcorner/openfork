import fs from "node:fs/promises"
import path from "path"
import { Effect, Schema } from "effect"
import { Ripgrep } from "@opencode-ai/core/ripgrep"

export const MAX_MANIFEST_BYTES = 256_000
export const MAX_FILES = 20_000
export const MAX_SCRIPTS = 40
export const MAX_SCRIPT_CMD = 120
export const MAX_REQ_DEPS = 50
export const MAX_GO_DEPS = 20
export const DEFAULT_RECENT = 15
export const MAX_RECENT = 50
export const DEFAULT_TREE_DEPTH = 3
export const MAX_TREE_DEPTH = 5
export const DEFAULT_TREE_ENTRIES = 200
export const MAX_TREE_ENTRIES = 500

export class InvalidInput extends Schema.TaggedErrorClass<InvalidInput>()("ProjectInspection.InvalidInput", {
  message: Schema.String,
}) {}

/**
 * Project inspection is deliberately metadata-first. These are the only file
 * bodies it may open; arbitrary source/config bodies remain outside this owner.
 */
export const MANIFEST_NAMES = new Set([
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "requirements.txt",
  "Gemfile",
  "composer.json",
  "tsconfig.json",
  ".nvmrc",
  ".node-version",
  ".python-version",
  ".tool-versions",
  ".ruby-version",
])

export type ManifestResult = { readonly text: string } | { readonly tooLarge: number } | undefined

export interface StackInfo {
  readonly ecosystem: string
  readonly monorepo: boolean
  readonly packageManager?: string
  readonly frameworks: readonly string[]
  readonly deps: readonly string[]
  readonly entryPoints: readonly string[]
  readonly runtimeVersion?: string
  readonly versionKind?: string
  readonly notes: readonly string[]
}

export interface ScriptInfo {
  readonly name: string
  readonly category: string
  readonly cmd: string
}

export interface Presence {
  readonly path: string
  readonly kind: string
}

export interface FileStats {
  readonly files: number
  readonly totalBytes: number
  readonly byExt: readonly { readonly ext: string; readonly files: number; readonly bytes: number }[]
}

export interface TreeProjection {
  readonly lines: readonly string[]
  readonly totalFiles: number
  readonly totalBytes: number
  readonly entries: number
  readonly truncated: boolean
}

export interface Inspection {
  readonly root: string
  readonly scope: string
  readonly scopeRelative: string
  readonly rootFiles: readonly string[]
  readonly files: readonly string[]
  readonly sizes: ReadonlyMap<string, number>
  readonly listTruncated: boolean
  readonly manifests: ReadonlyMap<string, ManifestResult>
  readonly stack?: StackInfo
  readonly lockfile?: string
  readonly versionPins: readonly (readonly [string, string])[]
  readonly scripts?: readonly ScriptInfo[]
  readonly entryPoints: readonly string[]
  readonly configs: readonly Presence[]
  readonly ci: readonly Presence[]
  readonly stats: FileStats
  readonly notes: readonly string[]
}

const NODE_FRAMEWORKS: ReadonlyArray<[string, string]> = [
  ["react", "React"],
  ["react-dom", "React"],
  ["next", "Next.js"],
  ["vue", "Vue"],
  ["svelte", "Svelte"],
  ["@angular/core", "Angular"],
  ["express", "Express"],
  ["fastify", "Fastify"],
  ["@nestjs/core", "NestJS"],
  ["astro", "Astro"],
  ["tauri", "Tauri"],
  ["electron", "Electron"],
  ["hono", "Hono"],
  ["solid-js", "Solid"],
  ["preact", "Preact"],
  ["remix", "Remix"],
  ["gatsby", "Gatsby"],
  ["vite", "Vite"],
  ["webpack", "Webpack"],
  ["eslint", "ESLint"],
  ["typescript", "TypeScript"],
  ["zod", "Zod"],
  ["vitest", "Vitest"],
  ["jest", "Jest"],
  ["playwright", "Playwright"],
]

const PY_FRAMEWORKS: ReadonlyArray<[string, string]> = [
  ["fastapi", "FastAPI"],
  ["django", "Django"],
  ["flask", "Flask"],
  ["pydantic", "Pydantic"],
  ["sqlalchemy", "SQLAlchemy"],
  ["pytest", "pytest"],
  ["celery", "Celery"],
]

const RUST_FRAMEWORKS: ReadonlyArray<[string, string]> = [
  ["tokio", "tokio"],
  ["axum", "axum"],
  ["actix-web", "actix-web"],
  ["serde", "serde"],
  ["clap", "clap"],
  ["rocket", "rocket"],
  ["tonic", "tonic"],
]

const ENTRY_PROBES: ReadonlyArray<[string, string]> = [
  ["src/main.ts", "main.ts"],
  ["src/main.js", "main.js"],
  ["src/main.tsx", "main.tsx"],
  ["src/index.ts", "index.ts"],
  ["src/index.js", "index.js"],
  ["index.js", "index.js"],
  ["src/main.py", "main.py"],
  ["main.py", "main.py"],
  ["app.py", "app.py"],
  ["manage.py", "manage.py"],
  ["bot.py", "bot.py"],
  ["src/main.rs", "main.rs"],
  ["src/lib.rs", "lib.rs"],
  ["main.rs", "main.rs"],
  ["main.go", "main.go"],
]

const SOURCE_ROOTS = ["src", "lib", "app", "cmd", "packages", "crates"] as const

export const LOCKFILES: ReadonlyArray<[string, string]> = [
  ["package-lock.json", "npm"],
  ["yarn.lock", "yarn"],
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["poetry.lock", "poetry"],
  ["uv.lock", "uv"],
  ["Cargo.lock", "cargo"],
  ["go.sum", "go"],
  ["Gemfile.lock", "bundler"],
  ["composer.lock", "composer"],
]

export const CONFIG_PROBES: ReadonlyArray<[string, string]> = [
  ["tsconfig.json", "tsconfig"],
  ["jsconfig.json", "jsconfig"],
  [".editorconfig", "editorconfig"],
  ["Dockerfile", "dockerfile"],
  [".dockerignore", "dockerignore"],
]

export const CI_PROBES: ReadonlyArray<[string, string]> = [
  [".gitlab-ci.yml", "gitlab-ci"],
  [".circleci/config.yml", "circleci"],
  ["Jenkinsfile", "jenkins"],
  ["azure-pipelines.yml", "azure-pipelines"],
  ["appveyor.yml", "appveyor"],
  [".buildkite/pipeline.yml", "buildkite"],
  ["bitbucket-pipelines.yml", "bitbucket-pipelines"],
  [".travis.yml", "travis"],
]

const CONFIG_PATTERNS: ReadonlyArray<RegExp> = [
  /^\.eslintrc.*$/,
  /^eslint\.config\..*$/,
  /^\.prettierrc.*$/,
  /^\.babelrc.*$/,
  /^babel\.config\..*$/,
  /^vitest\.config\..*$/,
  /^jest\.config\..*$/,
  /^playwright\.config\..*$/,
  /^next\.config\..*$/,
  /^vite\.config\..*$/,
  /^webpack\.config\..*$/,
]

const SCRIPT_CATEGORIES: ReadonlyArray<[RegExp, string]> = [
  [/^(dev|serve|start)(:|$)/, "dev"],
  [/^(build|compile|bundle)(:|$)/, "build"],
  [/^(test|test:.*|e2e)(:|$)/, "test"],
  [/^(lint|check)(:|$)/, "lint"],
  [/^(typecheck|types|tsc)(:|$)/, "typecheck"],
  [/^(format|prettier)(:|$)/, "format"],
  [/^db:/, "db"],
  [/^(publish|release)(:|$)/, "release"],
]

const LIFECYCLE = new Set(["preinstall", "postinstall", "prepare"])

const matchFrameworks = (deps: ReadonlySet<string>, map: ReadonlyArray<[string, string]>): string[] => {
  const found: string[] = []
  for (const [dep, name] of map) {
    if (deps.has(dep) && !found.includes(name)) {
      found.push(name)
      if (found.length >= 3) break
    }
  }
  return found
}

const jsonObject = (text: string | undefined): Record<string, unknown> | undefined => {
  if (!text) return undefined
  try {
    const value = JSON.parse(text)
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function sectionLines(section: string, text: string): string[] {
  const re = new RegExp(`^\\[${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`, "m")
  const start = re.exec(text)?.[0]
  if (!start) return []
  const from = text.indexOf(start) + start.length
  const rest = text.slice(from)
  const next = /^\[/m.exec(rest)
  return rest.slice(0, next?.index ?? rest.length).split("\n")
}

export function probeEntryPoints(files: ReadonlySet<string>): string[] {
  const out: string[] = []
  for (const [rel, base] of ENTRY_PROBES) {
    if (files.has(rel)) out.push(rel)
    else if (files.has(base)) out.push(base)
  }
  for (const file of files) {
    if (file.startsWith("cmd/") && file.endsWith("/main.go")) {
      out.push(file)
      if (out.length >= 10) break
    }
  }
  return [...new Set(out)].slice(0, 10)
}

function detectNode(text: string | undefined, files: ReadonlySet<string>): StackInfo | undefined {
  const pkg = jsonObject(text)
  if (!pkg) return undefined
  const deps: string[] = []
  for (const key of ["dependencies", "devDependencies"] as const) {
    const block = pkg[key]
    if (block && typeof block === "object") deps.push(...Object.keys(block))
  }
  const workspaces = pkg.workspaces
  const monorepo =
    (Array.isArray(workspaces) && workspaces.length > 0) ||
    (typeof workspaces === "object" && workspaces !== null && "packages" in workspaces)
  const engines = pkg.engines
  const entryPoints: string[] = []
  for (const key of ["main", "module"] as const) if (typeof pkg[key] === "string") entryPoints.push(pkg[key] as string)
  const bin = pkg.bin
  if (typeof bin === "string") entryPoints.push(bin)
  else if (bin && typeof bin === "object") entryPoints.push(...Object.values(bin).filter((value): value is string => typeof value === "string"))
  for (const rel of ["src/main.ts", "src/main.js", "src/main.tsx", "src/index.ts", "src/index.js", "index.js", "index.ts"]) {
    if (files.has(rel)) entryPoints.push(rel)
  }
  const enginesNode =
    engines && typeof engines === "object" && "node" in engines && typeof engines.node === "string" ? engines.node : undefined
  return {
    ecosystem: "node",
    monorepo,
    packageManager: typeof pkg.packageManager === "string" ? pkg.packageManager : undefined,
    frameworks: matchFrameworks(new Set(deps), NODE_FRAMEWORKS),
    deps: [...new Set(deps)].slice(0, MAX_REQ_DEPS),
    entryPoints: [...new Set([...entryPoints, ...probeEntryPoints(files)])].slice(0, 10),
    runtimeVersion: enginesNode,
    versionKind: enginesNode ? "node" : undefined,
    notes: [],
  }
}

function detectPython(text: string | undefined, files: ReadonlySet<string>): StackInfo | undefined {
  if (text === undefined) return undefined
  const projectSection = sectionLines("project", text)
  if (projectSection.length === 0) return undefined
  const projectName = /^\s*name\s*=\s*"([^"]+)"/m.exec(projectSection.join("\n"))?.[1]
  const requiresPython = /^\s*requires-python\s*=\s*"([^"]+)"/m.exec(projectSection.join("\n"))?.[1]
  const deps = new Set<string>()
  for (const section of ["project", "project.dependencies", "tool.poetry.dependencies", "project.optional-dependencies"]) {
    for (const line of sectionLines(section, text)) {
      const match = /^\s*"?([a-zA-Z0-9_.-]+)"?\s*(?:,|=|>|<|~|\[|$)/.exec(line.trim())
      if (match && match[1] !== "name" && match[1] !== "requires-python" && match[1] !== "dependencies") deps.add(match[1]!)
    }
  }
  const tools: string[] = []
  if (text.includes("[tool.poetry]")) tools.push("Poetry")
  if (text.includes("[tool.uv]")) tools.push("uv")
  if (text.includes("[tool.ruff]")) tools.push("Ruff")
  if (text.includes("[tool.black]")) tools.push("Black")
  const entries = ["src/main.py", "main.py", "app.py", "manage.py", "bot.py"].filter((rel) => files.has(rel))
  return {
    ecosystem: "python",
    monorepo: false,
    frameworks: [...matchFrameworks(deps, PY_FRAMEWORKS), ...tools].slice(0, 3),
    deps: [...deps].slice(0, MAX_REQ_DEPS),
    entryPoints: entries.slice(0, 10),
    runtimeVersion: requiresPython,
    versionKind: requiresPython ? "python" : undefined,
    notes: projectName ? [`project=${projectName}`] : [],
  }
}

function detectRust(text: string | undefined, files: ReadonlySet<string>): StackInfo | undefined {
  if (text === undefined) return undefined
  const packageSection = sectionLines("package", text)
  if (packageSection.length === 0) return undefined
  const crateName = /^\s*name\s*=\s*"([^"]+)"/m.exec(packageSection.join("\n"))?.[1]
  const edition = /^\s*edition\s*=\s*"([^"]+)"/m.exec(packageSection.join("\n"))?.[1]
  const deps = new Set<string>()
  for (const line of sectionLines("dependencies", text)) {
    const match = /^([a-zA-Z0-9_-]+)\s*=/.exec(line.trim())
    if (match) deps.add(match[1]!)
  }
  return {
    ecosystem: "rust",
    monorepo: text.includes("[workspace]"),
    frameworks: matchFrameworks(deps, RUST_FRAMEWORKS),
    deps: [...deps].slice(0, MAX_REQ_DEPS),
    entryPoints: ["src/main.rs", "src/lib.rs", "main.rs"].filter((rel) => files.has(rel)).slice(0, 10),
    runtimeVersion: edition,
    versionKind: edition ? "edition" : undefined,
    notes: crateName ? [`crate=${crateName}`] : [],
  }
}

function detectGo(text: string | undefined, files: ReadonlySet<string>): StackInfo | undefined {
  if (text === undefined) return undefined
  const moduleName = /^module\s+(\S+)/m.exec(text)?.[1]
  if (moduleName === undefined) return undefined
  const goVersion = /^go\s+([0-9.]+)/m.exec(text)?.[1]
  const deps = new Set<string>()
  const requireBlock = /^require\s*\(([\s\S]*?)\)/m.exec(text)
  if (requireBlock) for (const match of requireBlock[1]!.matchAll(/^(\S+)\s+v/gm)) deps.add(match[1]!)
  else for (const match of text.matchAll(/^require\s+(\S+)/gm)) deps.add(match[1]!)
  const entries: string[] = files.has("main.go") ? ["main.go"] : []
  for (const file of files) {
    if (file.startsWith("cmd/") && file.endsWith("/main.go")) {
      entries.push(file)
      if (entries.length >= 10) break
    }
  }
  return {
    ecosystem: "go",
    monorepo: false,
    frameworks: [],
    deps: [...deps].slice(0, MAX_GO_DEPS),
    entryPoints: entries,
    runtimeVersion: goVersion,
    versionKind: goVersion ? "go" : undefined,
    notes: [`module=${moduleName}`],
  }
}

function detectJava(text: string | undefined): StackInfo | undefined {
  if (text === undefined) return undefined
  const groupId = /<groupId>\s*([^<\s]+)/.exec(text)?.[1]
  const artifactId = /<artifactId>\s*([^<\s]+)/.exec(text)?.[1]
  if (artifactId === undefined) return undefined
  const frameworks: string[] = []
  if (text.includes("spring-boot-starter")) frameworks.push("Spring Boot")
  if (text.includes("junit-jupiter")) frameworks.push("JUnit 5")
  if (text.includes("<artifactId>lombok</artifactId>")) frameworks.push("Lombok")
  if (text.includes("kotlin-maven-plugin")) frameworks.push("Kotlin")
  return {
    ecosystem: "java",
    monorepo: false,
    frameworks: frameworks.slice(0, 3),
    deps: [],
    entryPoints: [],
    notes: groupId ? [`groupId=${groupId}`] : [],
  }
}

function detectRuby(text: string | undefined): StackInfo | undefined {
  if (text === undefined) return undefined
  const gems = new Set<string>()
  for (const match of text.matchAll(/^\s*gem\s+["']([^"']+)["']/gm)) gems.add(match[1]!)
  if (gems.size === 0) return undefined
  const frameworks: string[] = []
  if (gems.has("rails")) frameworks.push("Rails")
  if (gems.has("sinatra")) frameworks.push("Sinatra")
  if (gems.has("rspec")) frameworks.push("RSpec")
  return { ecosystem: "ruby", monorepo: false, frameworks: frameworks.slice(0, 3), deps: [...gems].slice(0, MAX_REQ_DEPS), entryPoints: [], notes: [] }
}

function detectPhp(text: string | undefined): StackInfo | undefined {
  const composer = jsonObject(text)
  if (!composer) return undefined
  const require = composer.require
  if (!require || typeof require !== "object") return undefined
  const deps = Object.keys(require)
  const frameworks: string[] = []
  if (deps.includes("laravel/framework")) frameworks.push("Laravel")
  if (deps.some((dep) => dep.startsWith("symfony/"))) frameworks.push("Symfony")
  return { ecosystem: "php", monorepo: false, frameworks: frameworks.slice(0, 3), deps: deps.slice(0, MAX_REQ_DEPS), entryPoints: [], notes: [] }
}

export function annotateScripts(text: string | undefined): readonly ScriptInfo[] | undefined {
  const pkg = jsonObject(text)
  const scripts = pkg?.scripts
  if (!scripts || typeof scripts !== "object") return undefined
  return Object.entries(scripts as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .slice(0, MAX_SCRIPTS)
    .map(([name, cmd]) => ({
      name,
      category: LIFECYCLE.has(name) ? "lifecycle" : (SCRIPT_CATEGORIES.find(([regex]) => regex.test(name))?.[1] ?? "other"),
      cmd: cmd.length > MAX_SCRIPT_CMD ? `${cmd.slice(0, MAX_SCRIPT_CMD)}…` : cmd,
    }))
}

export async function manifestText(dir: string, name: string): Promise<ManifestResult> {
  if (!MANIFEST_NAMES.has(name)) return undefined
  try {
    const stat = await fs.stat(path.join(dir, name))
    if (!stat.isFile()) return undefined
    if (stat.size > MAX_MANIFEST_BYTES) return { tooLarge: stat.size }
    return { text: await fs.readFile(path.join(dir, name), "utf8") }
  } catch {
    return undefined
  }
}

export function detectStack(
  files: ReadonlySet<string>,
  rootFiles: ReadonlySet<string>,
  manifests: ReadonlyMap<string, ManifestResult>,
) {
  const text = (name: string) => {
    const result = manifests.get(name)
    return result && "text" in result ? result.text : undefined
  }
  const stack =
    detectNode(text("package.json"), files) ??
    detectPython(text("pyproject.toml"), files) ??
    detectRust(text("Cargo.toml"), files) ??
    detectGo(text("go.mod"), files) ??
    detectJava(text("pom.xml")) ??
    detectRuby(text("Gemfile")) ??
    detectPhp(text("composer.json"))
  if (!stack) return { stack: undefined, lockfile: undefined, versionPins: [] as Array<[string, string]> }

  let lockfile: string | undefined
  for (const [name, kind] of LOCKFILES) {
    if (rootFiles.has(name) || files.has(name)) {
      lockfile = kind
      break
    }
  }
  const versionPins: Array<[string, string]> = []
  for (const name of [".nvmrc", ".node-version", ".python-version", ".tool-versions", ".ruby-version"]) {
    const result = manifests.get(name)
    if (result && "text" in result) {
      const line = result.text.split("\n")[0]?.trim()
      if (line) versionPins.push([name, line])
    }
  }
  return { stack, lockfile, versionPins }
}

export const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  const rounded = value >= 100 ? Math.round(value) : value >= 10 ? Math.round(value * 10) / 10 : Math.round(value * 100) / 100
  return `${rounded} ${units[unit]}`
}

type TreeNode = {
  name: string
  kind: "dir" | "file"
  size: number
  files: number
  children: Map<string, TreeNode>
}

const makeDir = (name: string): TreeNode => ({ name, kind: "dir", size: 0, files: 0, children: new Map() })

function buildTree(files: readonly string[], sizes: ReadonlyMap<string, number>) {
  const root = makeDir("")
  for (const relative of files) {
    const segments = relative.split("/")
    let node = root
    for (const segment of segments.slice(0, -1)) {
      const next = node.children.get(segment) ?? makeDir(segment)
      node.children.set(segment, next)
      node = next
    }
    const name = segments.at(-1)
    if (!name) continue
    node.children.set(name, { name, kind: "file", size: sizes.get(relative) ?? 0, files: 1, children: new Map() })
  }
  const accumulate = (node: TreeNode): { files: number; size: number } => {
    let count = 0
    let size = 0
    for (const child of node.children.values()) {
      if (child.kind === "file") {
        count++
        size += child.size
        continue
      }
      const nested = accumulate(child)
      count += nested.files
      size += nested.size
    }
    node.files = count
    node.size = size
    return { files: count, size }
  }
  accumulate(root)
  return root
}

const topLevelRank = (name: string) => {
  if ((SOURCE_ROOTS as readonly string[]).includes(name)) return 0
  if (/^(test|tests|__tests__|spec)$/.test(name)) return 1
  if (/^docs?$/.test(name)) return 2
  return 3
}

function renderChildren(node: TreeNode, depth: number, prefix: string, budget: { n: number }) {
  const lines: string[] = []
  let moreFiles = 0
  let moreBytes = 0
  const entries = [...node.children.values()].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "dir" ? -1 : 1
    return left.name.localeCompare(right.name)
  })
  for (const child of entries) {
    if (budget.n <= 0) {
      moreFiles += child.files
      moreBytes += child.size
      continue
    }
    if (child.kind === "file") {
      lines.push(`${prefix}${child.name}  ${humanSize(child.size)}`)
      budget.n--
      continue
    }
    if (depth <= 0) {
      moreFiles += child.files
      moreBytes += child.size
      continue
    }
    lines.push(`${prefix}${child.name}/ (${child.files} files, ${humanSize(child.size)})`)
    budget.n--
    const nested = renderChildren(child, depth - 1, `${prefix}  `, budget)
    lines.push(...nested.lines)
    moreFiles += nested.moreFiles
    moreBytes += nested.moreBytes
  }
  if (moreFiles > 0) lines.push(`${prefix}… (${moreFiles} more files, ${humanSize(moreBytes)})`)
  return { lines, moreFiles, moreBytes }
}

export function tree(files: readonly string[], sizes: ReadonlyMap<string, number>, depth?: number, maxEntries?: number): TreeProjection {
  const root = buildTree(files, sizes)
  const boundedDepth = Math.min(Math.max(depth ?? DEFAULT_TREE_DEPTH, 1), MAX_TREE_DEPTH)
  const boundedEntries = Math.min(Math.max(maxEntries ?? DEFAULT_TREE_ENTRIES, 1), MAX_TREE_ENTRIES)
  const budget = { n: boundedEntries }
  const lines: string[] = []
  let moreFiles = 0
  let moreBytes = 0
  const dirs = [...root.children.values()]
    .filter((child) => child.kind === "dir")
    .sort((left, right) => topLevelRank(left.name) - topLevelRank(right.name) || left.name.localeCompare(right.name))
  const rootFiles = [...root.children.values()]
    .filter((child) => child.kind === "file")
    .sort((left, right) => left.name.localeCompare(right.name))
  for (const dir of dirs) {
    if (budget.n <= 0) {
      moreFiles += dir.files
      moreBytes += dir.size
      continue
    }
    lines.push(`${dir.name}/ (${dir.files} files, ${humanSize(dir.size)})`)
    budget.n--
    const nested = renderChildren(dir, boundedDepth - 1, "  ", budget)
    lines.push(...nested.lines)
    moreFiles += nested.moreFiles
    moreBytes += nested.moreBytes
  }
  for (const file of rootFiles) {
    if (budget.n <= 0) {
      moreFiles += file.files
      moreBytes += file.size
      continue
    }
    lines.push(`${file.name}  ${humanSize(file.size)}`)
    budget.n--
  }
  if (moreFiles > 0) lines.push(`… (${moreFiles} more files, ${humanSize(moreBytes)})`)
  return {
    lines,
    totalFiles: root.files,
    totalBytes: root.size,
    entries: lines.length,
    truncated: moreFiles > 0,
  }
}

export function relativeTime(ms: number): string {
  if (ms < 60_000) return "just now"
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  if (ms < 604_800_000) return `${Math.floor(ms / 86_400_000)}d ago`
  return `${Math.floor(ms / 604_800_000)}w ago`
}

const extensionOf = (relative: string) => {
  const base = path.posix.basename(relative)
  const dot = base.lastIndexOf(".")
  return dot > 0 ? base.slice(dot) : "(none)"
}

const readManifests = Effect.fn("ProjectInspection.manifests")(function* (scope: string, root: string) {
  const entries = yield* Effect.forEach(
    [...MANIFEST_NAMES],
    Effect.fnUntraced(function* (name: string) {
      let dir = scope
      while (true) {
        const result = yield* Effect.promise(() => manifestText(dir, name))
        if (result) return [name, result] as const
        if (dir === root) break
        const parent = path.dirname(dir)
        if (parent === dir || !isContained(root, parent)) break
        dir = parent
      }
      return [name, undefined] as const
    }),
    { concurrency: 4 },
  )
  return new Map(entries)
})

const isContained = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

export const inspect = Effect.fn("ProjectInspection.inspect")(function* (
  ripgrep: Ripgrep.Interface,
  input: {
    readonly root: string
    readonly scope?: string
    readonly signal?: AbortSignal
    readonly files?: readonly string[]
  },
) {
  const root = path.resolve(input.root)
  const scope = path.resolve(input.scope ?? root)
  if (!isContained(root, scope)) return yield* new InvalidInput({ message: `Project inspection scope escapes root: ${scope}` })
  const stat = yield* Effect.tryPromise(() => fs.stat(scope)).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (!stat) return yield* new InvalidInput({ message: `Project inspection path not found: ${scope}` })
  if (!stat.isDirectory()) return yield* new InvalidInput({ message: `Project inspection path is not a directory: ${scope}` })

  const listed = input.files
    ? input.files.slice(0, MAX_FILES + 1).map((path) => ({ path }))
    : yield* ripgrep.find({ cwd: root, pattern: "*", limit: MAX_FILES + 1, signal: input.signal })
  const allRelative = listed.map((entry) => String(entry.path).replaceAll("\\", "/"))
  const listTruncated = allRelative.length > MAX_FILES
  const rootFiles = listTruncated ? allRelative.slice(0, MAX_FILES) : allRelative
  const scopeRelativeNative = path.relative(root, scope)
  const scopeRelative = scopeRelativeNative ? scopeRelativeNative.replaceAll("\\", "/") : "."
  const prefix = scopeRelative === "." ? "" : `${scopeRelative}/`
  const files = prefix ? rootFiles.filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length)) : rootFiles

  let totalBytes = 0
  const sizes = new Map<string, number>()
  const byExt = new Map<string, { files: number; bytes: number }>()
  for (const relative of files) {
    if (input.signal?.aborted) break
    const info = yield* Effect.tryPromise(() => fs.stat(path.join(scope, relative))).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!info?.isFile()) continue
    sizes.set(relative, info.size)
    totalBytes += info.size
    const ext = extensionOf(relative)
    const bucket = byExt.get(ext) ?? { files: 0, bytes: 0 }
    bucket.files++
    bucket.bytes += info.size
    byExt.set(ext, bucket)
  }

  const manifests = yield* readManifests(scope, root)
  const notes: string[] = []
  for (const [name, result] of manifests) {
    if (result && "tooLarge" in result) notes.push(`${name} skipped: too large (${Math.round(result.tooLarge / 1024)} KB)`)
  }

  const fileSet = new Set(rootFiles)
  const scopedSet = new Set(files)
  const { stack, lockfile, versionPins } = detectStack(scopedSet, fileSet, manifests)
  const packageManifest = manifests.get("package.json")
  const scripts = annotateScripts(packageManifest && "text" in packageManifest ? packageManifest.text : undefined)
  const entryPoints = [...new Set([...(stack?.entryPoints ?? []), ...probeEntryPoints(scopedSet)])].slice(0, 10)
  const configs: Presence[] = []
  for (const [name, kind] of CONFIG_PROBES) if (fileSet.has(name)) configs.push({ path: name, kind })
  const rootEntries = yield* Effect.tryPromise(() => fs.readdir(root, { withFileTypes: true })).pipe(
    Effect.catch(() => Effect.succeed([] as import("node:fs").Dirent[])),
  )
  for (const entry of rootEntries) {
    if (!entry.isFile()) continue
    if (CONFIG_PATTERNS.some((regex) => regex.test(entry.name))) configs.push({ path: entry.name, kind: "config" })
    else if (entry.name.startsWith(".env")) configs.push({ path: entry.name, kind: "env" })
  }
  const ci: Presence[] = []
  for (const [name, kind] of CI_PROBES) if (fileSet.has(name)) ci.push({ path: name, kind })
  const workflows = yield* Effect.tryPromise(() => fs.readdir(path.join(root, ".github", "workflows"))).pipe(
    Effect.catch(() => Effect.succeed([] as string[])),
  )
  const workflowCount = workflows.filter((file) => /\.ya?ml$/.test(file)).length
  if (workflowCount > 0) ci.unshift({ path: `.github/workflows (${workflowCount} workflows)`, kind: "github" })

  const stats: FileStats = {
    files: files.length,
    totalBytes,
    byExt: [...byExt.entries()]
      .sort((a, b) => b[1].files - a[1].files || a[0].localeCompare(b[0]))
      .slice(0, 12)
      .map(([ext, bucket]) => ({ ext, ...bucket })),
  }
  return {
    root,
    scope,
    scopeRelative,
    rootFiles,
    files,
    sizes,
    listTruncated,
    manifests,
    stack,
    lockfile,
    versionPins,
    scripts,
    entryPoints,
    configs,
    ci,
    stats,
    notes,
  } satisfies Inspection
})

export const recent = Effect.fn("ProjectInspection.recent")(function* (
  root: string,
  files: readonly string[],
  limit = DEFAULT_RECENT,
  signal?: AbortSignal,
) {
  const capped = Math.min(Math.max(limit, 1), MAX_RECENT)
  const rows: Array<{ readonly path: string; readonly mtime: number }> = []
  for (const relative of files) {
    if (signal?.aborted) break
    const stat = yield* Effect.tryPromise(() => fs.stat(path.join(root, relative))).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (stat?.isFile()) rows.push({ path: relative, mtime: stat.mtimeMs })
  }
  return rows.sort((a, b) => b.mtime - a.mtime).slice(0, capped)
})

export * as ProjectInspection from "./inspection"
