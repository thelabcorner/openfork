// CLI-owned auth contracts for first-party Claude.
// Never reads, copies, refreshes, or stores subscription tokens.
// SDK loading stays lazy; no credential writes occur here.

import { Schema } from "effect"
import { buildChildEnv } from "./env"
import { sanitizeDetail } from "./errors"
import type { ClaudeProcessPort, SpawnHandle } from "./process"

export const AuthMethodType = Schema.Literals(["cli-login", "api-key", "oauth"])
export type AuthMethodType = typeof AuthMethodType.Type

export const AuthStatus = Schema.Literals(["unknown", "authenticated", "not-authenticated", "expired", "approval-required"])
export type AuthStatus = typeof AuthStatus.Type

export interface AuthInfo {
  readonly providerID: string
  readonly method: AuthMethodType
  readonly status: AuthStatus
  readonly cliExecutableDetected: boolean
  readonly cliVersion?: string
  readonly requiresUserApproval: boolean
  // Redacted correlation token (never the actual credential)
  readonly correlationHash?: string
}

// Typed interface suitable for fake fixtures (tests, mocks).
export interface ClaudeAuthContract {
  readonly getStatus: () => AuthInfo
  readonly isAvailable: () => boolean
  readonly requiresSetup: () => boolean
}

// Default contract implementation: pure, no I/O, no SDK load.
export const defaultContract: ClaudeAuthContract = {
  getStatus: () => ({
    providerID: "claude",
    method: "cli-login",
    status: "unknown",
    cliExecutableDetected: false,
    requiresUserApproval: false,
  }),
  isAvailable: () => false,
  requiresSetup: () => true,
}

// ── CLI-owned auth relay (runtime-auth lane) ──
//
// The official Claude CLI performs and stores all authentication. OpenCode
// only relays: it runs `claude auth status --json`, forwards the authorize
// URL from `claude auth login --claudeai`, pipes back the user-pasted code,
// and reads success from the CLI exit code alone. No token ever passes
// through this module; nothing is read from or written to credential stores.

export interface AuthStatusResult {
  readonly loggedIn: boolean
  /** Stable machine-readable category, e.g. "auth-status-oauth". */
  readonly detail: string
  readonly authMethod?: string
}

/**
 * Interpret a parsed `claude auth status --json` payload. API-key/console
 * methods do not count as subscription login.
 */
export function interpretAuthStatus(payload: unknown): AuthStatusResult {
  if (!payload || typeof payload !== "object") {
    return { loggedIn: false, detail: "invalid-auth-status" }
  }
  const root = payload as Record<string, unknown>
  const loggedIn = Boolean(root.loggedIn)
  const authMethod = typeof root.authMethod === "string" ? root.authMethod : "none"
  const normalized = authMethod.trim().toLowerCase()

  if (!loggedIn) {
    return { loggedIn: false, detail: "auth-status-logged-out", authMethod }
  }
  if (normalized === "none" || normalized.includes("api") || normalized.includes("console")) {
    return { loggedIn: false, detail: "api-key-only", authMethod }
  }

  const subscription = ["oauth", "claude", "subscription"].some((hint) => normalized.includes(hint))
  return {
    loggedIn: true,
    detail: subscription ? "auth-status-oauth" : "auth-status-logged-in",
    authMethod,
  }
}

/**
 * Parse CLI stdout into a JSON payload: direct parse first, then an
 * embedded `{...}` slice for CLIs that print banners around the JSON.
 */
export function extractJsonPayload(text: string): unknown | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf("{")
    const end = trimmed.lastIndexOf("}")
    if (start < 0 || end <= start) return undefined
    try {
      return JSON.parse(trimmed.slice(start, end + 1))
    } catch {
      return undefined
    }
  }
}

export interface CliAuthDeps {
  readonly process: ClaudeProcessPort
  readonly env?: Record<string, string | undefined>
  readonly timeoutMs?: number
}

/**
 * Run `claude auth status --json` through the process port with a
 * credential-stripped env. Returns undefined when the CLI could not be
 * executed or produced unparseable output — callers treat that as logged out.
 */
export async function fetchCliAuthStatus(binaryPath: string, deps: CliAuthDeps): Promise<AuthStatusResult | undefined> {
  const result = await deps.process.exec(binaryPath, ["auth", "status", "--json"], {
    env: buildChildEnv(deps.env ?? process.env),
    timeoutMs: deps.timeoutMs ?? 6000,
  })
  if (result.error && !result.stdout) return undefined
  const payload = extractJsonPayload(result.stdout)
  if (payload === undefined) return undefined
  return interpretAuthStatus(payload)
}

// ── Login relay ──

export type LoginRelayState =
  | { readonly state: "idle" }
  | { readonly state: "awaiting-code"; readonly url: string }
  | { readonly state: "verifying" }
  | { readonly state: "succeeded" }
  | { readonly state: "failed"; readonly message: string }

const ANSI_PATTERN = /\u001B\[[0-9;?]*[A-Za-z]/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "")
}

/** Last oauth/authorize URL wins — a CLI reprint supersedes what came before. */
export function extractAuthorizeUrl(text: string): string | undefined {
  const matches = text.match(/https?:\/\/[^\s'"<>]+/g)
  if (!matches) return undefined
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const candidate = matches[index]!.replace(/[).,;:'"]+$/, "")
    if (/oauth|authorize/i.test(candidate)) return candidate
  }
  return undefined
}

/** The CLI announces a rejected code on stderr while staying alive. */
export function looksLikeInvalidCodeNotice(text: string): boolean {
  return /invalid code/i.test(stripAnsi(text))
}

export function firstMeaningfulLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  )
}

/** The CLI prints the URL as soon as it starts; a slow print means it is stuck. */
const DEFAULT_URL_TIMEOUT_MS = 30_000
/** Token exchange the CLI performs after the code is submitted. */
const DEFAULT_VERIFY_TIMEOUT_MS = 120_000
/** An abandoned sign-in must not leave a CLI process waiting on stdin forever. */
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000

export interface LoginRelayDeps {
  readonly process: ClaudeProcessPort
  readonly binaryPath: string
  readonly env?: Record<string, string | undefined>
  readonly cwd?: string
  readonly urlTimeoutMs?: number
  readonly verifyTimeoutMs?: number
  readonly idleTimeoutMs?: number
}

export interface LoginSubmitResult {
  readonly ok: boolean
  /** Sanitized failure reason; never contains the code or any token. */
  readonly message?: string
}

function describeExit(code: number | null, signal: string | null): string {
  return `Claude Code login exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}.`
}

/**
 * Drives one official CLI sign-in flow through the typed process port.
 * A live process is reused so retrying a rejected code keeps the verifier
 * the CLI holds in memory; a dead one is replaced with a fresh flow.
 */
export class CliLoginRelay {
  private handle: SpawnHandle | undefined
  private currentState: LoginRelayState = { state: "idle" }
  private outputTail = ""
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private readonly urlTimeoutMs: number
  private readonly verifyTimeoutMs: number
  private readonly idleTimeoutMs: number

  constructor(private readonly deps: LoginRelayDeps) {
    this.urlTimeoutMs = deps.urlTimeoutMs ?? DEFAULT_URL_TIMEOUT_MS
    this.verifyTimeoutMs = deps.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS
    this.idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  }

  get state(): LoginRelayState {
    return this.currentState
  }

  private setState(next: LoginRelayState): void {
    this.currentState = next
  }

  private armIdleTimer(): void {
    this.clearIdleTimer()
    // Ref'd on purpose: bun's test runner deadlocks with unref'd timers, and
    // every path that settles the relay clears this timer explicitly.
    this.idleTimer = setTimeout(() => this.handle?.kill(), this.idleTimeoutMs)
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    }
  }

  private alive(): boolean {
    return this.handle !== undefined && !this.exited
  }

  private exited = false

  /**
   * Launch (or reuse) the official sign-in and resolve with the state once
   * the CLI reports its authorize URL.
   */
  async start(): Promise<LoginRelayState> {
    if (!this.alive()) {
      this.exited = false
      this.outputTail = ""
      let handle: SpawnHandle
      try {
        handle = await this.deps.process.spawn(this.deps.binaryPath, ["auth", "login", "--claudeai"], {
          cwd: this.deps.cwd,
          env: buildChildEnv(this.deps.env ?? process.env),
        })
      } catch (error) {
        const message = sanitizeDetail(error instanceof Error ? error.message : String(error))
        this.setState({ state: "failed", message })
        return this.currentState
      }
      this.handle = handle
      this.armIdleTimer()

      void handle.exit.then((exit) => {
        this.exited = true
        this.clearIdleTimer()
        if (exit.code === 0 && this.currentState.state === "verifying") {
          this.resolveCodeWaiter({ ok: true })
          this.setState({ state: "succeeded" })
        } else if (exit.error && this.currentState.state !== "succeeded") {
          this.setState({ state: "failed", message: sanitizeDetail(exit.error) })
        } else if (exit.code !== 0 && this.currentState.state !== "succeeded") {
          const notice = firstMeaningfulLine(stripAnsi(this.outputTail))
          if (this.currentState.state === "verifying") {
            this.resolveCodeWaiter({ ok: false, message: sanitizeDetail(notice || describeExit(exit.code, exit.signal)) })
          }
          this.setState({
            state: "failed",
            message: sanitizeDetail(notice || describeExit(exit.code, exit.signal)),
          })
        }
        if (this.currentState.state === "awaiting-code") {
          // Dead process can no longer accept a code.
          this.setState({ state: "idle" })
        }
      })
    }

    const currentUrl = this.currentState.state === "awaiting-code" ? this.currentState.url : undefined
    if (currentUrl) return this.currentState

    const urlWait = this.waitForAuthorizeUrl()
    if (this.handle) void this.consumeOutput(this.handle)
    const url = await urlWait
    if (url) {
      this.setState({ state: "awaiting-code", url })
      return this.currentState
    }

    this.cancel()
    this.setState({
      state: "failed",
      message: sanitizeDetail(firstMeaningfulLine(stripAnsi(this.outputTail)) || "Claude Code CLI did not report a sign-in URL."),
    })
    return this.currentState
  }

  private async consumeOutput(handle: SpawnHandle): Promise<void> {
    try {
      for await (const chunk of handle.output) {
        this.outputTail = appendBounded(this.outputTail + stripAnsi(chunk.text))
        const url = extractAuthorizeUrl(this.outputTail)
        if (url && this.currentState.state !== "verifying") {
          const changed = this.currentState.state !== "awaiting-code" || this.currentState.url !== url
          if (changed) {
            this.setState({ state: "awaiting-code", url })
            this.resolveUrlWaiter(url)
          }
        }
        if (chunk.stream === "stderr" && looksLikeInvalidCodeNotice(chunk.text)) {
          this.resolveCodeWaiter({
            ok: false,
            message: sanitizeDetail(firstMeaningfulLine(stripAnsi(chunk.text)) || "Claude Code rejected the sign-in code."),
          })
        }
      }
    } catch {
      // Stream errors surface through the exit promise instead.
    }
  }

  private urlWaiter: ((url: string | undefined) => void) | undefined
  private codeWaiter: ((result: LoginSubmitResult) => void) | undefined

  private resolveUrlWaiter(url: string | undefined): void {
    const waiter = this.urlWaiter
    this.urlWaiter = undefined
    waiter?.(url)
  }

  private resolveCodeWaiter(result: LoginSubmitResult): void {
    const waiter = this.codeWaiter
    this.codeWaiter = undefined
    waiter?.(result)
  }

  private waitForAuthorizeUrl(): Promise<string | undefined> {
    return new Promise((resolve) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        this.urlWaiter = undefined
        resolve(undefined)
      }, this.urlTimeoutMs)
      
      this.urlWaiter = (url) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(url)
      }
    })
  }

  private waitForVerification(): Promise<LoginSubmitResult> {
    return new Promise((resolve) => {
      let settled = false
      const finish = (result: LoginSubmitResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
      const timer = setTimeout(() => {
        finish({ ok: false, message: "Timed out waiting for Claude Code to accept the sign-in code." })
      }, this.verifyTimeoutMs)
      
      this.codeWaiter = finish
    })
  }

  /**
   * Hand the user-pasted code to the waiting CLI. Success is the CLI's own
   * exit status — the relay never sees the exchanged credential.
   */
  async submitCode(code: string): Promise<LoginSubmitResult> {
    const trimmed = code.trim()
    if (!trimmed) return { ok: false, message: "No sign-in code was provided." }
    if (!this.alive() || !this.handle) {
      return { ok: false, message: "The Claude Code sign-in is no longer running — start the sign-in again." }
    }

    // Only output produced from here on describes this attempt: a stale
    // rejection notice must not fail the new code before the CLI reads it.
    this.outputTail = ""
    this.setState({ state: "verifying" })
    this.armIdleTimer()

    const written = this.handle.write(`${trimmed}\n`)
    if (!written) {
      this.setState({ state: "failed", message: "Claude Code sign-in pipe is not writable." })
      return { ok: false, message: "Claude Code sign-in pipe is not writable." }
    }

    const outcome = await this.waitForVerification()
    if (outcome.ok) {
      this.setState({ state: "succeeded" })
      return { ok: true }
    }
    // A rejected code does not burn the challenge: the CLI prompts again on
    // the same URL, so the sign-in stays usable.
    this.setState({ state: "failed", message: outcome.message ?? "Claude Code rejected the sign-in code." })
    return outcome
  }

  /** Kill the CLI process and reset transient state (not user credentials). */
  cancel(): void {
    this.clearIdleTimer()
    this.handle?.kill()
    this.handle = undefined
    this.exited = true
    if (this.currentState.state === "awaiting-code" || this.currentState.state === "verifying") {
      this.setState({ state: "idle" })
    }
    this.resolveUrlWaiter(undefined)
    this.resolveCodeWaiter({ ok: false, message: "The Claude Code sign-in was cancelled." })
  }
}

function appendBounded(text: string, max = 64 * 1024): string {
  return text.length > max ? text.slice(text.length - max) : text
}

// ── Install relay ──

/** Official npm distribution of the Claude Code CLI. */
const NPM_INSTALL_ARGS = ["install", "-g", "@anthropic-ai/claude-code"]
/** Official self-contained installer, used when npm itself is unavailable. */
const SCRIPT_INSTALL_COMMAND = "curl -fsSL https://claude.ai/install.sh | bash"
/** npm global install; slow on first run. */
const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60_000

export interface InstallResult {
  readonly ok: boolean
  /** Sanitized failure reason when ok is false. */
  readonly message?: string
}

export interface InstallDeps {
  readonly process: ClaudeProcessPort
  readonly env?: Record<string, string | undefined>
  readonly cwd?: string
  readonly timeoutMs?: number
}

async function runInstaller(
  deps: InstallDeps,
  command: string,
  args: readonly string[],
): Promise<InstallResult> {
  const result = await deps.process.exec(command, args, {
    cwd: deps.cwd,
    env: buildChildEnv(deps.env ?? process.env),
    timeoutMs: deps.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS,
  })
  if (result.error && result.code === null) {
    return { ok: false, message: sanitizeDetail(result.error) }
  }
  if (result.code === 0) return { ok: true }
  const notice = firstMeaningfulLine(result.stdout + "\n" + result.stderr)
  return {
    ok: false,
    message: sanitizeDetail(notice || `Installer exited with code ${result.code ?? "unknown"}.`),
  }
}

/**
 * Install the official Claude Code CLI into the user environment. npm is
 * tried first; the official install script is the POSIX fallback for hosts
 * without npm. Output is captured for error reporting only.
 */
export async function installCli(deps: InstallDeps): Promise<InstallResult> {
  const npm = await runInstaller(deps, "npm", NPM_INSTALL_ARGS)
  if (npm.ok) return npm
  const fallback = await runInstaller(deps, "bash", ["-lc", SCRIPT_INSTALL_COMMAND])
  if (!fallback.ok && npm.message) return { ...fallback, message: npm.message }
  return fallback
}

export * as ClaudeAuth from "./auth"
