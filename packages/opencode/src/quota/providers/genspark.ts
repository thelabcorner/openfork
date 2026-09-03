import { Effect, Option } from "effect"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Auth } from "@/auth"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { buildResult, toUsageWindow } from "../format"
import type { Adapter } from "../registry"
import { authKey } from "./key"
import { createQuotaCache, NEXT_REFRESH_NOW, outcomeError } from "./http"

/**
 * Genspark credits — 2026-09-01 pack is $20 / 7500 credits = 375/$1, valid
 * 3 months. `/api/tool_cli/me` returns `credit_balance` (observed 10270.85
 * with stacked packs) and `plan`. One live session
 * (`ses_fa420c096ffedHcSjgzWc59E30`, deep-seek-v4-flash, 53,044 tokens) burned
 * 12 credits → 226/M (≈ $0.60/M), which anchors the credits/M fallback in the
 * picker when published $/M is absent.
 */
const ALIASES = ["genspark", "genspark-llm-proxy", "genspark-gemini-proxy"]
const NAME = "Genspark"
const GSK_CLI_CAPS = "cli-groups-v2,cli-paths-v3,cli-actions-v4"
const GSK_CLI_VERSION = "1.7.1"
const DEFAULT_HOST = "https://www.genspark.ai"

function host(): string {
  const value = [process.env.GENSPARK_BASE_URL, process.env.GSK_BASE_URL].find(
    (v) => typeof v === "string" && v.trim() !== "",
  )
  return (value ?? DEFAULT_HOST).trim().replace(/\/+$/, "")
}

function gskConfigPath(): string {
  const override = process.env.GSK_CONFIG?.trim()
  if (override) return override
  return join(homedir(), ".genspark-tool-cli", "config.json")
}

async function readGskFileKey(): Promise<string | undefined> {
  try {
    const raw = await readFile(gskConfigPath(), "utf8")
    const parsed = JSON.parse(raw) as { api_key?: unknown }
    if (typeof parsed.api_key !== "string") return undefined
    const k = parsed.api_key.trim()
    return k || undefined
  } catch {
    return undefined
  }
}

async function readLegacyConfigKey(): Promise<string | undefined> {
  if (process.env.BUN_TEST || process.env.NODE_ENV === "test" || !!process.env.OPENCODE_TEST_HOME || !!process.env.VITEST) return undefined
  // Best-effort legacy compat: key only in .opencode.json under
  // provider.genspark-llm-proxy.options.apiKey (from `gsk init-opencode`).
  // We read the file directly here because the Quota layer has no Config service.
  // Search cwd and parent dirs up to 5 levels (mirrors config discovery).
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    try {
      const raw = await readFile(join(dir, ".opencode.json"), "utf8")
      const parsed = JSON.parse(raw) as { provider?: Record<string, { options?: { apiKey?: unknown } }> }
      const candidates = [
        parsed.provider?.["genspark"]?.options?.apiKey,
        parsed.provider?.["genspark-llm-proxy"]?.options?.apiKey,
        parsed.provider?.["genspark-gemini-proxy"]?.options?.apiKey,
      ]
      for (const c of candidates) {
        if (typeof c === "string" && c.trim()) return c.trim()
      }
    } catch {}
    const parent = join(dir, "..")
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

async function resolveQuotaKey(auth: Auth.Interface): Promise<string | undefined> {
  // 1. Auth store (opencode auth) — primary
  const fromAuth = await Effect.runPromise(
    Effect.map(authKey(auth, ALIASES), (r) => r?.key).pipe(Effect.catch(() => Effect.succeed(undefined))),
  ).catch(() => undefined)
  if (fromAuth) return fromAuth
  // 2. Env
  const envKey = (process.env.GSK_API_KEY ?? process.env.GENSPARK_API_KEY)?.trim()
  if (envKey) return envKey
  // 3. gsk CLI file
  const fileKey = await readGskFileKey()
  if (fileKey) return fileKey
  // 4. Legacy .opencode.json
  return readLegacyConfigKey()
}

export const genspark = (http: HttpClient.HttpClient, auth: Auth.Interface): Adapter => {
  const cache = createQuotaCache<ReturnType<typeof buildResult>>("genspark", { persistentKey: "genspark", ttlMs: 300_000 })

  const withNext = (r: ReturnType<typeof buildResult>) => ({ ...r, nextRefreshAt: cache.nextRefreshAt() })

  return {
    id: "genspark",
    name: NAME,
    aliases: ALIASES,
    configured: () =>
      Effect.gen(function* () {
        if ((yield* authKey(auth, ALIASES)) !== undefined) return true
        if ((process.env.GSK_API_KEY ?? process.env.GENSPARK_API_KEY)?.trim()) return true
        if ((yield* Effect.promise(readGskFileKey)) !== undefined) return true
        if ((yield* Effect.promise(readLegacyConfigKey)) !== undefined) return true
        return false
      }),
    fetch: () =>
      Effect.gen(function* () {
        const envKey = (process.env.GSK_API_KEY ?? process.env.GENSPARK_API_KEY)?.trim()
        const key =
          (yield* authKey(auth, ALIASES))?.key ??
          (envKey && envKey.length > 0 ? envKey : undefined) ??
          (yield* Effect.promise(readGskFileKey)) ??
          (yield* Effect.promise(readGskFileKey)) ??
          (yield* Effect.promise(readLegacyConfigKey))

        if (!key) {
          return buildResult({ providerId: "genspark", providerName: NAME, ok: false, configured: false, error: "Not configured — run Genspark Sign in or set GSK_API_KEY" })
        }

        const fresh = cache.fresh(key)
        if (fresh) return withNext(fresh)
        if (cache.isCoolingDown()) {
          const c = cache.cachedResult()
          if (c) return withNext(c)
          return buildResult({ providerId: "genspark", providerName: NAME, ok: false, configured: true, error: "Rate limited — Genspark is throttling", nextRefreshAt: cache.nextRefreshAt() })
        }

        const url = `${host()}/api/tool_cli/me`
        const outcome = yield* Effect.gen(function* () {
          const req = HttpClientRequest.get(url).pipe(
            HttpClientRequest.setHeaders({
              "Content-Type": "application/json",
              "X-Api-Key": key,
              "X-GSK-CLI-Caps": GSK_CLI_CAPS,
              "X-GSK-CLI-Version": GSK_CLI_VERSION,
            }),
          )
          const raced = yield* Effect.timeoutOption(http.execute(req), "10 seconds")
          if (Option.isNone(raced)) return { ok: false as const, error: "timeout" as const }
          const response = raced.value
          if (response.status < 200 || response.status >= 300) {
            let bodySnippet: string | undefined
            try {
              const txt = (yield* response.text).trim()
              if (txt) bodySnippet = txt.slice(0, 200)
            } catch {}
            const retryAfter = response.headers
              ? (() => {
                  try {
                    const h = (response.headers as unknown as { get?: (k: string) => string | null }).get?.("retry-after") ?? null
                    if (h) return h
                    const lower = "retry-after"
                    for (const [k, v] of Object.entries(response.headers as Record<string, unknown>)) {
                      if (k.toLowerCase() === lower && typeof v === "string") return v
                    }
                  } catch {}
                  return null
                })()
              : null
            let retryAfterMs: number | undefined
            if (retryAfter) {
              const secs = Number(retryAfter.trim())
              if (Number.isFinite(secs)) retryAfterMs = secs * 1000
              else {
                const parsed = Date.parse(retryAfter)
                if (Number.isFinite(parsed)) retryAfterMs = parsed - Date.now()
              }
            }
            return {
              ok: false as const,
              error: "status" as const,
              status: response.status,
              body: bodySnippet,
              retryAfterMs,
            }
          }
          const body = yield* response.json
          return { ok: true as const, body }
        }).pipe(Effect.catch((e) => Effect.succeed({ ok: false as const, error: "network" as const, message: String((e as Error)?.message ?? e) }))) as
          | { ok: true; body: unknown }
          | { ok: false; error: "status"; status: number; body?: string; retryAfterMs?: number }
          | { ok: false; error: "network"; message: string }
          | { ok: false; error: "timeout" }

        if (!outcome.ok) {
          if (outcome.error === "status" && (outcome.status === 401 || outcome.status === 403)) {
            const msg = "Not authenticated — sign in again"
            const errRes = buildResult({ providerId: "genspark", providerName: NAME, ok: false, configured: true, error: msg })
            cache.coolDown(errRes, undefined, key)
            return withNext(errRes)
          }
          if (outcome.error === "status" && outcome.status === 429) {
            const errRes = buildResult({ providerId: "genspark", providerName: NAME, ok: false, configured: true, error: "Rate limited — Genspark is throttling" })
            cache.coolDown(errRes, (outcome as { retryAfterMs?: number }).retryAfterMs, key)
            return withNext(errRes)
          }
          const msg = outcome.error === "status" ? outcomeError(outcome as unknown as Parameters<typeof outcomeError>[0]) : outcome.error === "timeout" ? "Request timed out" : (outcome as { message: string }).message
          const errRes = buildResult({ providerId: "genspark", providerName: NAME, ok: false, configured: true, error: msg, nextRefreshAt: NEXT_REFRESH_NOW })
          return errRes
        }

        const payload = outcome.body as Record<string, unknown>
        const credit = typeof payload.credit_balance === "number" ? payload.credit_balance : typeof payload.credit_balance === "string" ? Number(payload.credit_balance) : null
        const plan = typeof payload.plan === "string" ? payload.plan : typeof payload.personal_plan === "string" ? payload.personal_plan : null

        if (credit === null || !Number.isFinite(credit)) {
          return buildResult({ providerId: "genspark", providerName: NAME, ok: false, configured: true, error: "No credit data in response", nextRefreshAt: NEXT_REFRESH_NOW })
        }

        // Format like "10,270.85 credits" — matches CLI's `gsk me` `credit_balance` display
        const formatted = credit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        const label = `${formatted} credits`

        const result = buildResult({
          providerId: "genspark",
          providerName: NAME,
          ok: true,
          configured: true,
          planLabel: plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : undefined,
          usage: {
            windows: {
              credits: toUsageWindow({ usedPercent: null, valueLabel: label }),
            },
          },
        })
        cache.store(result, key)
        return withNext(result)
      }),
  }
}
