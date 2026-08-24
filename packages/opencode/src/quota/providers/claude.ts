import { Effect } from "effect"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Auth } from "@/auth"
import { HttpClient } from "effect/unstable/http"
import { buildResult, toUsageWindow } from "../format"
import type { Adapter } from "../registry"
import { authKey } from "./key"
import { fetchJson, outcomeError } from "./http"

/**
 * Claude (Anthropic) account quota. Ported from OpenChamber (MIT).
 */
const ALIASES = ["claude", "claude-code", "anthropic"]
const NAME = "Claude"
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage"

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

export const claude = (http: HttpClient.HttpClient, auth: Auth.Interface): Adapter => ({
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
      const outcome = yield* fetchJson(http, USAGE_URL, accessToken, { "anthropic-beta": "oauth-2025-04-20" })
      if (!outcome.ok) {
        return buildResult({ providerId: "claude", providerName: NAME, ok: false, configured: true, error: outcomeError(outcome) })
      }
      const payload = outcome.body
      return parseUsage(payload)
    }),
})

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
      const resetsAt = typeof e.reset_at === "string" ? new Date(e.reset_at).getTime() : null
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
    windows["5h"] = toUsageWindow({ usedPercent: typeof fh.percent === "number" ? fh.percent : null, resetAt: typeof fh.resets_at === "string" ? new Date(fh.resets_at as string).getTime() : null })
  }
  if (windows.weekly === undefined && p.seven_day) {
    const sd = p.seven_day as Record<string, unknown>
    windows.weekly = toUsageWindow({ usedPercent: typeof sd.percent === "number" ? sd.percent : null, resetAt: typeof sd.resets_at === "string" ? new Date(sd.resets_at as string).getTime() : null })
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
