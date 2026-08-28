import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import type { Auth } from "../../src/auth"
import type { ForkCredentials } from "../../src/fork/credentials"
import { createOfficialUsageCache } from "../../src/fork/usage-cache"
import { deepseek } from "../../src/quota/providers/deepseek"
import { kimi } from "../../src/quota/providers/kimi"
import { opencodeGo } from "../../src/quota/providers/opencode-go"
import { openrouter } from "../../src/quota/providers/openrouter"
import { claude, claudeQuotaStatusSummary, parseClaudeCredentials } from "../../src/quota/providers/claude"
import { codex } from "../../src/quota/providers/codex"
import { nvidia } from "../../src/quota/providers/nvidia"
import { resetNvidiaUsage, trackNvidiaRequest } from "../../src/quota/providers/nvidia-usage"

function authWith(entries: Record<string, Auth.Info>): Auth.Interface {
  return {
    get: (providerID) => Effect.succeed(entries[providerID]),
    all: () => Effect.succeed(entries),
    set: () => Effect.void,
    remove: () => Effect.void,
  }
}

function credentialsWith(active: ForkCredentials.Info | undefined): ForkCredentials.Interface {
  const unimplemented = () => Effect.die("not used in quota provider tests")
  return {
    list: unimplemented,
    active: () => Effect.succeed(active),
    add: unimplemented,
    select: unimplemented,
    rename: unimplemented,
    remove: unimplemented,
    recordUsage: unimplemented,
    credentialsForMessages: unimplemented,
    usageByCredential: unimplemented,
  }
}

const jsonResponse = (request: HttpClientRequest.HttpClientRequest, body: unknown, status = 200) =>
  HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }))

function httpWith(handler: (request: HttpClientRequest.HttpClientRequest) => Effect.Effect<HttpClientResponse.HttpClientResponse>) {
  const calls: HttpClientRequest.HttpClientRequest[] = []
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      calls.push(request)
      return yield* handler(request)
    }),
  )
  return { client, calls }
}

const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)

describe("QuotaProviders", () => {
  test("NVIDIA reports manually tracked requests against its 40 request/minute limit", async () => {
    const auth = authWith({ nvidia: { type: "api", key: "nvidia-key" } })
    resetNvidiaUsage()
    trackNvidiaRequest()
    trackNvidiaRequest()

    const adapter = nvidia(auth)
    expect(await run(adapter.configured())).toBe(true)
    const result = await run(adapter.fetch())

    expect(result.ok).toBe(true)
    expect(result.usage?.windows["1m"].usedPercent).toBe(5)
    expect(result.usage?.windows["1m"].remainingPercent).toBe(95)
    expect(result.usage?.windows["1m"].windowSeconds).toBe(60)

    resetNvidiaUsage()
  })

  test("missing credentials report not-configured without any network call", async () => {
    const auth = authWith({})
    const openrouterHttp = httpWith(() => Effect.die("must not be called"))
    const kimiHttp = httpWith(() => Effect.die("must not be called"))
    const deepseekHttp = httpWith(() => Effect.die("must not be called"))
    const go = opencodeGo(auth, credentialsWith(undefined), createOfficialUsageCache({ fetch: () => Promise.reject(new Error("must not be called")) }))

    expect(await run(openrouter(openrouterHttp.client, auth).configured())).toBe(false)
    expect(await run(kimi(kimiHttp.client, auth).configured())).toBe(false)
    expect(await run(deepseek(deepseekHttp.client, auth).configured())).toBe(false)
    expect(await run(go.configured())).toBe(false)

    const result = await run(openrouter(openrouterHttp.client, auth).fetch())
    expect(result.ok).toBe(false)
    expect(result.configured).toBe(false)
    expect(result.error).toBe("Not configured")
    expect(openrouterHttp.calls.length).toBe(0)
  })

  test("auth alias entries are accepted from api, oauth, and wellknown shapes", async () => {
    const auth = authWith({
      "kimi-for-coding": { type: "api", key: "kimi-key" },
      openrouter: { type: "oauth", refresh: "r", access: "or-access", expires: 1 },
      deepseek: { type: "wellknown", key: "ds", token: "ds-token" },
    })
    const noNetwork = () => Effect.die("must not be called")
    expect(await run(kimi(HttpClient.make(noNetwork), auth).configured())).toBe(true)
    expect(await run(openrouter(HttpClient.make(noNetwork), auth).configured())).toBe(true)
    expect(await run(deepseek(HttpClient.make(noNetwork), auth).configured())).toBe(true)
  })

  test("the kimi alias resolves the kimi-for-coding adapter", async () => {
    const auth = authWith({ kimi: { type: "api", key: "alias-key" } })
    const { client, calls } = httpWith((request) =>
      Effect.succeed(jsonResponse(request, {
        usage: { limit: 200, used: 50, resetTime: Math.floor(Date.now() / 1000) + 3600 },
      })),
    )
    const result = await run(kimi(client, auth).fetch())
    expect(calls.length).toBe(1)
    expect(result.ok).toBe(true)
    expect(result.usage?.windows.weekly.usedPercent).toBe(25)
    expect(result.usage?.windows.weekly.remainingPercent).toBe(75)
    expect(result.usage?.windows.weekly.resetAfterSeconds).toBeGreaterThan(3500)
  })

  test("kimi prefers used over remaining and derives from remaining alone", async () => {
    const both = await runKimi({ usage: { limit: 100, used: 40, remaining: 60 } })
    expect(both.usage?.windows.weekly.usedPercent).toBe(40)
    const remainingOnly = await runKimi({ usage: { limit: 100, remaining: 70 } })
    expect(remainingOnly.usage?.windows.weekly.usedPercent).toBe(30)
    const neither = await runKimi({ usage: { limit: 100 } })
    expect(neither.usage?.windows.weekly.usedPercent).toBe(null)

    async function runKimi(body: unknown) {
      const auth = authWith({ "kimi-for-coding": { type: "api", key: "k" } })
      const { client } = httpWith((request) => Effect.succeed(jsonResponse(request, body)))
      return run(kimi(client, auth).fetch())
    }
  })

  test("kimi rate-limit windows carry labels and reset metadata", async () => {
    const auth = authWith({ "kimi-for-coding": { type: "api", key: "k" } })
    const { client } = httpWith((request) =>
      Effect.succeed(jsonResponse(request, {
        limits: [
          { window: { duration: 5, timeUnit: 3 }, detail: { limit: 100, used: 10, remaining: 90, resetTime: Math.floor(Date.now() / 1000) + 600 } },
          { window: { duration: 2, timeUnit: 6 }, detail: { limit: 500, remaining: 100 } },
        ],
      })),
    )
    const result = await run(kimi(client, auth).fetch())
    const windows = result.usage?.windows ?? {}
    expect(windows["Rate Limit (5h)"].usedPercent).toBe(10)
    expect(windows["Rate Limit (5h)"].windowSeconds).toBe(5 * 3600)
    expect(windows["Rate Limit (5h)"].resetAfterSeconds).toBeGreaterThan(500)
    expect(windows["2d"].usedPercent).toBe(80)
    expect(windows["2d"].resetAt).toBe(null)
  })

  test("openrouter renders a monetary credit label with null percents", async () => {
    const auth = authWith({ openrouter: { type: "api", key: "or" } })
    const { client, calls } = httpWith((request) =>
      Effect.succeed(jsonResponse(request, { data: { total_credits: "19.99", total_usage: "1.06" } })),
    )
    const result = await run(openrouter(client, auth).fetch())
    expect(calls.length).toBe(1)
    expect(calls[0].headers.authorization).toBe("Bearer or")
    expect(result.ok).toBe(true)
    const credits = result.usage?.windows.credits
    expect(credits?.usedPercent).toBe(null)
    expect(credits?.remainingPercent).toBe(null)
    expect(credits?.valueLabel).toBe("$18.93 left · $1.06 spent")
  })

  test("openrouter surfaces missing quota data and API errors inside the envelope", async () => {
    const auth = authWith({ openrouter: { type: "api", key: "or" } })
    const empty = await runWith({ data: {} })
    expect(empty.ok).toBe(false)
    expect(empty.error).toBe("No quota data in response")
    const apiError = await runWith(null, 401)
    expect(apiError.ok).toBe(false)
    expect(apiError.error).toBe("API error: 401")

    async function runWith(body: unknown, status = 200) {
      const { client } = httpWith((request) => Effect.succeed(jsonResponse(request, body, status)))
      return run(openrouter(client, auth).fetch())
    }
  })

  test("deepseek reports USD balance first and falls back to CNY", async () => {
    const auth = authWith({ deepseek: { type: "api", key: "ds" } })
    const usd = await runBalance([{ currency: "CNY", total_balance: "88.00" }, { currency: "USD", total_balance: "5.50" }])
    expect(usd.usage?.windows.credits_balance.valueLabel).toBe("$5.50")
    const cny = await runBalance([{ currency: "CNY", total_balance: "88.00" }])
    expect(cny.usage?.windows.credits_balance.valueLabel).toBe("¥88.00")

    async function runBalance(balanceInfos: unknown[]) {
      const { client } = httpWith((request) => Effect.succeed(jsonResponse(request, { balance_infos: balanceInfos })))
      return run(deepseek(client, auth).fetch())
    }
  })

  test("opencode-go maps the official snapshot windows through the fork usage gate", async () => {
    const auth = authWith({})
    let gateFetches = 0
    const usageCache = createOfficialUsageCache({
      fetch: () => {
        gateFetches += 1
        return Promise.resolve(
          new Response(
            JSON.stringify({
              usage: {
                rolling: { percent: 42, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
                weekly: { percent: 10, resetsAt: new Date(Date.now() + 86_400_000).toISOString() },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        )
      },
    })
    const adapter = opencodeGo(auth, credentialsWith({ id: "cred-1", label: "main", key: "go-key", active: true, timeCreated: 1 }), usageCache)

    expect(await run(adapter.configured())).toBe(true)
    const first = await run(adapter.fetch())
    expect(first.ok).toBe(true)
    expect(first.usage?.windows["5h"].usedPercent).toBe(42)
    expect(first.usage?.windows["5h"].remainingPercent).toBe(58)
    expect(first.usage?.windows.weekly.usedPercent).toBe(10)
    expect("monthly" in (first.usage?.windows ?? {})).toBe(false)
    // Partial windows are valid and the gate absorbs repeat fetches.
    const second = await run(adapter.fetch())
    expect(second.ok).toBe(true)
    expect(gateFetches).toBe(1)
  })

  test("opencode-go without any credential reports not-configured", async () => {
    const auth = authWith({})
    const usageCache = createOfficialUsageCache({ fetch: () => Promise.reject(new Error("must not be called")) })
    const adapter = opencodeGo(auth, credentialsWith(undefined), usageCache)
    expect(await run(adapter.configured())).toBe(false)
    const result = await run(adapter.fetch())
    expect(result.configured).toBe(false)
    expect(result.ok).toBe(false)
  })
})

describe("ClaudeProvider", () => {
  test("maps the limits[] array into session/weekly/model-scoped windows", async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    const auth = authWith({ claude: { type: "oauth", access: "cc", refresh: "r", expires: 9 } } as unknown as Record<string, Auth.Info>)
    const resetSoon = new Date(Date.now() + 3_600_000).toISOString()
    const { client, calls } = httpWith((request) =>
      Effect.succeed(jsonResponse(request, {
        limits: [
          { kind: "session", percent: 42, reset_at: resetSoon },
          { kind: "weekly_all", percent: 18, reset_at: resetSoon },
          { kind: "weekly_scoped", model: "claude-opus-4-1", percent: 5, reset_at: resetSoon },
        ],
        extra_usage: { enabled: true, monthly_limit: 10, monthly_used: 2 },
      })),
    )
    const adapter = claude(client, auth)
    expect(await run(adapter.configured())).toBe(true)
    const result = await run(adapter.fetch())
    expect(calls.length).toBe(1)
    expect(calls[0].headers.authorization).toBe("Bearer cc")
    expect(String(calls[0].headers["anthropic-beta"])).toContain("oauth")
    expect(result.ok).toBe(true)
    expect(result.usage?.windows["5h"].usedPercent).toBe(42)
    expect(result.usage?.windows.weekly.usedPercent).toBe(18)
    expect(Object.keys(result.usage?.windows ?? {}).some((key) => key.startsWith("weekly:") && key.includes("opus"))).toBe(true)
    expect(result.usage?.windows.extra_usage).toBeDefined()
  })

  test("legacy five_hour/seven_day fields fill in when limits[] is absent", async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    const auth = authWith({ anthropic: { type: "oauth", access: "cc" } } as unknown as Record<string, Auth.Info>)
    const { client } = httpWith((request) =>
      Effect.succeed(jsonResponse(request, {
        five_hour: { percent: 70, resets_at: new Date(Date.now() + 1_000).toISOString() },
        seven_day: { percent: 20 },
      })),
    )
    const result = await run(claude(client, auth).fetch())
    expect(result.ok).toBe(true)
    expect(result.usage?.windows["5h"].usedPercent).toBe(70)
    expect(result.usage?.windows.weekly.usedPercent).toBe(20)
    expect(result.usage?.windows.extra_usage).toBeUndefined()
  })

  test("auth errors and missing data fold into the envelope without throwing", async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    const auth = authWith({ claude: { type: "oauth", access: "cc" } } as unknown as Record<string, Auth.Info>)
    const unauthorized = await runWith(null, 401)
    expect(unauthorized.ok).toBe(false)
    expect(unauthorized.error).toBe("API error: 401")
    const empty = await runWith({})
    expect(empty.ok).toBe(false)
    expect(empty.error).toBe("No quota data in response")

    async function runWith(body: unknown, status = 200) {
      const { client } = httpWith((request) => Effect.succeed(jsonResponse(request, body, status)))
      return run(claude(client, auth).fetch())
    }
  })

  test("caches usage checks for 5 minutes, including rate-limit responses", async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    const auth = authWith({ claude: { type: "oauth", access: "cc" } } as unknown as Record<string, Auth.Info>)
    const { client, calls } = httpWith((request) => Effect.succeed(jsonResponse(request, null, 429)))
    const adapter = claude(client, auth)

    const first = await run(adapter.fetch())
    const second = await run(adapter.fetch())

    expect(first.error).toBe("Rate limited (429) — Anthropic is throttling usage checks")
    expect(second).toEqual(first)
    expect(calls.length).toBe(1)
  })

  test("unconfigured without alias or env token makes no network call", async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    // Isolate from any real ~/.claude/.credentials.json on this machine.
    const prevUserProfile = process.env.USERPROFILE
    const prevHome = process.env.HOME
    process.env.USERPROFILE = "Z:\\nonexistent-opencode-test-home"
    process.env.HOME = "/nonexistent-opencode-test-home"
    try {
      const auth = authWith({})
      const { client, calls } = httpWith(() => Effect.die("must not be called"))
      expect(await run(claude(client, auth).configured())).toBe(false)
      const result = await run(claude(client, auth).fetch())
      expect(result.configured).toBe(false)
      expect(calls.length).toBe(0)
    } finally {
      if (prevUserProfile !== undefined) process.env.USERPROFILE = prevUserProfile
      else delete process.env.USERPROFILE
      if (prevHome !== undefined) process.env.HOME = prevHome
      else delete process.env.HOME
    }
  })

  test("claudeQuotaStatusSummary is redacted/bounded and advisory-only", () => {
    const ok = { ok: true, configured: true, usage: { windows: { "5h": {} } }, fetchedAt: Date.now() } as any
    const s = claudeQuotaStatusSummary(ok)
    expect(s).toContain("claude: ok")
    expect(s).toContain("configured")
    expect(s).not.toContain("token")
    expect(s.length).toBeLessThan(200)

    const err = { ok: false, configured: true, error: "Rate limited (429) — Anthropic is throttling usage checks" } as any
    expect(claudeQuotaStatusSummary(err)).toContain("error=Rate limited")
  })
})

describe("ClaudeCredentials", () => {
  test("parses the claudeAiOauth envelope, bare accessToken, and tokens shapes", () => {
    expect(parseClaudeCredentials(JSON.stringify({ claudeAiOauth: { accessToken: "tok-1", refreshToken: "r", expiresAt: 1 } }))).toBe("tok-1")
    expect(parseClaudeCredentials(JSON.stringify({ accessToken: "tok-2" }))).toBe("tok-2")
    expect(parseClaudeCredentials(JSON.stringify({ tokens: { access_token: "tok-3" } }))).toBe("tok-3")
    expect(parseClaudeCredentials("{}")).toBeUndefined()
    expect(parseClaudeCredentials("not json at all")).toBeUndefined()
  })
})

describe("CodexProvider", () => {
  test("maps primary/secondary rate windows plus credits and spend control", async () => {
    const auth = authWith({ openai: { type: "oauth", access: "gpt", accountId: "acct-1" } } as unknown as Record<string, Auth.Info>)
    const reset = new Date(Date.now() + 7_200_000).toISOString()
    const { client, calls } = httpWith((request) =>
      Effect.succeed(jsonResponse(request, {
        rate_limit: {
          primary_window: { limit_window_seconds: 18_000, used_percent: 61, reset_at: reset },
          secondary_window: { limit_window_seconds: 604_800, used_percent: 12 },
        },
        credits: { balance: 4.5, unlimited: false },
        spend_control: { individual_limit: { enabled: true, spent: 3.25, limit: 40 } },
      })),
    )
    const result = await run(codex(client, auth).fetch())
    expect(calls.length).toBe(1)
    expect(calls[0].headers.authorization).toBe("Bearer gpt")
    expect(String(calls[0].headers["chatgpt-account-id"])).toBe("acct-1")
    expect(result.ok).toBe(true)
    expect(result.usage?.windows["5h"].usedPercent).toBe(61)
    expect(result.usage?.windows.weekly.windowSeconds).toBe(604_800)
    expect(result.usage?.windows.credits.valueLabel).toContain("$4.50")
    expect(result.usage?.windows.credits_spend.usedPercent).toBeCloseTo(8.125)
  })

  test("401 folds into a re-auth message and unlimited credits skip balance label", async () => {
    const auth = authWith({ codex: { type: "oauth", access: "gpt" } } as unknown as Record<string, Auth.Info>)
    const expired = await runWith(null, 401)
    expect(expired.error).toContain("re-authenticate with OpenAI")
    const unlimited = await runWith({ rate_limit: {}, credits: { unlimited: true } })
    expect(unlimited.ok).toBe(true)
    expect(unlimited.usage?.windows.credits.valueLabel).toBe("Unlimited")

    async function runWith(body: unknown, status = 200) {
      const { client } = httpWith((request) => Effect.succeed(jsonResponse(request, body, status)))
      return run(codex(client, auth).fetch())
    }
  })

  test("missing credentials report not-configured without network", async () => {
    const auth = authWith({})
    const { client, calls } = httpWith(() => Effect.die("must not be called"))
    expect(await run(codex(client, auth).configured())).toBe(false)
    const result = await run(codex(client, auth).fetch())
    expect(result.configured).toBe(false)
    expect(calls.length).toBe(0)
  })
})
