import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import npa from "npm-package-arg"
import semver from "semver"
import { Filesystem } from "@/util/filesystem"
import { isRecord } from "@/util/record"
import { Npm } from "@opencode-ai/core/npm"

// Old npm package names for plugins that are now built-in
export const DEPRECATED_PLUGIN_PACKAGES = ["opencode-openai-codex-auth", "opencode-copilot-auth"]

// External Claude plugin remains independently addressable as `claude-code`.
// Detection uses exact package identity (via parse) not substring, per migration plan.
export const CLAUDE_EXTERNAL_PLUGIN = "@openchamber/opencode-claude"

export function isClaudeExternalPlugin(spec: string): boolean {
  const parsed = parsePluginSpecifier(spec)
  return parsed.pkg === CLAUDE_EXTERNAL_PLUGIN
}

/**
 * Single source of truth (owned by migration lane) for the first-party Claude
 * rollback flag. Pure + fixture friendly.
 *
 * Used by:
 * - Core provider wiring (`claude` autoload/rollback gate)
 *
 * Runtime + provider layers should consult this (or the underlying env + RuntimeFlags)
 * to stay consistent. When false, first-party must produce "disabled" state with zero side effects.
 */
export function shouldEnableClaudeFirstParty(input?: {
  readonly disableClaudeCodeFirstParty?: boolean
}): boolean {
  // Packaging parity force-include (for sidecar bundle): the import() literals below are
  // inside a live function (always kept) but guarded by compile-time false so NEVER execute
  // at runtime. This ensures Bun.build sees the specifiers and includes claude runtime code
  // (even though only dynamically referenced from provider path). No eager load, no side
  // effects, SDK/CLI still lazy + shouldEnable gated.
  // Force-include for sidecar bundle parity: these import() specifiers must be visible
  // to Bun.build so the full claude runtime is included in dist/node/node.js. They are
  // never awaited and never executed eagerly (lazy SDK/CLI work stays gated by
  // shouldEnableClaudeFirstParty() in runtime/auth/availability). The .catch() suppresses
  // any runtime failure when the optional SDK is absent.
  if (false) {
    void import("@/claude/runtime").catch(() => undefined)
    void import("@/claude/bridge").catch(() => undefined)
    void import("@/claude/tool-bridge").catch(() => undefined)
    void import("@/claude/sessions").catch(() => undefined)
    void import("@/claude/binding-persistence").catch(() => undefined)
    void import("@/claude/auth").catch(() => undefined)
    void import("@/claude/availability").catch(() => undefined)
    void import("@/claude/provider").catch(() => undefined)
    void import("@/claude/models").catch(() => undefined)
  }

  if (input?.disableClaudeCodeFirstParty === true) return false
  const env = process.env.OPENCODE_DISABLE_CLAUDE_FIRST_PARTY ?? process.env.OPENCODE_DISABLE_CLAUDE_CODE_FIRST_PARTY
  if (env === "1" || env === "true") return false
  return true
}

export function isDeprecatedPlugin(spec: string) {
  if (DEPRECATED_PLUGIN_PACKAGES.some((pkg) => spec.includes(pkg))) {
    return true
  }
  return false
}

function parse(spec: string) {
  try {
    return npa(spec)
  } catch {}
}

export function parsePluginSpecifier(spec: string) {
  const hit = parse(spec)
  if (hit?.type === "alias" && !hit.name) {
    const sub = (hit as npa.AliasResult).subSpec
    if (sub?.name) {
      const version = !sub.rawSpec || sub.rawSpec === "*" ? "latest" : sub.rawSpec
      return { pkg: sub.name, version }
    }
  }
  if (!hit?.name) return { pkg: spec, version: "" }
  if (hit.raw === hit.name) return { pkg: hit.name, version: "latest" }
  return { pkg: hit.name, version: hit.rawSpec }
}

export type PluginSource = "file" | "npm"
export type PluginKind = "server" | "tui"
type PluginMode = "strict" | "detect"

export type PluginPackage = {
  dir: string
  pkg: string
  json: Record<string, unknown>
}

export type PluginEntry = {
  spec: string
  source: PluginSource
  target: string
  pkg?: PluginPackage
  entry?: string
}

const INDEX_FILES = ["index.ts", "index.tsx", "index.js", "index.mjs", "index.cjs"]

export function pluginSource(spec: string): PluginSource {
  if (isPathPluginSpec(spec)) return "file"
  return "npm"
}

function resolveExportPath(raw: string, dir: string) {
  if (raw.startsWith("file://")) return fileURLToPath(raw)
  if (path.isAbsolute(raw)) return raw
  return path.resolve(dir, raw)
}

function isAbsolutePath(raw: string) {
  return path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)
}

function extractExportValue(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (!isRecord(value)) return undefined
  for (const key of ["import", "default"]) {
    const nested = value[key]
    if (typeof nested === "string") return nested
  }
  return undefined
}

function packageMain(pkg: PluginPackage) {
  const value = pkg.json.main
  if (typeof value !== "string") return
  const next = value.trim()
  if (!next) return
  return next
}

function resolvePackageFile(spec: string, raw: string, kind: string, pkg: PluginPackage) {
  const resolved = resolveExportPath(raw, pkg.dir)
  const root = Filesystem.resolve(pkg.dir)
  const next = Filesystem.resolve(resolved)
  if (!Filesystem.contains(root, next)) {
    throw new Error(`Plugin ${spec} resolved ${kind} entry outside plugin directory`)
  }
  return next
}

function resolvePackagePath(spec: string, raw: string, kind: PluginKind, pkg: PluginPackage) {
  return pathToFileURL(resolvePackageFile(spec, raw, kind, pkg)).href
}

function resolvePackageEntrypoint(spec: string, kind: PluginKind, pkg: PluginPackage) {
  const exports = pkg.json.exports
  if (isRecord(exports)) {
    const raw = extractExportValue(exports[`./${kind}`])
    if (raw) return resolvePackagePath(spec, raw, kind, pkg)
  }

  if (kind !== "server") return
  const main = packageMain(pkg)
  if (!main) return
  return resolvePackagePath(spec, main, kind, pkg)
}

function targetPath(target: string) {
  if (target.startsWith("file://")) return fileURLToPath(target)
  if (path.isAbsolute(target)) return target
}

async function resolveDirectoryIndex(dir: string) {
  for (const name of INDEX_FILES) {
    const file = path.join(dir, name)
    if (await Filesystem.exists(file)) return file
  }
}

async function resolveTargetDirectory(target: string) {
  const file = targetPath(target)
  if (!file) return
  const stat = await Filesystem.statAsync(file)
  if (!stat?.isDirectory()) return
  return file
}

async function resolvePluginEntrypoint(spec: string, target: string, kind: PluginKind, pkg?: PluginPackage) {
  const source = pluginSource(spec)
  const hit =
    pkg ?? (source === "npm" ? await readPluginPackage(target) : await readPluginPackage(target).catch(() => undefined))
  if (!hit) return target

  const entry = resolvePackageEntrypoint(spec, kind, hit)
  if (entry) return entry

  const dir = await resolveTargetDirectory(target)

  if (kind === "tui") {
    if (source === "file" && dir) {
      const index = await resolveDirectoryIndex(dir)
      if (index) return pathToFileURL(index).href
    }

    if (source === "npm") return
    if (dir) return

    return target
  }

  if (dir && isRecord(hit.json.exports)) {
    if (source === "file") {
      const index = await resolveDirectoryIndex(dir)
      if (index) return pathToFileURL(index).href
    }

    return
  }

  return target
}

export function isPathPluginSpec(spec: string) {
  return spec.startsWith("file://") || spec.startsWith(".") || isAbsolutePath(spec)
}

export async function resolvePathPluginTarget(spec: string) {
  const raw = spec.startsWith("file://") ? fileURLToPath(spec) : spec
  const file = path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) ? raw : path.resolve(raw)
  const stat = await Filesystem.statAsync(file)
  if (!stat?.isDirectory()) {
    if (spec.startsWith("file://")) return spec
    return pathToFileURL(file).href
  }

  if (await Filesystem.exists(path.join(file, "package.json"))) {
    return pathToFileURL(file).href
  }

  const index = await resolveDirectoryIndex(file)
  if (index) return pathToFileURL(index).href

  throw new Error(`Plugin directory ${file} is missing package.json or index file`)
}

export async function checkPluginCompatibility(target: string, opencodeVersion: string, pkg?: PluginPackage) {
  if (!semver.valid(opencodeVersion) || semver.major(opencodeVersion) === 0) return
  const hit = pkg ?? (await readPluginPackage(target).catch(() => undefined))
  if (!hit) return
  const engines = hit.json.engines
  if (!isRecord(engines)) return
  const range = engines.opencode
  if (typeof range !== "string") return
  if (!semver.satisfies(opencodeVersion, range)) {
    throw new Error(`Plugin requires opencode ${range} but running ${opencodeVersion}`)
  }
}

export async function resolvePluginTarget(spec: string) {
  if (isPathPluginSpec(spec)) return resolvePathPluginTarget(spec)
  const hit = parse(spec)
  const pkg = hit?.name && hit.raw === hit.name ? `${hit.name}@latest` : spec
  const result = await Npm.add(pkg)
  return result.directory
}

export async function readPluginPackage(target: string): Promise<PluginPackage> {
  const file = target.startsWith("file://") ? fileURLToPath(target) : target
  const stat = await Filesystem.statAsync(file)
  const dir = stat?.isDirectory() ? file : path.dirname(file)
  const pkg = path.join(dir, "package.json")
  const json = await Filesystem.readJson<Record<string, unknown>>(pkg)
  return { dir, pkg, json }
}

export async function createPluginEntry(spec: string, target: string, kind: PluginKind): Promise<PluginEntry> {
  const source = pluginSource(spec)
  const pkg =
    source === "npm" ? await readPluginPackage(target) : await readPluginPackage(target).catch(() => undefined)
  const entry = await resolvePluginEntrypoint(spec, target, kind, pkg)
  return {
    spec,
    source,
    target,
    pkg,
    entry,
  }
}

export function readPackageThemes(spec: string, pkg: PluginPackage) {
  const field = pkg.json["oc-themes"]
  if (field === undefined) return []
  if (!Array.isArray(field)) {
    throw new TypeError(`Plugin ${spec} has invalid oc-themes field`)
  }

  const list = field.map((item) => {
    if (typeof item !== "string") {
      throw new TypeError(`Plugin ${spec} has invalid oc-themes entry`)
    }

    const raw = item.trim()
    if (!raw) {
      throw new TypeError(`Plugin ${spec} has empty oc-themes entry`)
    }
    if (raw.startsWith("file://") || isAbsolutePath(raw)) {
      throw new TypeError(`Plugin ${spec} oc-themes entry must be relative: ${item}`)
    }

    return resolvePackageFile(spec, raw, "oc-themes", pkg)
  })

  return Array.from(new Set(list))
}

export function readPluginId(id: unknown, spec: string) {
  if (id === undefined) return
  if (typeof id !== "string") throw new TypeError(`Plugin ${spec} has invalid id type ${typeof id}`)
  const value = id.trim()
  if (!value) throw new TypeError(`Plugin ${spec} has an empty id`)
  return value
}

export function readV1Plugin(
  mod: Record<string, unknown>,
  spec: string,
  kind: PluginKind,
  mode: PluginMode = "strict",
) {
  const value = mod.default
  if (!isRecord(value)) {
    if (mode === "detect") return
    throw new TypeError(`Plugin ${spec} must default export an object with ${kind}()`)
  }
  if (mode === "detect" && !("id" in value) && !("server" in value) && !("tui" in value)) return

  const server = "server" in value ? value.server : undefined
  const tui = "tui" in value ? value.tui : undefined
  if (server !== undefined && typeof server !== "function") {
    throw new TypeError(`Plugin ${spec} has invalid server export`)
  }
  if (tui !== undefined && typeof tui !== "function") {
    throw new TypeError(`Plugin ${spec} has invalid tui export`)
  }
  if (server !== undefined && tui !== undefined) {
    throw new TypeError(`Plugin ${spec} must default export either server() or tui(), not both`)
  }
  if (kind === "server" && server === undefined) {
    throw new TypeError(`Plugin ${spec} must default export an object with server()`)
  }
  if (kind === "tui" && tui === undefined) {
    throw new TypeError(`Plugin ${spec} must default export an object with tui()`)
  }

  return value
}

export async function resolvePluginId(
  source: PluginSource,
  spec: string,
  target: string,
  id: string | undefined,
  pkg?: PluginPackage,
) {
  if (source === "file") {
    if (id) return id
    throw new TypeError(`Path plugin ${spec} must export id`)
  }
  if (id) return id
  const hit = pkg ?? (await readPluginPackage(target))
  if (typeof hit.json.name !== "string" || !hit.json.name.trim()) {
    throw new TypeError(`Plugin package ${hit.pkg} is missing name`)
  }
  return hit.json.name.trim()
}

// Packaging parity (owned by migration-release/packaging-parity): ensure claude first-party
// runtime modules are present in the sidecar bundle (dist/node/node.js). They are only
// dynamically imported from the provider path today, so we fire a top-level dynamic import
// here (shared.ts is always reached via plugin loader in core paths). This is fire-and-forget
// (no await, no blocking of module eval) and the target modules have no top-level side effects
// beyond defs; their SDK/CLI work remains lazy + gated by shouldEnableClaudeFirstParty().
// The specifier ensures Bun.build concatenates/inlines the code for sidecar parity.
// See the guarded import() block inside shouldEnableClaudeFirstParty() above (line 40).
