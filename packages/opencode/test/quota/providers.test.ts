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
