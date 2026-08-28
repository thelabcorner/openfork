import { Effect } from "effect"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Auth } from "@/auth"
import { HttpClient } from "effect/unstable/http"
import { buildResult, toTimestamp, toUsageWindow } from "../format"
import type { Adapter } from "../registry"
import { authKey } from "./key"
import { fetchJson, outcomeError } from "./http"

/**
 * Claude (Anthropic) account quota. Ported from OpenChamber (MIT).
 */
const ALIASES = ["claude", "claude-code", "claude-api", "anthropic"]
const NAME = "Claude"
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
const USAGE_CACHE_TTL_MS = 300_000
const CLAUDE_429_DEFAULT_MS = 300_000
const CLAUDE_429_MAX_MS = 3_600_000

/**
 * External-readonly credential resolution, faithful to OpenChamber's
 * claude/auth.js: auth.json aliases first, then CLAUDE_CODE_OAUTH_TOKEN,
 * then Claude Code's own credential file (~/.claude/.credentials.json).
 * NEVER refreshes or writes — refreshing would sign Claude Code out.
 */
export function parseClaudeCredentials(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const oauth = parsed.claudeAiOauth as Record<string, unknown> | undefined
    if (oauth && typeof oauth.accessToken === "string" && oauth.accessToken.length > 0) return oauth.accessToken
    if (typeof parsed.accessToken === "string" && parsed.accessToken.length > 0) return parsed.accessToken
    const tokens = parsed.tokens as Record<string, unknown> | undefined
    if (tokens && typeof tokens.access_token === "string" && tokens.access_token.length > 0) return tokens.access_token
    return undefined
  } catch {
    return undefined
  }
}

function claudeCredentialsPaths(): string[] {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim()
  const home = homedir()
  const homes = [home, process.env.USERPROFILE, process.env.HOME].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  )
  const configured = configDir
    ? configDir.toLowerCase().endsWith(".json")
      ? configDir
      : join(configDir, ".credentials.json")
    : undefined
  return [
    configured,
    ...homes.map((value) => join(value, ".claude", ".credentials.json")),
  ].filter((path, index, paths): path is string => path !== undefined && paths.indexOf(path) === index)
}

async function readExternalAccessToken(): Promise<string | undefined> {
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()
  if (envToken) return envToken
  for (const credPath of claudeCredentialsPaths()) {
    try {
      const text = await readFile(credPath, "utf8")
      const token = parseClaudeCredentials(text)
      if (token) return token
    } catch {
      continue
    }
  }
  return undefined
}

export const claude = (http: HttpClient.HttpClient, auth: Auth.Interface): Adapter => {
  let cached: { accessToken: string; fetchedAt: number; result: ReturnType<typeof buildResult> } | undefined
  let cooldownUntil = 0

  return {
    id: "claude",
    name: NAME,
    aliases: ALIASES,
    configured: () =>
      Effect.gen(function* () {
        // Claude Code is a machine account, not an opencode.json provider.
        // Presence of its local OAuth credential is sufficient to show the card.
        if ((yield* Effect.promise(readExternalAccessToken)) !== undefined) return true
        return yield* Effect.map(authKey(auth, ALIASES), (key) => key !== undefined)
      }),
    fetch: () =>
      Effect.gen(function* () {
        const resolved = yield* authKey(auth, ALIASES)
        const accessToken = resolved?.key ?? (yield* Effect.promise(readExternalAccessToken))
        if (!accessToken) {
          return buildResult({ providerId: "claude", providerName: NAME, ok: false, configured: false, error: "Not configured" })
        }

        const now = Date.now()
        if (cached && cached.accessToken !== accessToken) {
          cached = undefined
          cooldownUntil = 0
        }
        if (cached && cached.accessToken === accessToken && now - cached.fetchedAt < USAGE_CACHE_TTL_MS) return cached.result
        if (now < cooldownUntil) {
          if (cached?.result) return cached.result
          return buildResult({
            providerId: "claude",
            providerName: NAME,
            ok: false,
            configured: true,
            error: "Rate limited (429) — Anthropic is throttling usage checks",
          })
        }

        const outcome = yield* fetchJson(http, USAGE_URL, accessToken, { "anthropic-beta": "oauth-2025-04-20" })
        if (outcome.ok) {
          const result = parseUsage(outcome.body)
          cached = { accessToken, fetchedAt: Date.now(), result }
          cooldownUntil = 0
          return result
        }
        if (outcome.error === "status" && outcome.status === 429) {
          const retryMs = outcome.retryAfterMs
          const capped =
            retryMs !== undefined ? Math.min(Math.max(retryMs, 1000), CLAUDE_429_MAX_MS) : CLAUDE_429_DEFAULT_MS
          cooldownUntil = Date.now() + capped
          const errorResult = buildResult({
            providerId: "claude",
            providerName: NAME,
            ok: false,
            configured: true,
            error: outcomeError(outcome),
          })
          cached = { accessToken, fetchedAt: Date.now(), result: errorResult }
          return errorResult
        }
        const result = buildResult({
          providerId: "claude",
          providerName: NAME,
          ok: false,
          configured: true,
          error: outcomeError(outcome),
        })
        cached = { accessToken, fetchedAt: Date.now(), result }
        // Non-429 errors don't impose cooldown — next call after TTL will retry.
        return result
      }),
  }
}

function parseUsage(payload: unknown): ReturnType<typeof buildResult> {
  if (typeof payload !== "object" || payload === null) {
    return buildResult({ providerId: "claude", providerName: NAME, ok: false, configured: true, error: "No quota data in response" })
  }
  const p = payload as Record<string, unknown>
  const windows: Record<string, ReturnType<typeof toUsageWindow>> = {}

  const limits = Array.isArray(p.limits) ? p.limits : undefined
  if (limits) {
    for (const entry of limits) {
      if (typeof entry !== "object" || entry === null) continue
      const e = entry as Record<string, unknown>
      const kind = typeof e.kind === "string" ? e.kind : ""
      const percent = typeof e.percent === "number" ? e.percent : null
      const resetsAt = toTimestamp(e.reset_at)
      if (kind === "session") {
        windows["5h"] = toUsageWindow({ usedPercent: percent, resetAt: resetsAt })
      } else if (kind === "weekly_all") {
        windows.weekly = toUsageWindow({ usedPercent: percent, resetAt: resetsAt })
      } else if (kind === "weekly_scoped" && typeof e.model === "string") {
        windows[`weekly:${String(e.model)}`] = toUsageWindow({ usedPercent: percent, resetAt: resetsAt })
      }
    }
  }

  // Legacy fallback fields when limits[] is not present.
  if (windows["5h"] === undefined && p.five_hour) {
    const fh = p.five_hour as Record<string, unknown>
    windows["5h"] = toUsageWindow({ usedPercent: typeof fh.percent === "number" ? fh.percent : null, resetAt: toTimestamp(fh.resets_at) })
  }
  if (windows.weekly === undefined && p.seven_day) {
    const sd = p.seven_day as Record<string, unknown>
    windows.weekly = toUsageWindow({ usedPercent: typeof sd.percent === "number" ? sd.percent : null, resetAt: toTimestamp(sd.resets_at) })
  }

  // Extra usage / spend cap (only when spend.enabled === true).
  const extraUsage = p.extra_usage as Record<string, unknown> | undefined
  if (extraUsage && extraUsage.enabled === true) {
    const euPercent = typeof extraUsage.percent === "number" ? extraUsage.percent : null
    const euLimit = typeof extraUsage.limit === "number" ? extraUsage.limit : undefined
    windows.extra_usage = toUsageWindow({ usedPercent: euPercent, valueLabel: euLimit !== undefined ? `$${euLimit.toFixed(2)}` : undefined })
  }

  if (Object.keys(windows).length === 0) {
    return buildResult({ providerId: "claude", providerName: NAME, ok: false, configured: true, error: "No quota data in response" })
  }
  return buildResult({ providerId: "claude", providerName: NAME, ok: true, configured: true, usage: { windows }, fetchedAt: Date.now() })
}

/**
 * Advisory CLI-backed status for diagnostics/support report.
 * Redacted and bounded: never returns tokens, full paths, or raw creds.
 * Used by migration/observability without gating inference.
 */
export function claudeQuotaStatusSummary(result: ReturnType<typeof buildResult>): string {
  if (!result) return "claude: unavailable"
  const parts: string[] = []
  parts.push(`claude: ${result.ok ? "ok" : "error"}`)
  if (result.configured) parts.push("configured")
  if (result.error) parts.push(`error=${result.error.slice(0, 80)}`)
  if (result.usage) {
    const w = Object.keys(result.usage.windows || {})
    parts.push(`windows=${w.length}`)
  }
  if (result.fetchedAt) parts.push(`cached=${Date.now() - result.fetchedAt < 300_000 ? "fresh" : "stale"}`)
  return parts.join(" ")
}
