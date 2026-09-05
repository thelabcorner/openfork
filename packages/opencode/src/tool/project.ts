import { Effect, Schema } from "effect"
import path from "path"
import fs from "node:fs/promises"
import * as Tool from "./tool"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { RipgrepBinary } from "@opencode-ai/core/ripgrep/binary"
import { AppProcess } from "@opencode-ai/core/process"
import { ChildProcess } from "effect/unstable/process"
import { which } from "@opencode-ai/core/util/which"
import DESCRIPTION from "./project.txt"

export const Parameters = Schema.Struct({
  action: Schema.optional(Schema.Literals(["snapshot", "summary", "recent", "toolchain"])).annotate({
    description:
      "What to run (default snapshot). snapshot = tier snapshot of the project; summary = alias for snapshot with the summary tier; recent = N most recently modified files (what is being worked on); toolchain = installed runtimes + versions, PATH resolution, key env vars.",
  }),
  tier: Schema.optional(Schema.Literals(["summary", "structure", "full"])).annotate({
    description:
      "Detail level (default summary). summary = lean stack+scripts+entry+stats one-liners; structure = adds bounded tree with sizes; full = everything + annotated scripts + config/CI lists.",
  }),
  path: Schema.optional(Schema.String).annotate({
    description: "Subdirectory to scope the snapshot to (default: project root). Relative to the working directory.",
  }),
  depth: Schema.optional(Schema.Int).annotate({
    description: "Tree depth for structure/full tiers (default 3, max 5)",
  }),
  maxEntries: Schema.optional(Schema.Int).annotate({ description: "Tree/entry cap (default 200, max 500)" }),
  recent: Schema.optional(Schema.Int).annotate({
    description:
      "recent action: how many files to list (default 15, max 50). Newest mtime first, grouped by directory, relative timestamps.",
  }),
})

type Metadata = {
  tier: string
  path: string
  files: number
  truncated: boolean
  preview: string
  recent?: number
  git?: boolean
}

// ---- bounds ----
const MAX_MANIFEST_BYTES = 256_000
const MAX_TREE_FILES = 20_000
const DEFAULT_TREE_DEPTH = 3
const MAX_TREE_DEPTH = 5
const DEFAULT_TREE_ENTRIES = 200
const MAX_TREE_ENTRIES = 500
const MAX_LOC_FILES = 2000
const LOC_ARGV_CHUNK = 200
const MAX_SCRIPTS = 40
const MAX_SCRIPT_CMD = 120
const MAX_REQ_DEPS = 50
const MAX_GO_DEPS = 20
const MAX_RECENT_DEFAULT = 15
const MAX_RECENT = 50
const MAX_GIT_STATUS_LINES = 200

// Files whose bodies the tool is allowed to open. Everything else is listed by
// ripgrep and measured by fs.stat only — never read. The verifier's hard rail:
// `readFile` appears only in `manifestText`, and only for names in this set.
const MANIFEST_NAMES = new Set([
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

const SOURCE_ROOTS = ["src", "lib", "app", "cmd", "packages", "crates"]

const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

// Human-readable size, e.g. 123456 -> "121 KB".
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  const rounded =
    value >= 100 ? Math.round(value) : value >= 10 ? Math.round(value * 10) / 10 : Math.round(value * 100) / 100
  return `${rounded} ${units[unit]}`
}

const estLoc = (count: number) => `~${count.toLocaleString("en-US")}`

// ---- manifest reads (the ONLY file-body access in this tool) ----

type ManifestResult = { text: string } | { tooLarge: number } | undefined

async function manifestText(dir: string, name: string): Promise<ManifestResult> {
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

// ---- stack detection ----

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

type StackInfo = {
  ecosystem: string
  monorepo: boolean
  packageManager?: string
  lockfile?: string
  frameworks: string[]
  deps: string[]
  entryPoints: string[]
  runtimeVersion?: string
  versionKind?: string
  notes: string[]
}

// Section-scoped TOML helper: returns lines under the named table, e.g.
// sectionLines("tool.poetry.dependencies", text) after "[tool.poetry.dependencies]".
function sectionLines(section: string, text: string): string[] {
  const re = new RegExp(`^\\[${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`, "m")
  const start = re.exec(text)?.[0]
  if (!start) return []
  const from = text.indexOf(start) + start.length
  const rest = text.slice(from)
  const next = /^\[/m.exec(rest)
  return rest.slice(0, next?.index ?? rest.length).split("\n")
}

// Presence probes for well-known entry points (design §4.6). Runs regardless
// of which (if any) stack was detected. `rel` is checked plus its basename so
// scoped analyses (path param) still resolve e.g. main.ts inside src/.
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

function probeEntryPoints(files: ReadonlySet<string>): string[] {
  const out: string[] = []
  for (const [rel, base] of ENTRY_PROBES) {
    if (files.has(rel)) out.push(rel)
    else if (files.has(base)) out.push(base)
  }
  for (const f of files) {
    if (f.startsWith("cmd/") && f.endsWith("/main.go")) {
      out.push(f)
      if (out.length >= 10) break
    }
  }
  return [...new Set(out)].slice(0, 10)
}

// ---- git / worktree awareness + recent files + init + toolchain ----

// Relative "N ago" timestamps, e.g. 2m ago / 1h ago / 3d ago.
function relativeTime(ms: number): string {
  if (ms < 60_000) return "just now"
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  if (ms < 604_800_000) return `${Math.floor(ms / 86_400_000)}d ago`
  return `${Math.floor(ms / 604_800_000)}w ago`
}

const GIT_SAFE_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  PAGER: "cat",
  LC_ALL: "C",
}

const GIT_ARGS = ["--no-pager", "--no-optional-locks", "-c", "color.ui=false", "-c", "core.quotepath=false"] as const

// Probe runtimes/versions for the toolchain action. Order matters for the
// reported list; each entry is (label, [binary, ...candidates], versionFlag).
const RUNTIME_PROBES: ReadonlyArray<{ name: string; binaries: string[]; flag: string }> = [
  { name: "bun", binaries: ["bun"], flag: "--version" },
  { name: "node", binaries: ["node"], flag: "--version" },
  { name: "npm", binaries: ["npm"], flag: "--version" },
  { name: "pnpm", binaries: ["pnpm"], flag: "--version" },
  { name: "yarn", binaries: ["yarn"], flag: "--version" },
  { name: "python", binaries: ["python", "python3"], flag: "--version" },
  { name: "go", binaries: ["go"], flag: "version" },
  { name: "rustc", binaries: ["rustc"], flag: "--version" },
]

// Key env vars surfaced in the toolchain action. Keep it to non-secret,
// project-relevant vars only — never auth tokens or credentials.
const TOOLCHAIN_ENV: ReadonlyArray<[string, string]> = [
  ["PATH", "first entry of $PATH"],
  ["NODE_ENV", "node environment"],
  ["CI", "CI detection"],
  ["VIRTUAL_ENV", "python virtualenv"],
  ["GOPATH", "go workspace"],
  ["CARGO_HOME", "cargo home"],
  ["BUN_INSTALL", "bun install dir"],
]

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
  for (const key of ["main", "module"] as const) {
    if (typeof pkg[key] === "string") entryPoints.push(pkg[key] as string)
  }
  const bin = pkg.bin
  if (typeof bin === "string") entryPoints.push(bin)
  else if (bin && typeof bin === "object") {
    entryPoints.push(...Object.values(bin).filter((v): v is string => typeof v === "string"))
  }
  for (const rel of [
    "src/main.ts",
    "src/main.js",
    "src/main.tsx",
    "src/index.ts",
    "src/index.js",
    "index.js",
    "index.ts",
  ]) {
    if (files.has(rel)) entryPoints.push(rel)
  }
  const enginesNode =
    engines && typeof engines === "object" && "node" in engines && typeof engines.node === "string"
      ? engines.node
      : undefined
  return {
    ecosystem: "node",
    monorepo,
    packageManager: typeof pkg.packageManager === "string" ? (pkg.packageManager as string) : undefined,
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
  const depSections = ["project", "project.dependencies", "tool.poetry.dependencies", "project.optional-dependencies"]
  for (const section of depSections) {
    for (const line of sectionLines(section, text)) {
      // quoted array items like "fastapi", or key = "value" entries
      const m = /^\s*"?([a-zA-Z0-9_.-]+)"?\s*(?:,|=|>|<|~|\[|$)/.exec(line.trim())
      if (m && m[1] !== "name" && m[1] !== "requires-python" && m[1] !== "dependencies") deps.add(m[1]!)
    }
  }
  const tools: string[] = []
  if (text.includes("[tool.poetry]")) tools.push("Poetry")
  if (text.includes("[tool.uv]")) tools.push("uv")
  if (text.includes("[tool.ruff]")) tools.push("Ruff")
  if (text.includes("[tool.black]")) tools.push("Black")
  const entryPoints: string[] = []
  for (const rel of ["src/main.py", "main.py", "app.py", "manage.py", "bot.py"]) {
    if (files.has(rel)) entryPoints.push(rel)
  }
  const notes: string[] = []
  if (projectName) notes.push(`project=${projectName}`)
  return {
    ecosystem: "python",
    monorepo: false,
    frameworks: [...matchFrameworks(deps, PY_FRAMEWORKS), ...tools].slice(0, 3),
    deps: [...deps].slice(0, MAX_REQ_DEPS),
    entryPoints: entryPoints.slice(0, 10),
    runtimeVersion: requiresPython,
    versionKind: requiresPython ? "python" : undefined,
    notes,
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
    const m = /^([a-zA-Z0-9_-]+)\s*=/.exec(line.trim())
    if (m) deps.add(m[1]!)
  }
  const entryPoints: string[] = []
  for (const rel of ["src/main.rs", "src/lib.rs", "main.rs"]) {
    if (files.has(rel)) entryPoints.push(rel)
  }
  const notes: string[] = []
  if (crateName) notes.push(`crate=${crateName}`)
  return {
    ecosystem: "rust",
    monorepo: text.includes("[workspace]"),
    frameworks: matchFrameworks(deps, RUST_FRAMEWORKS),
    deps: [...deps].slice(0, MAX_REQ_DEPS),
    entryPoints: entryPoints.slice(0, 10),
    runtimeVersion: edition,
    versionKind: edition ? "edition" : undefined,
    notes,
  }
}

function detectGo(text: string | undefined, files: ReadonlySet<string>): StackInfo | undefined {
  if (text === undefined) return undefined
  const moduleName = /^module\s+(\S+)/m.exec(text)?.[1]
  if (moduleName === undefined) return undefined
  const goVersion = /^go\s+([0-9.]+)/m.exec(text)?.[1]
  const deps = new Set<string>()
  const requireBlock = /^require\s*\(([\s\S]*?)\)/m.exec(text)
  if (requireBlock) {
    for (const m of requireBlock[1]!.matchAll(/^(\S+)\s+v/gm)) deps.add(m[1]!)
  } else {
    for (const m of text.matchAll(/^require\s+(\S+)/gm)) deps.add(m[1]!)
  }
  const entryPoints: string[] = []
  if (files.has("main.go")) entryPoints.push("main.go")
  for (const f of files) {
    if (f.startsWith("cmd/") && f.endsWith("/main.go")) {
      entryPoints.push(f)
      if (entryPoints.length >= 10) break
    }
  }
  const notes: string[] = []
  if (moduleName) notes.push(`module=${moduleName}`)
  return {
    ecosystem: "go",
    monorepo: false,
    frameworks: [],
    deps: [...deps].slice(0, MAX_GO_DEPS),
    entryPoints,
    runtimeVersion: goVersion,
    versionKind: goVersion ? "go" : undefined,
    notes,
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
  const notes: string[] = []
  if (groupId) notes.push(`groupId=${groupId}`)
  return {
    ecosystem: "java",
    monorepo: false,
    frameworks: frameworks.slice(0, 3),
    deps: [],
    entryPoints: [],
    notes,
  }
}

function detectRuby(text: string | undefined): StackInfo | undefined {
  if (text === undefined) return undefined
  const gems = new Set<string>()
  for (const m of text.matchAll(/^\s*gem\s+["']([^"']+)["']/gm)) gems.add(m[1]!)
  if (gems.size === 0) return undefined
  const frameworks: string[] = []
  if (gems.has("rails")) frameworks.push("Rails")
  if (gems.has("sinatra")) frameworks.push("Sinatra")
  if (gems.has("rspec")) frameworks.push("RSpec")
  return {
    ecosystem: "ruby",
    monorepo: false,
    frameworks: frameworks.slice(0, 3),
    deps: [...gems].slice(0, MAX_REQ_DEPS),
    entryPoints: [],
    notes: [],
  }
}

function detectPhp(text: string | undefined): StackInfo | undefined {
  const composer = jsonObject(text)
  if (!composer) return undefined
  const require = composer.require
  if (!require || typeof require !== "object") return undefined
  const deps = Object.keys(require)
  const frameworks: string[] = []
  if (deps.includes("laravel/framework")) frameworks.push("Laravel")
  if (deps.some((d) => d.startsWith("symfony/"))) frameworks.push("Symfony")
  return {
    ecosystem: "php",
    monorepo: false,
    frameworks: frameworks.slice(0, 3),
    deps: deps.slice(0, MAX_REQ_DEPS),
    entryPoints: [],
    notes: [],
  }
}

const LOCKFILES: ReadonlyArray<[string, string]> = [
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

const CONFIG_PROBES: ReadonlyArray<[string, string]> = [
  ["tsconfig.json", "tsconfig"],
  ["jsconfig.json", "jsconfig"],
  [".editorconfig", "editorconfig"],
  ["Dockerfile", "dockerfile"],
  [".dockerignore", "dockerignore"],
]

const CI_PROBES: ReadonlyArray<[string, string]> = [
  [".gitlab-ci.yml", "gitlab-ci"],
  [".circleci/config.yml", "circleci"],
  ["Jenkinsfile", "jenkins"],
  ["azure-pipelines.yml", "azure-pipelines"],
  ["appveyor.yml", "appveyor"],
  [".buildkite/pipeline.yml", "buildkite"],
  ["bitbucket-pipelines.yml", "bitbucket-pipelines"],
  [".travis.yml", "travis"],
]

// ---- scripts annotation ----

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

const classifyScript = (name: string): string => {
  for (const [re, category] of SCRIPT_CATEGORIES) {
    if (re.test(name)) return category
  }
  return "other"
}

const LIFECYCLE = new Set(["preinstall", "postinstall", "prepare"])

function annotateScripts(text: string | undefined): Array<{ name: string; category: string; cmd: string }> | undefined {
  const pkg = jsonObject(text)
  const scripts = pkg?.scripts
  if (!scripts || typeof scripts !== "object") return undefined
  return Object.entries(scripts as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .slice(0, MAX_SCRIPTS)
    .map(([name, cmd]) => ({
      name,
      category: LIFECYCLE.has(name) ? "lifecycle" : classifyScript(name),
      cmd: cmd.length > MAX_SCRIPT_CMD ? `${cmd.slice(0, MAX_SCRIPT_CMD)}…` : cmd,
    }))
}

// ---- tree ----

type TreeNode = {
  name: string
  kind: "dir" | "file"
  size: number
  files: number
  children: Map<string, TreeNode>
}

const makeDir = (name: string): TreeNode => ({ name, kind: "dir", size: 0, files: 0, children: new Map() })

// Build a full tree (no depth cap — the cap is applied at render time) from
// posix-relative paths + sizes. Every dir's files/size = sum of its subtree.
function buildTree(
  relPaths: ReadonlyArray<string>,
  sizes: ReadonlyMap<string, number>,
): { root: TreeNode; totalFiles: number; totalBytes: number } {
  const root = makeDir("")
  let totalFiles = 0
  let totalBytes = 0
  for (const rel of relPaths) {
    const segs = rel.split("/")
    let node = root
    for (const seg of segs.slice(0, -1)) {
      const next = node.children.get(seg) ?? makeDir(seg)
      node.children.set(seg, next)
      node = next
    }
    const size = sizes.get(rel) ?? 0
    node.children.set(segs.at(-1)!, { name: segs.at(-1)!, kind: "file", size, files: 1, children: new Map() })
    totalFiles++
    totalBytes += size
  }
  // accumulate subtree counts/sizes bottom-up
  const accumulate = (node: TreeNode): { files: number; size: number } => {
    let files = 0
    let size = 0
    for (const child of node.children.values()) {
      if (child.kind === "file") {
        files += 1
        size += child.size
      } else {
        const sub = accumulate(child)
        files += sub.files
        size += sub.size
      }
    }
    node.files = files
    node.size = size
    return { files, size }
  }
  accumulate(root)
  return { root, totalFiles, totalBytes }
}

const isSourceRoot = (name: string) => SOURCE_ROOTS.includes(name)

// Importance ordering for top-level dirs: source roots first, then tests, then docs, then the rest.
const topLevelRank = (name: string): number => {
  if (isSourceRoot(name)) return 0
  if (/^(test|tests|__tests__|spec)$/.test(name)) return 1
  if (/^docs?$/.test(name)) return 2
  return 3
}

type Budget = { n: number }

// Render a node's children recursively. `depth` bounds recursion (0 = only this
// level's own files are shown; deeper entries roll into a "… more" line).
// `budget` is shared across the whole tree (maxEntries cap).
function renderChildren(
  node: TreeNode,
  depth: number,
  prefix: string,
  budget: Budget,
): { lines: string[]; moreFiles: number; moreBytes: number } {
  const lines: string[] = []
  let moreFiles = 0
  let moreBytes = 0
  const entries = [...node.children.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1
    return a.name.localeCompare(b.name)
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
    const sub = renderChildren(child, depth - 1, `${prefix}  `, budget)
    lines.push(...sub.lines)
    moreFiles += sub.moreFiles
    moreBytes += sub.moreBytes
  }
  if (moreFiles > 0) {
    lines.push(`${prefix}… (${moreFiles} more files, ${humanSize(moreBytes)})`)
  }
  return { lines, moreFiles, moreBytes }
}

function renderTree(
  root: TreeNode,
  depth: number,
  maxEntries: number,
): { lines: string[]; totalFiles: number; totalBytes: number; entries: number; truncated: boolean } {
  const budget: Budget = { n: maxEntries }
  const lines: string[] = []
  let moreFiles = 0
  let moreBytes = 0
  const dirs = [...root.children.values()]
    .filter((c) => c.kind === "dir")
    .sort((a, b) => topLevelRank(a.name) - topLevelRank(b.name) || a.name.localeCompare(b.name))
  const files = [...root.children.values()]
    .filter((c) => c.kind === "file")
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const dir of dirs) {
    if (budget.n <= 0) {
      moreFiles += dir.files
      moreBytes += dir.size
      continue
    }
    lines.push(`${dir.name}/ (${dir.files} files, ${humanSize(dir.size)})`)
    budget.n--
    const sub = renderChildren(dir, depth - 1, "  ", budget)
    lines.push(...sub.lines)
    moreFiles += sub.moreFiles
    moreBytes += sub.moreBytes
  }
  for (const file of files) {
    if (budget.n <= 0) {
      moreFiles += file.files
      moreBytes += file.size
      continue
    }
    lines.push(`${file.name}  ${humanSize(file.size)}`)
    budget.n--
  }
  if (moreFiles > 0) {
    lines.push(`… (${moreFiles} more files, ${humanSize(moreBytes)})`)
  }
  return {
    lines,
    totalFiles: root.files,
    totalBytes: root.size,
    entries: lines.length,
    truncated: moreFiles > 0,
  }
}

// ---- stats ----

const extensionOf = (rel: string): string => {
  const base = path.posix.basename(rel)
  const dot = base.lastIndexOf(".")
  if (dot <= 0) return "(none)"
  return base.slice(dot)
}

const LOC_RE = /^([^:]+):(\d+)$/

function parseLocLines(output: string): Map<string, number> {
  const map = new Map<string, number>()
  for (const line of output.split("\n")) {
    const m = LOC_RE.exec(line.trim())
    if (!m) continue
    const rel = m[1]!.replace(/^\.\//, "").replace(/\\/g, "/")
    map.set(rel, Number(m[2]))
  }
  return map
}

// ---- entry/config/CI presence ----

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

type Presence = { path: string; kind: string }

export const ProjectTool = Tool.define<
  typeof Parameters,
  Metadata,
  Ripgrep.Service | RipgrepBinary.Service | AppProcess.Service
>(
  "project",
  Effect.gen(function* () {
    const ripgrep = yield* Ripgrep.Service
    const binary = yield* RipgrepBinary.Service
    const app = yield* AppProcess.Service
    const rgPath = yield* binary.filepath.pipe(Effect.orDie)

    const listFiles = Effect.fn("ProjectTool.listFiles")(function* (cwd: string, limit: number, signal: AbortSignal) {
      return yield* ripgrep
        .find({ cwd, pattern: "*", limit, signal })
        .pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<{ path: string }>)))
    })

    const readSizes = Effect.fn("ProjectTool.sizes")(function* (
      cwd: string,
      files: ReadonlyArray<string>,
      signal: AbortSignal,
    ) {
      const out = new Map<string, number>()
      const mtimes = new Map<string, number>()
      for (const rel of files) {
        if (signal.aborted) break
        const stat = yield* Effect.tryPromise(() => fs.stat(path.join(cwd, rel))).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        )
        if (stat?.isFile()) {
          out.set(rel, stat.size)
          mtimes.set(rel, stat.mtimeMs)
        }
      }
      return { sizes: out, mtimes }
    })

    const countLoc = Effect.fn("ProjectTool.countLoc")(function* (
      cwd: string,
      sample: ReadonlyArray<string>,
      signal: AbortSignal,
    ) {
      const loc = new Map<string, number>()
      for (let i = 0; i < sample.length; i += LOC_ARGV_CHUNK) {
        if (signal.aborted) break
        const chunk = sample.slice(i, i + LOC_ARGV_CHUNK)
        const result = yield* app
          .run(
            ChildProcess.make(rgPath, ["--no-config", "--count-matches", "^", ...chunk], {
              cwd,
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
            }),
            { maxOutputBytes: 4_000_000, timeout: "30 seconds", signal },
          )
          .pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!result || result.exitCode === 2) continue
        for (const [rel, count] of parseLocLines(result.stdout.toString("utf8"))) {
          loc.set(rel, count)
        }
      }
      return loc
    })

    const computeStats = Effect.fn("ProjectTool.stats")(function* (
      cwd: string,
      files: ReadonlyArray<string>,
      sizeMap: ReadonlyMap<string, number>,
      signal: AbortSignal,
    ) {
      const totalBytes = files.reduce((sum, rel) => sum + (sizeMap.get(rel) ?? 0), 0)
      const byExt = new Map<string, { files: number; loc: number }>()
      for (const rel of files) {
        const ext = extensionOf(rel)
        const bucket = byExt.get(ext) ?? { files: 0, loc: 0 }
        bucket.files++
        byExt.set(ext, bucket)
      }
      // LOC: sample the largest files (by stat size) up to MAX_LOC_FILES.
      const sample = [...files].sort((a, b) => (sizeMap.get(b) ?? 0) - (sizeMap.get(a) ?? 0)).slice(0, MAX_LOC_FILES)
      const loc = yield* countLoc(cwd, sample, signal)
      let locTotal = 0
      for (const [rel, count] of loc) {
        locTotal += count
        const ext = extensionOf(rel)
        const bucket = byExt.get(ext)
        if (bucket) bucket.loc += count
      }
      const locEstimated = sample.length < files.length
      if (locEstimated && sample.length > 0) {
        locTotal += Math.round((locTotal / sample.length) * (files.length - sample.length))
      }
      const byType = [...byExt.entries()]
        .sort((a, b) => b[1].files - a[1].files || a[0].localeCompare(b[0]))
        .slice(0, 12)
        .map(([ext, bucket]) => ({ ext, files: bucket.files, loc: bucket.loc > 0 ? bucket.loc : undefined }))
      return { files: files.length, loc: locTotal, locSampled: loc.size, locEstimated, totalBytes, byExt: byType }
    })

    const detectStack = Effect.fn("ProjectTool.detectStack")(function* (
      dir: string,
      files: ReadonlySet<string>,
      rootFiles: ReadonlySet<string>,
      manifests: ReadonlyMap<string, ManifestResult>,
    ) {
      const text = (name: string) => {
        const r = manifests.get(name)
        return r && "text" in r ? r.text : undefined
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

      // lockfile: presence via the file list (lockfiles are never read). Check
      // both the root-relative set (repo-root lockfiles) and the scope view.
      let lockfile: string | undefined
      for (const [name, kind] of LOCKFILES) {
        if (rootFiles.has(name) || files.has(name)) {
          lockfile = kind
          break
        }
      }
      const versionPins: Array<[string, string]> = []
      for (const name of [".nvmrc", ".node-version", ".python-version", ".tool-versions", ".ruby-version"]) {
        const r = manifests.get(name)
        if (r && "text" in r) {
          const line = r.text.split("\n")[0]?.trim()
          if (line) versionPins.push([name, line])
        }
      }
      return { stack, lockfile, versionPins }
    })

    const detectGit = Effect.fn("ProjectTool.detectGit")(function* (cwd: string, signal: AbortSignal) {
      const run = Effect.fnUntraced(function* (args: string[]) {
        const result = yield* app
          .run(
            ChildProcess.make("git", [...GIT_ARGS, ...args], {
              cwd,
              env: GIT_SAFE_ENV,
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
            }),
            {
              maxOutputBytes: 300_000,
              timeout: "10 seconds",
              signal,
            },
          )
          .pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!result) return undefined
        return {
          exitCode: result.exitCode,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        }
      })
      const top = yield* run(["rev-parse", "--show-toplevel"])
      if (!top || top.exitCode !== 0) return undefined
      const root = top.stdout.trim()
      const [common, branch, porcelain] = yield* Effect.all([
        run(["rev-parse", "--git-common-dir"]),
        run(["branch", "--show-current"]),
        run(["status", "--porcelain"]),
      ])
      const commonDir = common?.stdout.trim()
      const linkedWorktree =
        commonDir !== undefined && commonDir !== "" && commonDir !== ".git" && !commonDir.startsWith(root)
      const changed = porcelain ? porcelain.stdout.split("\n").filter((l) => l.trim() !== "").length : 0
      return {
        root,
        branch: branch?.stdout.trim() || undefined,
        linkedWorktree,
        changed: Math.min(changed, MAX_GIT_STATUS_LINES),
      }
    })

    const listRecent = Effect.fn("ProjectTool.listRecent")(function* (
      files: ReadonlyArray<string>,
      mtimes: ReadonlyMap<string, number>,
      limit: number,
    ) {
      const now = Date.now()
      const rows = files
        .filter((rel) => mtimes.has(rel))
        .map((rel) => ({ rel, mtime: mtimes.get(rel)! }))
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, limit)
      const grouped = new Map<string, Array<{ rel: string; mtime: number }>>()
      for (const row of rows) {
        const dir = row.rel.includes("/") ? row.rel.slice(0, row.rel.lastIndexOf("/")) : "."
        const bucket = grouped.get(dir) ?? []
        bucket.push(row)
        grouped.set(dir, bucket)
      }
      return { rows, grouped, now }
    })

    const probeToolchain = Effect.fn("ProjectTool.probeToolchain")(function* (signal: AbortSignal) {
      const run = Effect.fnUntraced(function* (cmd: string, flag: string) {
        const result = yield* app
          .run(ChildProcess.make(cmd, [flag], { env: {}, stdin: "ignore", stdout: "pipe", stderr: "pipe" }), {
            maxOutputBytes: 4_000,
            timeout: "5 seconds",
            signal,
          })
          .pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!result) return undefined
        return {
          exitCode: result.exitCode,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        }
      })
      const runtimes: Array<{ name: string; version?: string; path?: string }> = []
      for (const probe of RUNTIME_PROBES) {
        let version: string | undefined
        let binaryPath: string | undefined
        for (const binary of probe.binaries) {
          const found = which(binary)
          const result = yield* run(binary, probe.flag)
          if (result && result.exitCode === 0) {
            version = (result.stdout || result.stderr).split("\n")[0]?.trim() || undefined
            if (found) binaryPath = found
            break
          }
        }
        if (version || binaryPath) runtimes.push({ name: probe.name, version, path: binaryPath })
      }
      const env: Array<{ name: string; value?: string; hint: string }> = []
      for (const [name, hint] of TOOLCHAIN_ENV) {
        const value = process.env[name]
        if (value !== undefined) {
          env.push({ name, value: name === "PATH" ? value.split(path.delimiter)[0] : value, hint })
        }
      }
      return { runtimes, env }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const tier = params.action === "summary" ? "summary" : (params.tier ?? "summary")
          // Accept the natural-language action alias while keeping one snapshot path.
          const action = params.action === "summary" ? "snapshot" : (params.action ?? "snapshot")
          const scope = params.path
            ? path.isAbsolute(params.path)
              ? params.path
              : path.join(instance.directory, params.path)
            : instance.directory
          const normalized = process.platform === "win32" ? FSUtil.normalizePath(scope) : scope
          // Non-git projects set worktree to "/", which makes path.relative
          // drive-root-relative and meaningless — fall back to the directory.
          const base = instance.worktree === "/" ? instance.directory : instance.worktree
          const scopeRel = path.relative(base, normalized) || "."
          if (scopeRel.startsWith("..") || path.isAbsolute(scopeRel)) {
            throw new Error(`Refusing to analyze path outside the worktree: ${normalized}`)
          }
          yield* ctx.ask({
            permission: "read",
            patterns: [scopeRel],
            always: [scopeRel],
            metadata: { tier, path: params.path ?? ".", ...(action !== "snapshot" ? { action } : {}) },
          })
          yield* assertExternalDirectoryEffect(ctx, normalized, { kind: "directory" })

          const stat = yield* Effect.tryPromise(() => fs.stat(normalized)).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          )
          if (!stat) throw new Error(`Path not found: ${normalized}`)
          if (!stat.isDirectory()) throw new Error(`Path is not a directory: ${normalized}`)

          const depth = Math.min(Math.max(params.depth ?? DEFAULT_TREE_DEPTH, 1), MAX_TREE_DEPTH)
          const maxEntries = Math.min(Math.max(params.maxEntries ?? DEFAULT_TREE_ENTRIES, 1), MAX_TREE_ENTRIES)

          // List files from the worktree root (gitignore-aware via ripgrep) so
          // paths stay root-relative — entry/config/CI/lockfile probes rely on
          // that even when the snapshot is scoped to a subdirectory.
          const listed = yield* listFiles(base, MAX_TREE_FILES + 1, ctx.abort)
          const allRel = listed.map((f) => f.path)
          const listTruncated = allRel.length > MAX_TREE_FILES
          const rootPaths = listTruncated ? allRel.slice(0, MAX_TREE_FILES) : allRel
          const fileSet = new Set(rootPaths)

          const git = yield* detectGit(base, ctx.abort)

          // recent: N most recently modified files (project-wide, gitignored)
          if (action === "recent") {
            const limit = Math.min(Math.max(params.recent ?? MAX_RECENT_DEFAULT, 1), MAX_RECENT)
            const rootMtimes = yield* readSizes(base, rootPaths, ctx.abort)
            const { rows, grouped, now } = yield* listRecent(rootPaths, rootMtimes.mtimes, limit)
            const lines = [`<recent count="${rows.length}" total="${rootPaths.length}">`]
            for (const [dir, bucket] of grouped) {
              lines.push(`  <dir path="${escapeXml(dir)}">`)
              for (const row of bucket) {
                lines.push(`    <file path="${escapeXml(row.rel)}" modified="${relativeTime(now - row.mtime)}" />`)
              }
              lines.push("  </dir>")
            }
            if (rows.length === 0) lines.push("  <note>no files found (empty or all-ignored project)</note>")
            lines.push("</recent>")
            const output = lines.join("\n")
            return {
              title: scopeRel === "." ? "recent" : `${scopeRel} (recent)`,
              output,
              metadata: {
                tier: "recent",
                path: scopeRel,
                files: rows.length,
                truncated: rows.length < rootPaths.length,
                preview: output.slice(0, 500),
                recent: rows.length,
                git: git !== undefined,
              },
            }
          }

          // toolchain: installed runtimes + versions + env snapshot
          if (action === "toolchain") {
            const { runtimes, env } = yield* probeToolchain(ctx.abort)
            const lines = [
              `<toolchain git="${git !== undefined}" root="${escapeXml(git?.root ?? base)}">`,
              ...runtimes.map(
                (r) =>
                  `  <runtime name="${escapeXml(r.name)}"${r.version ? ` version="${escapeXml(r.version)}"` : ""}${r.path ? ` path="${escapeXml(r.path)}"` : ""} />`,
              ),
              ...env.map(
                (e) =>
                  `  <env name="${escapeXml(e.name)}" value="${escapeXml(e.value ?? "")}" hint="${escapeXml(e.hint)}" />`,
              ),
              "</toolchain>",
            ]
            const output = lines.join("\n")
            return {
              title: "toolchain",
              output,
              metadata: {
                tier: "toolchain",
                path: scopeRel,
                files: runtimes.length,
                truncated: false,
                preview: output.slice(0, 500),
                git: git !== undefined,
              },
            }
          }

          // scope-relative view for the tree + stats
          const prefix = scopeRel === "." ? "" : `${scopeRel.split(path.sep).join("/")}/`
          const scopedPaths = prefix
            ? rootPaths.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length))
            : rootPaths

          const { sizes: sizeMap } = yield* readSizes(normalized, scopedPaths, ctx.abort)

          // Manifest reads: walk up from the scope to the worktree root so a
          // scoped snapshot still sees the repo's manifests (nearest wins).
          const manifestEntries = yield* Effect.forEach(
            [...MANIFEST_NAMES],
            Effect.fnUntraced(function* (name: string) {
              let dir = normalized
              while (true) {
                const r = yield* Effect.promise(() => manifestText(dir, name))
                if (r) return [name, r] as const
                if (dir === base) break
                const parent = path.dirname(dir)
                if (parent === dir) break
                dir = parent
              }
              return [name, undefined] as const
            }),
            { concurrency: 4 },
          )
          const manifests = new Map(manifestEntries)
          const notes: string[] = []
          for (const [name, r] of manifests) {
            if (r && "tooLarge" in r) {
              notes.push(`${name} skipped: too large (${Math.round(r.tooLarge / 1024)} KB)`)
            }
          }

          const { stack, lockfile, versionPins } = yield* detectStack(
            normalized,
            new Set(scopedPaths),
            fileSet,
            manifests,
          )

          const pkgManifest = manifests.get("package.json")
          const scripts = annotateScripts(pkgManifest && "text" in pkgManifest ? pkgManifest.text : undefined)

          // entry/config/CI presence (root-relative probes)
          const entryPoints = [...new Set([...(stack?.entryPoints ?? []), ...probeEntryPoints(fileSet)])].slice(0, 10)
          const configs: Presence[] = []
          for (const [name, kind] of CONFIG_PROBES) {
            if (fileSet.has(name)) configs.push({ path: name, kind })
          }
          const rootEntries = yield* Effect.tryPromise(() => fs.readdir(base, { withFileTypes: true })).pipe(
            Effect.catch(() => Effect.succeed([] as import("node:fs").Dirent[])),
          )
          for (const entry of rootEntries) {
            if (!entry.isFile()) continue
            if (CONFIG_PATTERNS.some((re) => re.test(entry.name))) configs.push({ path: entry.name, kind: "config" })
            else if (entry.name.startsWith(".env")) configs.push({ path: entry.name, kind: "env" })
          }
          const ci: Presence[] = []
          for (const [name, kind] of CI_PROBES) {
            if (fileSet.has(name)) ci.push({ path: name, kind })
          }
          const workflowsDir = path.join(base, ".github", "workflows")
          const workflowFiles = yield* Effect.tryPromise(() => fs.readdir(workflowsDir)).pipe(
            Effect.catch(() => Effect.succeed([] as string[])),
          )
          const workflowCount = workflowFiles.filter((f) => /\.ya?ml$/.test(f)).length
          if (workflowCount > 0) ci.unshift({ path: `.github/workflows (${workflowCount} workflows)`, kind: "github" })

          const statsInfo = yield* computeStats(normalized, scopedPaths, sizeMap, ctx.abort)

          const stackXml = () => {
            const attrs = [`ecosystem="${escapeXml(stack?.ecosystem ?? "unknown")}"`]
            if (stack?.monorepo) attrs.push(`monorepo="true"`)
            if (stack?.packageManager) attrs.push(`packageManager="${escapeXml(stack.packageManager)}"`)
            if (lockfile) attrs.push(`lockfile="${escapeXml(lockfile)}"`)
            const lines = [`<stack ${attrs.join(" ")}>`]
            for (const fw of stack?.frameworks ?? []) lines.push(`  <framework name="${escapeXml(fw)}" />`)
            if (entryPoints.length) lines.push(`  <entry points="${escapeXml(entryPoints.slice(0, 5).join(", "))}" />`)
            if (ci.length) lines.push(`  <ci ${ci.map((c) => `${c.kind}="${escapeXml(c.path)}"`).join(" ")} />`)
            if (stack?.runtimeVersion)
              lines.push(
                `  <version kind="${escapeXml(stack.versionKind ?? "runtime")}" value="${escapeXml(stack.runtimeVersion)}" />`,
              )
            for (const [name, value] of versionPins)
              lines.push(`  <version kind="${escapeXml(name)}" value="${escapeXml(value)}" />`)
            if (!stack)
              lines.push(
                `  <hint>no manifest detected (package.json/pyproject/Cargo/go.mod/…) — still showing tree + stats</hint>`,
              )
            for (const note of notes) lines.push(`  <note>${escapeXml(note)}</note>`)
            for (const note of stack?.notes ?? []) lines.push(`  <note>${escapeXml(note)}</note>`)
            lines.push("</stack>")
            return lines.join("\n")
          }

          // git + worktree awareness: logical project root, branch, worktree
          // status, working-tree state. Skipped entirely when not a repo.
          const gitXml = () => {
            if (!git) return ""
            const attrs = [`root="${escapeXml(path.relative(base, git.root) || ".")}"`]
            if (git.branch) attrs.push(`branch="${escapeXml(git.branch)}"`)
            if (git.linkedWorktree) attrs.push(`worktree="linked"`)
            if (git.changed > 0) attrs.push(`changed="${git.changed}"`)
            return `<git ${attrs.join(" ")} />`
          }

          // Logical-project initialization summary (one-glance "is this ready?"):
          // manifest, git, lockfile, deps dir, and which dev scripts exist.
          const initXml = () => {
            const depsDir =
              stack?.ecosystem === "python"
                ? ".venv"
                : stack?.ecosystem === "rust"
                  ? "target"
                  : stack?.ecosystem === "go"
                    ? "vendor"
                    : "node_modules"
            const depsPresent =
              depsDir === "node_modules"
                ? fileSet.has("node_modules") || rootPaths.some((p) => p.startsWith("node_modules/"))
                : undefined
            const attrs = [
              `manifest="${stack !== undefined ? "true" : "false"}"`,
              `git="${git !== undefined ? "true" : "false"}"`,
              `lockfile="${lockfile ? "true" : "false"}"`,
              depsPresent !== undefined ? `deps="${depsPresent ? "true" : "false"}"` : "",
            ]
            const lines = [`<init ${attrs.filter(Boolean).join(" ")}>`]
            for (const category of ["dev", "build", "test", "lint", "typecheck"]) {
              const has = (scripts ?? []).some((s) => s.category === category)
              if (has) lines.push(`  <script name="${category}" />`)
            }
            lines.push("</init>")
            return lines.join("\n")
          }

          const scriptsXml = (list: Array<{ name: string; category: string; cmd: string }>) => {
            const lines = [`<scripts total="${list.length}">`]
            for (const s of list)
              lines.push(
                `  <script name="${escapeXml(s.name)}" category="${escapeXml(s.category)}" cmd="${escapeXml(s.cmd)}" />`,
              )
            lines.push("</scripts>")
            return lines.join("\n")
          }

          const summaryScripts = (list: Array<{ name: string; category: string; cmd: string }>) => {
            const seen = new Set<string>()
            const onePerCategory = list.filter((s) => {
              if (seen.has(s.category)) return false
              seen.add(s.category)
              return true
            })
            return onePerCategory
              .slice(0, 5)
              .map((s) => `${s.name} → ${s.cmd.length > 80 ? `${s.cmd.slice(0, 80)}…` : s.cmd}`)
              .join("\n")
          }

          const statsLine = () =>
            `<stats files="${statsInfo.files}" loc="${statsInfo.loc !== undefined ? estLoc(statsInfo.loc) : "?"}${statsInfo.locEstimated ? ` (estimated, ${statsInfo.locSampled}/${statsInfo.files} sampled)` : ""}" totalBytes="${humanSize(statsInfo.totalBytes)}" />`

          const treeRender =
            tier === "structure" || tier === "full"
              ? renderTree(buildTree(scopedPaths, sizeMap).root, depth, maxEntries)
              : undefined

          let output: string
          if (tier === "summary") {
            output = [
              stackXml(),
              gitXml(),
              initXml(),
              entryPoints.length
                ? `<entry>${entryPoints
                    .slice(0, 5)
                    .map((e) => escapeXml(e))
                    .join(", ")}</entry>`
                : "",
              ci.length ? `<ci>${ci.map((c) => `${c.kind} (${escapeXml(c.path)})`).join(" · ")}</ci>` : "",
              scripts?.length ? `<scripts-summary>${summaryScripts(scripts)}</scripts-summary>` : "",
              statsLine(),
            ]
              .filter(Boolean)
              .join("\n")
          } else if (tier === "structure") {
            const t = treeRender!
            output = [
              stackXml(),
              gitXml(),
              initXml(),
              `<tree depth="${depth}" entries="${t.entries}" totalFiles="${t.totalFiles}" totalBytes="${humanSize(t.totalBytes)}">`,
              ...t.lines,
              "</tree>",
              statsLine(),
            ].join("\n")
          } else {
            const t = treeRender!
            const entryXml = entryPoints.length
              ? `<entry>${entryPoints.map((e) => `<point>${escapeXml(e)}</point>`).join("")}</entry>`
              : "<entry />"
            const configXml = `<config>${configs.map((c) => `<file kind="${escapeXml(c.kind)}">${escapeXml(c.path)}</file>`).join("")}</config>`
            const ciXml = `<ci>${ci.map((c) => `<file kind="${escapeXml(c.kind)}">${escapeXml(c.path)}</file>`).join("")}</ci>`
            const statsXml = [
              `<stats files="${statsInfo.files}" loc="${statsInfo.loc !== undefined ? estLoc(statsInfo.loc) : "?"}${statsInfo.locEstimated ? ` (estimated, ${statsInfo.locSampled}/${statsInfo.files} sampled)` : ""}" totalBytes="${humanSize(statsInfo.totalBytes)}">`,
              ...statsInfo.byExt.map(
                (b) =>
                  `  <type ext="${escapeXml(b.ext)}" files="${b.files}"${b.loc !== undefined ? ` loc="${estLoc(b.loc)}"` : ""} />`,
              ),
              "</stats>",
            ].join("\n")
            output = [
              stackXml(),
              gitXml(),
              initXml(),
              scripts?.length ? scriptsXml(scripts) : "",
              `<tree depth="${depth}" entries="${t.entries}" totalFiles="${t.totalFiles}" totalBytes="${humanSize(t.totalBytes)}">`,
              ...t.lines,
              "</tree>",
              entryXml,
              configXml,
              ciXml,
              statsXml,
            ]
              .filter(Boolean)
              .join("\n")
          }

          const title = scopeRel === "." ? "project" : scopeRel
          return {
            title,
            output,
            metadata: {
              tier,
              path: scopeRel,
              files: statsInfo.files,
              truncated: treeRender?.truncated ?? false,
              preview: output.slice(0, 500),
              git: git !== undefined,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as Project from "./project"
