import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import {
  CLIENT_ID,
  DEFAULT_SERVER,
  getOrganizations,
  getProviderConfig,
  getUser,
  pollDeviceToken,
  refreshToken,
  resolveVerificationUrl,
  startDeviceAuthorization,
} from "@opencode-ai/core/plugin/provider/opencode-console"

type Seen = { method: string; url: string; headers: Record<string, string | undefined>; body?: string }

const decodeBody = (request: HttpClientRequest.HttpClientRequest) =>
  request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : undefined

const makeClient = (respond: (request: HttpClientRequest.HttpClientRequest) => Response) => {
  const seen: Seen[] = []
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      seen.push({
        method: request.method,
        url: request.url,
        headers: { ...request.headers },
        body: decodeBody(request),
      })
      return HttpClientResponse.fromWeb(request, respond(request))
    }),
  )
  return { http, seen }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const server = "https://console.test/console"

const deviceGrant = {
  device_code: "device-code",
  user_code: "user-code",
  verification_uri_complete: "/console/device?user_code=user-code",
  expires_in: 600,
  interval: 5,
}

describe("opencode console protocol", () => {
  test("exposes the canonical defaults", () => {
    expect(DEFAULT_SERVER).toBe("https://opencode.ai/console")
    expect(CLIENT_ID).toBe("opencode-cli")
  })

  test("startDeviceAuthorization posts the client id", async () => {
    const { http, seen } = makeClient(() => json(deviceGrant))

    const device = await Effect.runPromise(startDeviceAuthorization(http, server))

    expect(device).toEqual(deviceGrant)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.method).toBe("POST")
    expect(seen[0]!.url).toBe(`${server}/auth/device/code`)
    expect(seen[0]!.headers["content-type"]).toBe("application/json")
    expect(JSON.parse(seen[0]!.body!)).toEqual({ client_id: CLIENT_ID })
  })

  test("pollDeviceToken returns success with the token bundle", async () => {
    const { http, seen } = makeClient(() =>
      json({ access_token: "at", refresh_token: "rt", token_type: "Bearer", expires_in: 60 }),
    )

    const result = await Effect.runPromise(pollDeviceToken(http, server, "device-code"))

    expect(result).toEqual({ _tag: "success", accessToken: "at", refreshToken: "rt", expiresIn: 60 })
    expect(seen[0]!.method).toBe("POST")
    expect(seen[0]!.url).toBe(`${server}/auth/device/token`)
    expect(JSON.parse(seen[0]!.body!)).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: "device-code",
      client_id: CLIENT_ID,
    })
  })

  for (const [error, tag] of [
    ["authorization_pending", "pending"],
    ["slow_down", "slow_down"],
    ["expired_token", "expired"],
    ["access_denied", "access_denied"],
  ] as const) {
    test(`pollDeviceToken maps ${error}`, async () => {
      const { http } = makeClient(() => json({ error, error_description: `${error} description` }, 400))

      const result = await Effect.runPromise(pollDeviceToken(http, server, "device-code"))

      expect(result._tag).toBe(tag)
      if (result._tag !== "success") expect(result.error).toBe(error)
    })
  }

  test("pollDeviceToken maps other OAuth errors and tolerates a missing description", async () => {
    const { http } = makeClient(() => json({ error: "server_error" }, 400))

    const result = await Effect.runPromise(pollDeviceToken(http, server, "device-code"))

    expect(result._tag).toBe("error")
    if (result._tag === "error") {
      expect(result.error).toBe("server_error")
      expect(result.description).toBeUndefined()
    }
  })

  test("refreshToken posts the refresh grant and decodes the token", async () => {
    const { http, seen } = makeClient(() => json({ access_token: "at2", refresh_token: "rt2", expires_in: 120 }))

    const token = await Effect.runPromise(refreshToken(http, server, "rt1"))

    expect(token).toEqual({ access_token: "at2", refresh_token: "rt2", expires_in: 120 })
    expect(seen[0]!.method).toBe("POST")
    expect(seen[0]!.url).toBe(`${server}/auth/device/token`)
    expect(JSON.parse(seen[0]!.body!)).toEqual({
      grant_type: "refresh_token",
      refresh_token: "rt1",
      client_id: CLIENT_ID,
    })
  })

  test("getUser and getOrganizations send bearer auth", async () => {
    const { http, seen } = makeClient((request) => {
      if (request.url === `${server}/api/user`) return json({ id: "user-1", email: "user@example.com" })
      if (request.url === `${server}/api/orgs`) return json([{ id: "org-1", name: "One" }])
      return json({}, 404)
    })

    const user = await Effect.runPromise(getUser(http, server, "at"))
    const orgs = await Effect.runPromise(getOrganizations(http, server, "at"))

    expect(user).toEqual({ id: "user-1", email: "user@example.com" })
    expect(orgs).toEqual([{ id: "org-1", name: "One" }])
    expect(seen.map((entry) => [entry.method, entry.url])).toEqual([
      ["GET", `${server}/api/user`],
      ["GET", `${server}/api/orgs`],
    ])
    expect(seen[0]!.headers.authorization).toBe("Bearer at")
    expect(seen[1]!.headers.authorization).toBe("Bearer at")
  })

  test("getProviderConfig sends the org header and returns the config record", async () => {
    const { http, seen } = makeClient(() => json({ config: { theme: "light", seats: 5 } }))

    const config = await Effect.runPromise(getProviderConfig(http, server, "at", "org-9"))

    expect(config).toEqual({ theme: "light", seats: 5 })
    expect(seen[0]!.method).toBe("GET")
    expect(seen[0]!.url).toBe(`${server}/api/config`)
    expect(seen[0]!.headers.authorization).toBe("Bearer at")
    expect(seen[0]!.headers["x-org-id"]).toBe("org-9")
  })

  test("getProviderConfig omits the org header without an org", async () => {
    const { http, seen } = makeClient(() => json({ config: {} }))

    await Effect.runPromise(getProviderConfig(http, server, "at"))

    expect(seen[0]!.headers["x-org-id"]).toBeUndefined()
  })

  test("getProviderConfig returns undefined on 404", async () => {
    const { http } = makeClient(() => json({}, 404))

    expect(await Effect.runPromise(getProviderConfig(http, server, "at", "org-9"))).toBeUndefined()
  })
})

describe("resolveVerificationUrl", () => {
  test("roots relative verification links at the server", () => {
    expect(resolveVerificationUrl("https://opencode.ai/console", "/console/device?user_code=x")).toBe(
      "https://opencode.ai/console/device?user_code=x",
    )
  })

  test("keeps absolute http(s) links", () => {
    expect(resolveVerificationUrl("https://opencode.ai", "https://other.test/verify?code=x")).toBe(
      "https://other.test/verify?code=x",
    )
  })

  test("rejects non-http schemes", () => {
    expect(() => resolveVerificationUrl("https://opencode.ai", "ftp://evil.test/x")).toThrow("expected HTTP(S)")
  })

  test("rejects malformed urls", () => {
    expect(() => resolveVerificationUrl("https://opencode.ai", "http://[::1")).toThrow()
  })
})
