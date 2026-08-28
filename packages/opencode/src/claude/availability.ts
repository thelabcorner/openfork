// First-party Claude availability detection.
//
// Static CLI resolution is pure (PATH scan + known install locations with
// existence checks only — no process spawns, no network). Version probing,
// SDK loading, and auth status are explicit operations driven through the
// typed process port so fixtures can fake every OS interaction.

import { existsSync } from "node:fs"
import { buildChildEnv, homeDir, type ChildEnv } from "./env"
import { ClaudeCliMissingError, ClaudeSdkUnavailableError, sanitizeDetail } from "./errors"
import { interpretAuthStatus, fetchCliAuthStatus, type AuthStatusResult } from "./auth"
import type { ClaudeProcessPort } from "./process"
import { shouldEnableClaudeFirstParty } from "@/plugin/shared"

export const CLAUDE_BINARY_NAME = "claude"

/** SDK module shape the runtime relies on; validated at load time. */
export interface ClaudeSdkModuleShape {
  query?: unknown
}

/** Minimal environment surface used for resolution (fixture-friendly). */
export type AvailabilityEnv = ChildEnv

export interface PathLike {
  /** Existence check injected so resolution never touches the filesystem directly. */
  (path: string): boolean
}

const WINDOWS_EXTS = [".cmd", ".exe", ".bat", ""] as const
const POSIX_EXTS = [""] as const

function isWindows(platform: string): boolean {
  return platform === "win32"
}

function joinPath(dir: string, name: string): string {
  const trimmed = dir.replace(/[/\\]+$/, "")
  return `${trimmed}/${name}`
}

/** PATH entries × platform extensions, in order. */
export function pathCandidates(
  name: string,
  env: AvailabilityEnv,
  platform: string = process.platform,
): string[] {
  const pathEnv = typeof env.PATH === "string" ? env.PATH : ""
  const parts = pathEnv.split(isWindows(platform) ? ";" : ":")
  const exts = isWindows(platform) ? WINDOWS_EXTS : POSIX_EXTS
  const candidates: string[] = []
  for (const dir of parts) {
    if (!dir) continue
    for (const ext of exts) {
      candidates.push(`${joinPath(dir, name)}${ext}`)
    }
  }
  return candidates
}

/**
 * Install locations a managed/server PATH commonly misses: the official
 * installer's ~/.local/bin and (on POSIX) the npm global bin.
 */
export function knownCandidates(
  name: string,
  env: AvailabilityEnv,
  platform: string = process.platform,
): string[] {
  const home = homeDir(env)
  if (!home) return []
  const candidates = [joinPath(joinPath(joinPath(home, ".local"), "bin"), name)]
  if (!isWindows(platform)) candidates.push(joinPath(joinPath(joinPath(home, ".npm-global"), "bin"), name))
  return candidates
}

/**
 * Resolve the official `claude` executable without spawning anything:
 * first existing candidate across PATH then known locations. Returns
 * undefined when the CLI is not installed.
 */
export function resolveCliPath(
  env: AvailabilityEnv = process.env,
  exists: PathLike = (path) => existsSync(path),
  platform: string = process.platform,
): string | undefined {
  for (const candidate of [...pathCandidates(CLAUDE_BINARY_NAME, env, platform), ...knownCandidates(CLAUDE_BINARY_NAME, env, platform)]) {
    if (exists(candidate)) return candidate
  }
  return undefined
}

/** First `x.y.z` version-looking token in CLI output. */
export function parseVersionOutput(text: string): string | undefined {
  const match = text.trim().match(/(\d+\.\d+\.\d+)/)
  return match?.[1]
}

// ── Readiness aggregation ──

/**
 * Separate concerns per plan task 02: "CLI installed", "SDK available",
 * "CLI logged in", and overall readiness are distinct facts. "disabled" is
 * the rollback state (OPENCODE_DISABLE_CLAUDE_CODE_FIRST_PARTY) — not an
 * error, so hosts can fall back to the external plugin path.
 */
export type Readiness = "ready" | "needs-login" | "missing-cli" | "missing-sdk" | "error" | "disabled"

export interface AvailabilityReport {
  readonly readiness: Readiness
  readonly cliInstalled: boolean
  readonly sdkAvailable: boolean
  readonly loggedIn: boolean
  readonly binaryPath?: string
  readonly version?: string
  readonly authMethod?: string
  /** Sanitized, user-safe detail; never contains credentials or prompts. */
  readonly detail?: string
}

export interface AvailabilityDeps {
  readonly process: ClaudeProcessPort
  /** Lazy SDK loader probe; defaults to the runtime's loader. */
  readonly loadSdk?: () => Promise<ClaudeSdkModuleShape>
  readonly env?: AvailabilityEnv
  readonly exists?: PathLike
  readonly platform?: string
  readonly versionTimeoutMs?: number
  readonly authTimeoutMs?: number
  /**
   * Rollback gate override; defaults to the migration lane's
   * shouldEnableClaudeFirstParty() (plugin/shared). When false, no process
   * is spawned and no SDK is loaded.
   */
  readonly enabled?: boolean
}

async function probeSdk(loadSdk: () => Promise<ClaudeSdkModuleShape>): Promise<{ available: boolean; error?: string }> {
  try {
    const mod = await loadSdk()
    if (typeof mod?.query !== "function") {
      return { available: false, error: "Claude Agent SDK query() is unavailable" }
    }
    return { available: true }
  } catch (error) {
    return { available: false, error: sanitizeDetail(error instanceof Error ? error.message : String(error)) }
  }
}

/**
 * Explicit availability check. This is the only entry point that may spawn
 * processes (`--version`, `auth status --json`) or load the Agent SDK;
 * discovery/model listing must never call it implicitly.
 */
export async function checkAvailability(deps: AvailabilityDeps): Promise<AvailabilityReport> {
  // Rollback gate (migration lane contract). Injectable for fixtures; when
  // disabled, nothing is spawned or loaded.
  const enabled = deps.enabled ?? shouldEnableClaudeFirstParty()
  if (!enabled) {
    return {
      readiness: "disabled",
      cliInstalled: false,
      sdkAvailable: false,
      loggedIn: false,
      detail: "First-party Claude support is disabled by OPENCODE_DISABLE_CLAUDE_CODE_FIRST_PARTY.",
    }
  }
  const env = deps.env ?? process.env
  const exists = deps.exists ?? ((path: string) => existsSync(path))
  const platform = deps.platform ?? process.platform

  const binaryPath = resolveCliPath(env, exists, platform)
  if (!binaryPath) {
    return {
      readiness: "missing-cli",
      cliInstalled: false,
      sdkAvailable: false,
      loggedIn: false,
      detail: "Claude Code CLI (`claude`) not found — install it or run `npm install -g @anthropic-ai/claude-code`.",
    }
  }

  const childEnv = buildChildEnv(env)
  let version: string | undefined
  const versionResult = await deps.process.exec(binaryPath, ["--version"], { env: childEnv, timeoutMs: deps.versionTimeoutMs ?? 4000 })
  if (!versionResult.error && versionResult.code === 0) {
    version = parseVersionOutput(versionResult.stdout)
  }

  const sdk = await probeSdk(deps.loadSdk ?? defaultSdkLoader)
  if (!sdk.available) {
    return {
      readiness: "missing-sdk",
      cliInstalled: true,
      sdkAvailable: false,
      loggedIn: false,
      binaryPath,
      version,
      detail: sanitizeDetail(sdk.error ?? "Claude Agent SDK unavailable"),
    }
  }

  let auth: AuthStatusResult | undefined
  try {
    auth = await fetchCliAuthStatus(binaryPath, { process: deps.process, env, timeoutMs: deps.authTimeoutMs })
  } catch {
    auth = undefined
  }

  if (!auth || !auth.loggedIn) {
    return {
      readiness: "needs-login",
      cliInstalled: true,
      sdkAvailable: true,
      loggedIn: false,
      binaryPath,
      version,
      detail: auth ? sanitizeDetail(auth.detail) : "auth-status-unavailable",
    }
  }

  return {
    readiness: "ready",
    cliInstalled: true,
    sdkAvailable: true,
    loggedIn: true,
    binaryPath,
    version,
    authMethod: auth.authMethod,
    detail: sanitizeDetail(auth.detail),
  }
}

// ── Lazy SDK loading ──

// Indirect specifier keeps bundlers from resolving/failing on an optional
// dependency at build time; a missing package surfaces at runtime as a
// provider-unavailable result instead of a startup failure.
const SDK_SPECIFIER = "@anthropic-ai/claude-agent-sdk"

let cachedLoader: Promise<ClaudeSdkModuleShape> | undefined

/**
 * Default lazy loader for the Agent SDK. The import happens only when an
 * explicit operation needs it; failure is normalized to
 * ClaudeSdkUnavailableError.
 */
export function defaultSdkLoader(): Promise<ClaudeSdkModuleShape> {
  if (!cachedLoader) {
    cachedLoader = (async () => {
      const specifier = SDK_SPECIFIER
      const mod: unknown = await import(/* @vite-ignore */ specifier)
      if (!mod || typeof mod !== "object" || typeof (mod as ClaudeSdkModuleShape).query !== "function") {
        throw new ClaudeSdkUnavailableError({ message: "Claude Agent SDK query() is unavailable" })
      }
      return mod as ClaudeSdkModuleShape
    })().catch((error) => {
      cachedLoader = undefined
      if (error instanceof ClaudeSdkUnavailableError) throw error
      throw new ClaudeSdkUnavailableError({
        message: "Claude Agent SDK could not be loaded",
        detail: sanitizeDetail(error instanceof Error ? error.message : String(error)),
      })
    })
  }
  return cachedLoader
}

/** Test hook: drop the memoized loader so a later load re-imports. */
export function resetSdkLoaderCache(): void {
  cachedLoader = undefined
}

/** Guard used by callers that require an installed CLI before proceeding. */
export function requireCliPath(report: AvailabilityReport): string {
  if (!report.binaryPath) throw new ClaudeCliMissingError({ message: report.detail ?? "Claude Code CLI not found" })
  return report.binaryPath
}

export * as ClaudeAvailability from "./availability"
