#!/usr/bin/env bun

// Release asset inventory + SHA256 manifest owner for OpenFork releases.
//
// Two release classes exist and they are NOT interchangeable:
//
//   cli-only  The CLI archives are the complete release payload. Desktop
//             installers are either absent or best-effort extras. This is the
//             historical OpenFork dev pre-release shape (the desktop packaging
//             matrix is deliberately `continue-on-error`) and it stays valid.
//   desktop   The release promises desktop installers for every platform in
//             DESKTOP_REQUIREMENTS. A desktop-class publication fails closed
//             when any expected platform artifact is absent -- including the
//             case where the packaging job reported success, because the
//             desktop upload step intentionally succeeds when a leg produced
//             nothing.
//
// The CLI target matrix below is the single authority for CLI archive names.
// `packages/opencode/script/build.ts` imports it, so the expected inventory can
// never drift from what the builder actually produces.
//
// Everything here is pure/deterministic so the workflow can dry-run the exact
// inventory check without touching the network:
//
//   bun ./packages/opencode/script/release-assets.ts plan --class desktop
//   bun ./packages/opencode/script/release-assets.ts check --class cli-only --assets names.txt
//   bun ./packages/opencode/script/release-assets.ts manifest --dir downloaded-assets
//   bun ./packages/opencode/script/release-assets.ts verify --dir downloaded-assets

import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import path from "node:path"

import { PRODUCT_SLUG } from "@opencode-ai/core/brand"

// ---------------------------------------------------------------------------
// Release class
// ---------------------------------------------------------------------------

export type ReleaseClass = "cli-only" | "desktop"

export const RELEASE_CLASSES: readonly ReleaseClass[] = ["cli-only", "desktop"]

export function parseReleaseClass(raw: string | undefined, fallback: ReleaseClass = "cli-only"): ReleaseClass {
  if (raw === undefined || raw === "") return fallback
  const normalized = raw.trim().toLowerCase()
  if ((RELEASE_CLASSES as readonly string[]).includes(normalized)) return normalized as ReleaseClass
  throw new Error(`unknown release class "${raw}" (expected ${RELEASE_CLASSES.join(" | ")})`)
}

// ---------------------------------------------------------------------------
// CLI targets (shared authority with packages/opencode/script/build.ts)
// ---------------------------------------------------------------------------

export interface CliTarget {
  os: "linux" | "darwin" | "win32"
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}

/**
 * Every Bun cross-compile target a full OpenFork CLI release must publish.
 * Linux ships `.tar.gz`, everything else `.zip` (see build.ts packaging).
 */
export const CLI_TARGETS: readonly CliTarget[] = Object.freeze([
  { os: "linux", arch: "arm64" },
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "x64", avx2: false },
  { os: "linux", arch: "arm64", abi: "musl" },
  { os: "linux", arch: "x64", abi: "musl" },
  { os: "linux", arch: "x64", abi: "musl", avx2: false },
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "darwin", arch: "x64", avx2: false },
  { os: "win32", arch: "arm64" },
  { os: "win32", arch: "x64" },
  { os: "win32", arch: "x64", avx2: false },
] satisfies CliTarget[])

/**
 * Target name fragments shared by the archive name and the Bun compile target.
 * Bun calls its Windows compile target "windows"; `win32` is the Node name.
 */
export function cliTargetParts(target: CliTarget): string[] {
  return [
    target.os === "win32" ? "windows" : target.os,
    target.arch,
    target.avx2 === false ? "baseline" : undefined,
    target.abi,
  ].filter(Boolean) as string[]
}

/** Bun `--compile` target triple used by build.ts. */
export function bunCompileTarget(target: CliTarget): string {
  return ["bun", ...cliTargetParts(target)].join("-")
}

/** Distribution directory slug, e.g. `openfork-linux-x64-musl-baseline`. */
export function cliTargetSlug(target: CliTarget, productSlug: string = PRODUCT_SLUG): string {
  return [productSlug, ...cliTargetParts(target)].join("-")
}

/** Published release asset name for one CLI target. */
export function cliArchiveName(target: CliTarget, productSlug: string = PRODUCT_SLUG): string {
  return cliTargetSlug(target, productSlug) + (target.os === "linux" ? ".tar.gz" : ".zip")
}

/** Full expected CLI inventory for a release, sorted for deterministic output. */
export function expectedCliAssets(productSlug: string = PRODUCT_SLUG): string[] {
  return CLI_TARGETS.map((target) => cliArchiveName(target, productSlug)).sort()
}

// ---------------------------------------------------------------------------
// Desktop platform requirements (mirrors dev-pre-release.yml build matrix)
// ---------------------------------------------------------------------------

export interface DesktopRequirement {
  /** Human label matching the workflow matrix entry this requirement covers. */
  label: string
  arch: "x64" | "arm64"
  /**
   * Accepted electron-builder `${os}` token spellings. Windows is spelled
   * both `win` and `win32` across electron-builder versions, so requirement
   * matching is token-based rather than tied to one literal artifact name.
   */
  osTokens: string[]
  /** Every one of these extensions must be present for the platform to count. */
  extensions: string[]
}

export const DESKTOP_REQUIREMENTS: readonly DesktopRequirement[] = Object.freeze([
  {
    label: "macOS x64",
    arch: "x64",
    osTokens: ["mac", "darwin", "osx"],
    extensions: ["dmg", "zip"],
  },
  {
    label: "macOS arm64",
    arch: "arm64",
    osTokens: ["mac", "darwin", "osx"],
    extensions: ["dmg", "zip"],
  },
  { label: "Windows x64", arch: "x64", osTokens: ["win", "win32", "windows"], extensions: ["exe"] },
  { label: "Linux x64", arch: "x64", osTokens: ["linux"], extensions: ["AppImage", "deb", "rpm"] },
] satisfies DesktopRequirement[])

/** electron-builder `artifactName` prefix: `openfork-desktop-${os}-${arch}.${ext}`. */
export const DESKTOP_ASSET_PREFIX = `${PRODUCT_SLUG}-desktop-`

export function isDesktopAssetName(name: string): boolean {
  return name.startsWith(DESKTOP_ASSET_PREFIX)
}

function assetExtension(name: string): string {
  return name.slice(name.lastIndexOf(".") + 1)
}

/** True when `name` is a desktop installer satisfying `requirement`. */
export function satisfiesDesktopRequirement(name: string, requirement: DesktopRequirement): boolean {
  if (!isDesktopAssetName(name)) return false
  const extension = assetExtension(name)
  if (!requirement.extensions.includes(extension)) return false
  const stem = name.slice(DESKTOP_ASSET_PREFIX.length, name.length - extension.length - 1)
  const tokens = stem.split("-")
  return tokens.includes(requirement.arch) && requirement.osTokens.some((token) => tokens.includes(token))
}

/**
 * True when `name` is the desktop installer for `requirement` with EXACTLY
 * `extension`.
 *
 * This is deliberately not `satisfiesDesktopRequirement` narrowed by the caller.
 * `satisfiesDesktopRequirement` answers "is this asset a desktop installer for
 * this platform?", which every allowed extension answers yes to -- so on its own
 * it lets AppImage+deb satisfy a Linux `rpm` requirement. Per-extension
 * inventory must compare the extension itself.
 */
export function satisfiesDesktopInstaller(name: string, requirement: DesktopRequirement, extension: string): boolean {
  if (assetExtension(name) !== extension) return false
  return satisfiesDesktopRequirement(name, requirement)
}

// ---------------------------------------------------------------------------
// Inventory planning + verification
// ---------------------------------------------------------------------------

export interface ReleasePlan {
  releaseClass: ReleaseClass
  requiredCli: string[]
  requiredDesktop: DesktopRequirement[]
  /** Desktop labels the plan covers. Empty for a cli-only plan. */
  desktopLabels: string[]
}

/**
 * Resolve the expected inventory for a release class. `desktopLabels` narrows
 * the desktop platform set but may never invent one; unknown labels throw
 * rather than silently shrinking the fail-closed expectation.
 */
export function planRelease(releaseClass: ReleaseClass, desktopLabels?: readonly string[]): ReleasePlan {
  if (releaseClass === "cli-only")
    return {
      releaseClass,
      requiredCli: expectedCliAssets(),
      requiredDesktop: [],
      desktopLabels: [],
    }

  const selected = desktopLabels?.length
    ? DESKTOP_REQUIREMENTS.filter((requirement) => desktopLabels.includes(requirement.label))
    : [...DESKTOP_REQUIREMENTS]

  const unknown = (desktopLabels ?? []).filter(
    (label) => !DESKTOP_REQUIREMENTS.some((requirement) => requirement.label === label),
  )
  if (unknown.length) throw new Error(`unknown desktop platform label(s): ${unknown.join(", ")}`)

  if (selected.length === 0) throw new Error("desktop-class release requires at least one desktop platform")

  return {
    releaseClass,
    requiredCli: expectedCliAssets(),
    requiredDesktop: selected,
    desktopLabels: selected.map((requirement) => requirement.label),
  }
}

export type InventoryFindingCode =
  | "empty-release"
  | "missing-cli-asset"
  | "missing-desktop-asset"
  | "partial-desktop-extras"
  | "undeclared-desktop-asset"

export interface InventoryFinding {
  severity: "error" | "warning"
  code: InventoryFindingCode
  detail: string
}

export interface InventoryReport {
  ok: boolean
  releaseClass: ReleaseClass
  desktopLabels: string[]
  observed: string[]
  missingCli: string[]
  missingDesktop: string[]
  findings: InventoryFinding[]
}

export function checkReleaseInventory(plan: ReleasePlan, assetNames: readonly string[]): InventoryReport {
  const observed = [...new Set(assetNames)].sort()
  const observedSet = new Set(observed)
  const findings: InventoryFinding[] = []

  const missingCli = plan.requiredCli.filter((name) => !observedSet.has(name))
  for (const name of missingCli)
    findings.push({ severity: "error", code: "missing-cli-asset", detail: `required CLI asset is absent: ${name}` })

  const missingDesktop: string[] = []
  if (plan.releaseClass === "desktop") {
    for (const requirement of plan.requiredDesktop) {
      for (const extension of requirement.extensions) {
        const satisfied = observed.filter((name) => satisfiesDesktopInstaller(name, requirement, extension))
        if (satisfied.length === 0) {
          const detail = `${requirement.label} installer is absent: ${DESKTOP_ASSET_PREFIX}*.${
            extension === "AppImage" ? "AppImage" : extension
          }`
          missingDesktop.push(detail)
          findings.push({ severity: "error", code: "missing-desktop-asset", detail })
        }
      }
    }
  }

  const desktopAssets = observed.filter(isDesktopAssetName)
  if (plan.releaseClass === "cli-only") {
    // A cli-only release may still carry best-effort desktop extras, but a
    // partial platform set is never a complete desktop release: report it
    // loudly instead of letting it read as a shipped desktop build.
    const complete = DESKTOP_REQUIREMENTS.every((requirement) =>
      requirement.extensions.every((extension) =>
        observed.some((name) => satisfiesDesktopInstaller(name, requirement, extension)),
      ),
    )
    if (desktopAssets.length && !complete)
      findings.push({
        severity: "warning",
        code: "partial-desktop-extras",
        detail: `cli-only release carries ${desktopAssets.length} desktop asset(s) that do not form a complete desktop set`,
      })
  } else {
    for (const name of desktopAssets) {
      const declared = plan.requiredDesktop.some((requirement) => satisfiesDesktopRequirement(name, requirement))
      if (!declared)
        findings.push({
          severity: "warning",
          code: "undeclared-desktop-asset",
          detail: `desktop asset is outside the declared platform set: ${name}`,
        })
    }
  }

  if (observed.length === 0)
    findings.push({ severity: "error", code: "empty-release", detail: "release has no assets to verify" })

  return {
    ok: !findings.some((finding) => finding.severity === "error"),
    releaseClass: plan.releaseClass,
    desktopLabels: plan.desktopLabels,
    observed,
    missingCli,
    missingDesktop,
    findings,
  }
}

// ---------------------------------------------------------------------------
// SHA256 manifest
// ---------------------------------------------------------------------------

export const MANIFEST_NAME = "SHA256SUMS"

export interface ManifestEntry {
  name: string
  sha256: string
  bytes: number
}

function toPosix(value: string): string {
  return value.replaceAll("\\", "/")
}

export async function sha256File(pathOrDir: string): Promise<{ sha256: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256")
    let bytes = 0
    const stream = createReadStream(pathOrDir)
    stream.on("data", (chunk) => {
      bytes += (chunk as Buffer).length
      hash.update(chunk as Buffer)
    })
    stream.on("error", reject)
    stream.on("end", () => resolve({ sha256: hash.digest("hex"), bytes }))
  })
}

/** `sha256sum`-compatible, name-sorted, LF-terminated manifest text. */
export function renderManifest(entries: readonly ManifestEntry[]): string {
  return (
    [...entries]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((entry) => `${entry.sha256}  ${entry.name}`)
      .join("\n") + "\n"
  )
}

export function parseManifest(text: string): ManifestEntry[] {
  const entries: ManifestEntry[] = []
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "")
    if (!line.trim()) continue
    const match = /^([0-9a-f]{64})\s\s(.+)$/.exec(line)
    if (!match) throw new Error(`malformed SHA256 manifest line: ${JSON.stringify(raw)}`)
    entries.push({ sha256: match[1], name: match[2], bytes: 0 })
  }
  return entries
}

async function listFiles(root: string, ignore: readonly string[]): Promise<string[]> {
  const glob = new Bun.Glob("**/*")
  const names: string[] = []
  for await (const entry of glob.scan({ cwd: root, onlyFiles: true, dot: true })) {
    const name = toPosix(entry)
    if (ignore.includes(name)) continue
    names.push(name)
  }
  return names.sort()
}

/** Hash every file under `root` (excluding `ignore`) into manifest entries. */
export async function buildManifest(
  root: string,
  ignore: readonly string[] = [MANIFEST_NAME],
): Promise<ManifestEntry[]> {
  const names = await listFiles(root, ignore)
  const entries: ManifestEntry[] = []
  for (const name of names) {
    const { sha256, bytes } = await sha256File(path.join(root, ...name.split("/")))
    entries.push({ name, sha256, bytes })
  }
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

export type VerifyFindingCode =
  | "manifest-missing"
  | "malformed-manifest"
  | "checksum-mismatch"
  | "missing-file"
  | "unlisted-file"

export interface VerifyFinding {
  severity: "error"
  code: VerifyFindingCode
  detail: string
}

export async function verifyManifest(
  root: string,
  entries: readonly ManifestEntry[],
  ignore: readonly string[] = [MANIFEST_NAME],
): Promise<VerifyFinding[]> {
  const findings: VerifyFinding[] = []
  for (const entry of entries) {
    const target = path.join(root, ...entry.name.split("/"))
    if (!(await Bun.file(target).exists())) {
      findings.push({ severity: "error", code: "missing-file", detail: `asset is absent: ${entry.name}` })
      continue
    }
    const { sha256 } = await sha256File(target)
    if (sha256 !== entry.sha256)
      findings.push({
        severity: "error",
        code: "checksum-mismatch",
        detail: `${entry.name}: expected ${entry.sha256}, got ${sha256}`,
      })
  }
  for (const name of await listFiles(root, ignore)) {
    if (!entries.some((entry) => entry.name === name))
      findings.push({
        severity: "error",
        code: "unlisted-file",
        detail: `file is not covered by the manifest: ${name}`,
      })
  }
  return findings
}

export async function verifyManifestFile(
  root: string,
  manifestPath: string = path.join(root, MANIFEST_NAME),
  ignore: readonly string[] = [MANIFEST_NAME],
): Promise<VerifyFinding[]> {
  const file = Bun.file(manifestPath)
  if (!(await file.exists()))
    return [{ severity: "error", code: "manifest-missing", detail: `manifest not found: ${manifestPath}` }]
  try {
    return await verifyManifest(root, parseManifest(await file.text()), ignore)
  } catch (error) {
    return [
      {
        severity: "error",
        code: "malformed-manifest",
        detail: error instanceof Error ? error.message : String(error),
      },
    ]
  }
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

function parseFlags(argv: readonly string[]): Record<string, string | undefined> {
  const flags: Record<string, string | undefined> = {}
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (!token.startsWith("--")) continue
    const body = token.slice(2)
    const eq = body.indexOf("=")
    if (eq !== -1) flags[body.slice(0, eq)] = body.slice(eq + 1)
    else flags[body] = argv[index + 1]?.startsWith("--") ? "true" : argv[++index]
  }
  return flags
}

async function readAssetNames(source: string | undefined): Promise<string[]> {
  if (!source || source === "-") {
    const text = await Bun.stdin.text()
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  }
  if (source.endsWith(".txt") || source.endsWith(".json")) {
    const text = await Bun.file(source).text()
    try {
      const parsed = JSON.parse(text) as { assets?: { name: string }[] } | { name: string }[]
      if (Array.isArray(parsed)) return parsed.map((entry) => ("name" in entry ? entry.name : "")).filter(Boolean)
      return (parsed.assets ?? []).map((entry) => entry.name)
    } catch {
      return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    }
  }
  return source
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
}

function reportInventory(releaseClass: ReleaseClass, report: InventoryReport): string {
  const lines: string[] = []
  lines.push(`release-class: ${report.releaseClass}`)
  lines.push(`desktop-platforms: ${report.desktopLabels.length ? report.desktopLabels.join(", ") : "(none)"}`)
  lines.push(`required-cli: ${planRelease(releaseClass, report.desktopLabels).requiredCli.length}`)
  lines.push(`observed-assets: ${report.observed.length}`)
  for (const name of report.observed) lines.push(`  asset ${name}`)
  for (const finding of report.findings) lines.push(`  ${finding.severity} ${finding.code}: ${finding.detail}`)
  lines.push(`inventory-ok: ${report.ok}`)
  return lines.join("\n") + "\n"
}

const USAGE = `usage:
  release-assets.ts plan [--class cli-only|desktop] [--desktop "macOS x64,Windows x64"]
  release-assets.ts check [--class cli-only|desktop] [--assets <comma|names.txt|->]
  release-assets.ts manifest --dir <dir> [--out <file>]
  release-assets.ts verify --dir <dir> [--manifest <file>]
`

async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0]
  const flags = parseFlags(argv.slice(1))

  if (command === "plan") {
    const releaseClass = parseReleaseClass(flags["class"])
    const plan = planRelease(
      releaseClass,
      flags["desktop"]?.split(",").map((label) => label.trim()),
    )
    process.stdout.write(
      [
        `release-class: ${plan.releaseClass}`,
        `desktop-platforms: ${plan.desktopLabels.length ? plan.desktopLabels.join(", ") : "(none)"}`,
        ...plan.requiredCli.map((name) => `required-cli ${name}`),
        ...plan.requiredDesktop.flatMap((requirement) =>
          requirement.extensions.map(
            (extension) =>
              `required-desktop ${requirement.label} ${DESKTOP_ASSET_PREFIX}*.${extension === "AppImage" ? "AppImage" : extension}`,
          ),
        ),
        "inventory-ok: (not evaluated: no assets supplied)",
        "",
      ].join("\n"),
    )
    return 0
  }

  if (command === "check") {
    const releaseClass = parseReleaseClass(flags["class"])
    const names = await readAssetNames(flags["assets"])
    const plan = planRelease(
      releaseClass,
      flags["desktop"]?.split(",").map((label) => label.trim()),
    )
    const report = checkReleaseInventory(plan, names)
    process.stdout.write(reportInventory(releaseClass, report))
    return report.ok ? 0 : 1
  }

  if (command === "manifest") {
    const dir = flags["dir"]
    if (!dir) throw new Error("manifest requires --dir")
    const entries = await buildManifest(dir)
    const out = flags["out"] ?? path.join(dir, MANIFEST_NAME)
    await Bun.write(out, renderManifest(entries))
    process.stdout.write(`wrote ${entries.length} sha256 entries to ${out}\n`)
    return 0
  }

  if (command === "verify") {
    const dir = flags["dir"]
    if (!dir) throw new Error("verify requires --dir")
    const findings = await verifyManifestFile(dir, flags["manifest"] ?? path.join(dir, MANIFEST_NAME))
    if (findings.length === 0) {
      process.stdout.write(`verified ${dir} against ${flags["manifest"] ?? path.join(dir, MANIFEST_NAME)}\n`)
      return 0
    }
    for (const finding of findings) process.stdout.write(`${finding.severity} ${finding.code}: ${finding.detail}\n`)
    return 1
  }

  process.stdout.write(USAGE)
  return command === undefined ? 2 : 2
}

if (import.meta.main) {
  try {
    const code = await main(Bun.argv.slice(2))
    if (code !== 0) process.exit(code)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}
