import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Credential } from "@opencode-ai/core/credential"
import { Integration } from "@opencode-ai/core/integration"
import {
  consoleConfigFetcher,
  makeAccountConfigCache,
} from "@opencode-ai/core/plugin/provider/opencode-account-config"

const METHOD_ID = Integration.MethodID.make("device")

const oauth = (access: string, server: string, orgID: string, refresh = `refresh-${access}`) =>
  Credential.OAuth.make({
    type: "oauth",
    methodID: METHOD_ID,
    access,
    refresh,
    expires: Date.now() + 60_000,
    metadata: { server, orgID },
  })

const input = (
  scope: string,
  id: string,
  revision: number,
  access: string,
  server = "https://console.example",
  org = "org-a",
  refresh?: string,
) => ({
  scope,
  credentialID: Credential.ID.make(id),
  revision,
  value: oauth(access, server, org, refresh),
})

describe("OpenCode account config cache", () => {
  test("production fetch adapter delegates to the shared Console config wire owner", async () => {
    const seen: HttpClientRequest.HttpClientRequest[] = []
    const http = HttpClient.make((request) => {
      seen.push(request)
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ config: { model: "opencode/remote" } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      )
    })

    const result = await Effect.runPromise(
      consoleConfigFetcher(http)({
        server: "https://console.example/console",
        accessToken: "account-token",
        orgID: "org-a",
      }),
    )

    expect(result).toEqual({ model: "opencode/remote" })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.method).toBe("GET")
    expect(seen[0]!.url).toBe("https://console.example/console/api/config")
    expect(seen[0]!.headers.authorization).toBe("Bearer account-token")
    expect(seen[0]!.headers["x-org-id"]).toBe("org-a")
  })

  test("coalesces concurrent fills and partitions by authority scope", async () => {
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const cache = makeAccountConfigCache({
      fetch: ({ orgID }) =>
        Effect.promise(async () => {
          calls++
          await gate
          return { model: `opencode/model-${orgID}` }
        }),
    })

    const account = input("realm-a", "cred_a", 1, "token-a")
    const pending = Array.from({ length: 20 }, () => Effect.runPromise(cache.resolve(account)))
    await Promise.resolve()
    release()
    const snapshots = await Promise.all(pending)

    expect(calls).toBe(1)
    expect(snapshots.every((snapshot) => snapshot.credentialRevision === 1)).toBe(true)
    expect(snapshots.every((snapshot) => snapshot.version === 1)).toBe(true)

    await Effect.runPromise(cache.resolve(input("realm-b", "cred_a", 1, "token-a")))
    expect(calls).toBe(2)
    expect(cache.size()).toBe(2)
  })

  test("credential revision replaces only that account slot without retaining token material", async () => {
    const seen: string[] = []
    const cache = makeAccountConfigCache({
      fetch: ({ accessToken }) => {
        seen.push(accessToken)
        return Effect.succeed({ model: `opencode/model-r${seen.length}` })
      },
    })

    const first = await Effect.runPromise(cache.resolve(input("realm-a", "cred_a", 1, "token-one")))
    const cached = await Effect.runPromise(cache.resolve(input("realm-a", "cred_a", 1, "token-one")))
    const rotated = await Effect.runPromise(cache.resolve(input("realm-a", "cred_a", 2, "token-two")))

    expect(seen).toEqual(["token-one", "token-two"])
    expect(cached.version).toBe(first.version)
    expect(rotated.version).toBe(first.version + 1)
    expect(rotated.credentialRevision).toBe(2)
    expect(JSON.stringify(rotated)).not.toContain("token-one")
    expect(JSON.stringify(rotated)).not.toContain("token-two")
  })

  test("server and organization are part of the stable account slot", async () => {
    const calls: Array<{ server: string; orgID?: string }> = []
    const cache = makeAccountConfigCache({
      fetch: ({ server, orgID }) => {
        calls.push({ server, orgID })
        return Effect.succeed({ model: `opencode/${orgID}` })
      },
    })

    await Effect.runPromise(cache.resolve(input("realm-a", "cred_a", 1, "token-a", "https://one.example", "org-a")))
    await Effect.runPromise(cache.resolve(input("realm-a", "cred_a", 1, "token-a", "https://one.example", "org-b")))
    await Effect.runPromise(cache.resolve(input("realm-a", "cred_a", 1, "token-a", "https://two.example", "org-b")))

    expect(calls).toEqual([
      { server: "https://one.example", orgID: "org-a" },
      { server: "https://one.example", orgID: "org-b" },
      { server: "https://two.example", orgID: "org-b" },
    ])
    expect(cache.size()).toBe(3)
  })

  test("bounded expiry refetches and advances config version without credential rotation", async () => {
    let clock = 1_000
    let calls = 0
    const cache = makeAccountConfigCache({
      ttlMs: 100,
      now: () => clock,
      fetch: () => {
        calls++
        return Effect.succeed({ model: `opencode/model-${calls}` })
      },
    })
    const account = input("realm-a", "cred_a", 7, "token-a")

    const first = await Effect.runPromise(cache.resolve(account))
    clock = 1_099
    const stillFresh = await Effect.runPromise(cache.resolve(account))
    clock = 1_100
    const refreshed = await Effect.runPromise(cache.resolve(account))

    expect(calls).toBe(2)
    expect(stillFresh.version).toBe(first.version)
    expect(refreshed.version).toBe(first.version + 1)
    expect(refreshed.credentialRevision).toBe(7)
  })

  test("refuses to retain a remote config that embeds any resolved credential secret", async () => {
    const accessCache = makeAccountConfigCache({
      fetch: ({ accessToken }) => Effect.succeed({ model: `leak-${accessToken}` }),
    })

    await expect(
      Effect.runPromise(accessCache.resolve(input("realm-a", "cred_a", 1, "sensitive-token"))),
    ).rejects.toThrow("credential secret material")

    const refreshSecret = "independent-refresh-secret"
    const refreshCache = makeAccountConfigCache({
      fetch: () => Effect.succeed({ model: `leak-${refreshSecret}` }),
    })

    await expect(
      Effect.runPromise(
        refreshCache.resolve(
          input(
            "realm-a",
            "cred_a",
            1,
            "access-secret-with-no-overlap",
            "https://console.example",
            "org-a",
            refreshSecret,
          ),
        ),
      ),
    ).rejects.toThrow("credential secret material")
  })

  test("explicit invalidation and LRU bounding do not affect other realm/account slots", async () => {
    let calls = 0
    const cache = makeAccountConfigCache({
      maxEntries: 2,
      fetch: () => {
        calls++
        return Effect.succeed({})
      },
    })

    await Effect.runPromise(cache.resolve(input("realm-a", "cred_a", 1, "token-a")))
    await Effect.runPromise(cache.resolve(input("realm-a", "cred_b", 1, "token-b")))
    await Effect.runPromise(cache.resolve(input("realm-b", "cred_c", 1, "token-c")))
    expect(cache.size()).toBe(2)

    cache.invalidate({ scope: "realm-b", credentialID: Credential.ID.make("cred_c") })
    expect(cache.size()).toBe(1)

    await Effect.runPromise(cache.resolve(input("realm-a", "cred_b", 1, "token-b")))
    expect(calls).toBe(3)
  })
})
