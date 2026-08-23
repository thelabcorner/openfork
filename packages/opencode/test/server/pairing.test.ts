import { afterEach, describe, expect, test } from "bun:test"
import { Flag } from "@opencode-ai/core/flag/flag"
import { PAIRING } from "@opencode-ai/core/device"
import { Server } from "../../src/server/server"
import { DevicePaths } from "../../src/server/routes/instance/httpapi/groups/device"
import { PairPaths } from "../../src/server/routes/instance/httpapi/groups/pair"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

const original = {
  flagPassword: Flag.OPENCODE_SERVER_PASSWORD,
  flagUsername: Flag.OPENCODE_SERVER_USERNAME,
  envPassword: process.env.OPENCODE_SERVER_PASSWORD,
  envUsername: process.env.OPENCODE_SERVER_USERNAME,
}
const auth = { username: "opencode", password: "pairing-secret" }

afterEach(async () => {
  Flag.OPENCODE_SERVER_PASSWORD = original.flagPassword
  Flag.OPENCODE_SERVER_USERNAME = original.flagUsername
  if (original.envPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
  else process.env.OPENCODE_SERVER_PASSWORD = original.envPassword
  if (original.envUsername === undefined) delete process.env.OPENCODE_SERVER_USERNAME
  else process.env.OPENCODE_SERVER_USERNAME = original.envUsername
  await resetDatabase()
})

async function startListener() {
  Flag.OPENCODE_SERVER_PASSWORD = auth.password
  Flag.OPENCODE_SERVER_USERNAME = auth.username
  process.env.OPENCODE_SERVER_PASSWORD = auth.password
  process.env.OPENCODE_SERVER_USERNAME = auth.username
  return Server.listen({ hostname: "127.0.0.1", port: 0 })
}

function authorization() {
  return `Basic ${btoa(`${auth.username}:${auth.password}`)}`
}

function stop(listener: Awaited<ReturnType<typeof startListener>>) {
  return listener.stop(true)
}

async function begin(listener: Awaited<ReturnType<typeof startListener>>, headers?: Record<string, string>) {
  return fetch(new URL(PairPaths.begin, listener.url), {
    method: "POST",
    headers: headers ?? { authorization: authorization() },
  })
}

interface PairBegin {
  code: string
  url: string
  expiresAt: string
}

interface PairClaim {
  token: string
  device: { id: string; name: string }
  server: { name: string; version: string }
}

async function claim(listener: Awaited<ReturnType<typeof startListener>>, code: string) {
  return fetch(new URL(PairPaths.claim, listener.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  })
}

// Reads the SSE stream until a frame matching `predicate` arrives, then closes.
// A single sequential read loop; the abort signal breaks any pending read.
async function firstSSEFrame(url: URL) {
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), 8_000)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (response.status !== 200) return { status: response.status as number, frame: undefined }
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffered = ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffered += decoder.decode(value, { stream: true })
      if (buffered.includes("server.connected")) return { status: 200 as number, frame: buffered }
    }
    return { status: 200 as number, frame: buffered || undefined }
  } catch {
    // Aborted before server.connected arrived.
    return { status: undefined as unknown as number, frame: undefined }
  } finally {
    clearTimeout(deadline)
    controller.abort()
  }
}

describe("device pairing over Server.listen", () => {
  test(
    "full ceremony: begin -> claim -> device-token auth incl. SSE query param -> revoke",
    async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const listener = await startListener()
    try {
      // begin requires auth
      const unauthenticated = await begin(listener, {})
      expect(unauthenticated.status).toBe(401)

      const begun = await begin(listener)
      expect(begun.status).toBe(200)
      const pair = (await begun.json()) as PairBegin
      expect(pair.code).toMatch(new RegExp(`^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{${PAIRING.codeLength}}$`))
      expect(pair.url).toContain(`#pair=${pair.code}`)
      expect(new Date(pair.expiresAt).getTime()).toBeGreaterThan(Date.now())

      // claim is unauthenticated by design and returns a one-time token
      const claimedResponse = await claim(listener, pair.code)
      expect(claimedResponse.status).toBe(200)
      const claimed = (await claimedResponse.json()) as PairClaim
      expect(claimed.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(claimed.device.name).toBe("Paired device")
      expect(claimed.server.version).toBeTruthy()

      // single-use: replaying the code fails
      expect((await claim(listener, pair.code)).status).toBe(400)

      // device token authenticates instance routes as Bearer...
      const listed = await fetch(new URL(DevicePaths.list, listener.url), {
        headers: { authorization: `Bearer ${claimed.token}`, "x-opencode-directory": tmp.path },
      })
      expect(listed.status).toBe(200)
      const devices = (await listed.json()) as Array<{ id: string; name: string; tokenPrefix: string }>
      expect(devices).toHaveLength(1)
      expect(devices[0]?.id).toBe(claimed.device.id)
      expect(devices[0]?.tokenPrefix).toBe(claimed.token.slice(0, 8))

      // ...as a Basic password (ServerConnection.Http shape)...
      const basic = await fetch(new URL(DevicePaths.list, listener.url), {
        headers: { authorization: `Basic ${btoa(`device:${claimed.token}`)}` },
      })
      expect(basic.status).toBe(200)

      // ...and on the SSE /event route via raw auth_token query param.
      const eventURL = new URL("/event", listener.url)
      eventURL.searchParams.set("directory", tmp.path)
      eventURL.searchParams.set("auth_token", claimed.token)
      const sse = await firstSSEFrame(eventURL)
      expect(sse.status).toBe(200)
      expect(sse.frame).toContain("server.connected")

      // revoke kills the token everywhere
      const removed = await fetch(
        new URL(DevicePaths.remove.replace(":deviceID", claimed.device.id), listener.url),
        { method: "DELETE", headers: { authorization: `Bearer ${claimed.token}` } },
      )
      expect(removed.status).toBe(200)
      expect(await removed.json()).toBe(true)

      const afterRevoke = await fetch(new URL(DevicePaths.list, listener.url), {
        headers: { authorization: `Bearer ${claimed.token}` },
      })
      expect(afterRevoke.status).toBe(401)
    } finally {
      await stop(listener).catch(() => undefined)
    }
  },
  30_000,
)

  test("claim rejects wrong codes with 400 and rate-limits floods with 429", async () => {
    const listener = await startListener()
    try {
      const wrong = await claim(listener, "WRONG")
      expect(wrong.status).toBe(400)
      const body = (await wrong.json()) as { name?: string; data?: { reason?: string } }
      expect(body.name).toBe("PairCodeError")
      expect(body.data?.reason).toBe("invalid")

      // Per-IP bucket: burst is CLAIM_RATE_LIMIT.burst; one attempt already spent.
      let sawRateLimit = false
      for (let i = 0; i < 24; i++) {
        const response = await claim(listener, "WRONG")
        if (response.status === 429) {
          sawRateLimit = true
          const limited = (await response.json()) as { data?: { retryAfterMs?: number } }
          expect(limited.data?.retryAfterMs).toBeGreaterThan(0)
          break
        }
      }
      expect(sawRateLimit).toBe(true)
    } finally {
      await stop(listener).catch(() => undefined)
    }
  })
})
