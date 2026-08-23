import { afterEach, describe, expect, test, afterAll } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import path from "node:path"

/**
 * PWA device-pairing integration gate (task p4).
 *
 * Proves the ceremony END TO END against a real `Server.listen` listener:
 * begin -> claim -> authenticated requests (Bearer + Basic) -> SSE event via
 * query-param token only -> revoke -> 401, plus the negative matrix
 * (expired code, wrong-code attempt cap, reused code, rate-limit trip).
 *
 * Contract reconciled against src/server/routes/instance/httpapi/groups/pair.ts
 * and groups/device.ts (p1). Until the routes exist in the tree, ceremony
 * tests skip via `test.skipIf`; the harness smoke test always runs.
 *
 * Isolation (operator mandate): explicit random non-zero port (never 0 —
 * port 0 prefers 4096, the live dev backend), OPENCODE_DB at a gitignored
 * in-tree temp path set BEFORE the first opencode module import (Flag
 * snapshots process.env at module load, so every opencode import here is
 * dynamic), listener stopped and port verified free in every finally.
 * Run targeted:
 *   bun test --timeout 30000 test/server/pairing-e2e.test.ts
 */

// ---------------------------------------------------------------------------
// Pairing contract (reconciled with p1's groups/pair.ts + groups/device.ts).
// ---------------------------------------------------------------------------
const PAIR_BEGIN = "/pair/begin" // POST, AUTH REQUIRED (desktop mints codes)
const PAIR_CLAIM = "/pair/claim" // POST {code, name?} -> {token, device:{id,name}, server}; PUBLIC by design
const DEVICES_LIST = "/devices" // GET, AUTH REQUIRED -> DeviceInfo[]
const DEVICE_REVOKE = "/devices/:deviceID" // DELETE, AUTH REQUIRED -> boolean
const EVENT_PATH = "/event"
const AUTH_PROBE_PATH = "/config"
// Query param carrying credentials for EventSource/SSE (headers cannot be set
// there). The existing channel is auth_token (base64 user:pass); whether the
// device token is accepted there directly is part of p1's middleware work —
// reconciled at handoff.
const QUERY_TOKEN_PARAM = "auth_token"
const BASIC_USERNAME = "opencode"
const BASIC_PASSWORD = "gate-secret"
// Pair-code TTL is a hard module constant in core/device (90s, no env
// affordance), so the expired-code negative waits out the REAL ttl instead of
// injecting one — no production change required.
const PAIR_TTL_MS = 90_000

type Listener = Awaited<ReturnType<typeof import("../../src/server/server").Server.listen>>

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let gateRoot: string | undefined

// Scratch stays in-tree under the gitignored `tmp/` (coordinator permission
// guidance: never external temp dirs). Resolved from this file so it is
// cwd-independent.
const GATE_TMP_ROOT = path.resolve(import.meta.dir, "../../tmp/pairing-gate")

async function gateEnv() {
  if (gateRoot) return gateRoot
  await mkdir(GATE_TMP_ROOT, { recursive: true })
  const root = await mkdtemp(path.join(GATE_TMP_ROOT, "run-"))
  // Must happen before ANY opencode module import in this process.
  process.env.OPENCODE_DB = path.join(root, "gate.db")
  await writeFile(path.join(root, "opencode.json"), JSON.stringify({ formatter: false, lsp: false }))
  gateRoot = root
  return root
}

afterAll(async () => {
  await rm(GATE_TMP_ROOT, { recursive: true, force: true }).catch(() => undefined)
})

async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const port = 20_000 + Math.floor(Math.random() * 20_000)
    if (await isPortFree(port)) return port
  }
  throw new Error("no free port found for gate listener")
}

function isPortFree(port: number) {
  return new Promise<boolean>((resolve) => {
    const probe = net.createServer()
    probe.once("error", () => resolve(false))
    probe.once("listening", () => probe.close(() => resolve(true)))
    probe.listen(port, "127.0.0.1")
  })
}

async function startGateListener(auth?: { username: string; password: string }) {
  await gateEnv()
  const [{ Server }, { withTimeout }] = await Promise.all([
    import("../../src/server/server"),
    import("../../src/util/timeout"),
  ])
  // ServerAuth.Config reads env through a fresh ConfigProvider per listener,
  // so setting process.env here scopes credentials to this listener.
  const previousPassword = process.env.OPENCODE_SERVER_PASSWORD
  const previousUsername = process.env.OPENCODE_SERVER_USERNAME
  if (auth) {
    process.env.OPENCODE_SERVER_PASSWORD = auth.password
    process.env.OPENCODE_SERVER_USERNAME = auth.username
  } else {
    delete process.env.OPENCODE_SERVER_PASSWORD
    delete process.env.OPENCODE_SERVER_USERNAME
  }
  try {
    const port = await freePort()
    const listener = await withTimeout(Server.listen({ hostname: "127.0.0.1", port }), 30_000, "gate listener start")
    return { listener, withTimeout }
  } finally {
    if (previousPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
    else process.env.OPENCODE_SERVER_PASSWORD = previousPassword
    if (previousUsername === undefined) delete process.env.OPENCODE_SERVER_USERNAME
    else process.env.OPENCODE_SERVER_USERNAME = previousUsername
  }
}

async function stopListener(listener: Listener) {
  await listener.stop(true)
}

/** Stops and verifies the port is released (operator mandate). */
async function stopGateListener(listener: Listener) {
  await stopListener(listener)
  expect(await isPortFree(listener.port)).toBe(true)
}

async function cleanupDatabase() {
  if (!gateRoot) return
  await gateEnv()
  const [{ resetDatabase }, { disposeAllInstances }] = await Promise.all([
    import("../fixture/db"),
    import("../fixture/fixture"),
  ])
  await disposeAllInstances().catch(() => undefined)
  await resetDatabase()
}

afterEach(async () => {
  await cleanupDatabase()
})

function basicHeader(username: string, password: string) {
  return { authorization: `Basic ${btoa(`${username}:${password}`)}` }
}

function jsonRequest(url: URL, method: string, body?: unknown, headers?: Record<string, string>) {
  return fetch(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

/** True when the pairing routes exist (p1 landed); false -> ceremony tests skip.
 * The UI catch-all route answers unknown paths with 200 HTML, so presence
 * requires a JSON response, not merely a non-404. */
async function pairingRoutesPresent(base: URL) {
  const response = await jsonRequest(new URL(PAIR_BEGIN, base), "POST", {})
  if (response.status === 404 || response.status === 405) return false
  return (response.headers.get("content-type") ?? "").includes("application/json")
}

/**
 * Reads SSE frames until `predicate` matches a data payload, then aborts.
 * Rejects on non-200 or when nothing matches within `timeoutMs`.
 */
async function readSseUntil(
  url: URL,
  predicate: (data: string) => boolean,
  timeoutMs: number,
  headers?: Record<string, string>,
) {
  const controller = new AbortController()
  const response = await fetch(url, { headers, signal: controller.signal })
  if (response.status !== 200 || !response.body) {
    controller.abort()
    throw new Error(`SSE ${url.pathname} returned ${response.status}`)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`timed out reading SSE ${url.pathname}`)), deadline - Date.now()),
        ),
      ])
      if (chunk.done) throw new Error(`SSE ${url.pathname} closed before match`)
      buffer += decoder.decode(chunk.value, { stream: true })
      for (const line of buffer.split("\n")) {
        const data = line.startsWith("data: ") ? line.slice("data: ".length).trim() : undefined
        if (data && predicate(data)) return data
      }
    }
    throw new Error(`timed out waiting for SSE match on ${url.pathname}`)
  } finally {
    controller.abort()
    reader.cancel().catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// One-time presence probe at module scope (top-level await) so the ceremony
// tests can use test.skipIf — this bun version's test context has no .skip().
const PAIRING_PRESENT = await (async () => {
  const { listener } = await startGateListener()
  try {
    return await pairingRoutesPresent(listener.url)
  } finally {
    await stopListener(listener)
  }
})()

describe("pairing integration gate", () => {
  test("harness: explicit random port, temp OPENCODE_DB, SSE server.connected", async () => {
    const root = await gateEnv()
    const { listener, withTimeout } = await startGateListener()
    try {
      expect(listener.port).not.toBe(4096)
      expect(listener.port).not.toBe(30084)

      const url = new URL(`${EVENT_PATH}?directory=${encodeURIComponent(root)}`, listener.url)
      const event = await withTimeout(
        readSseUntil(url, (data) => data.includes("server.connected"), 10_000),
        15_000,
        "harness SSE read",
      )
      expect(JSON.parse(event)).toMatchObject({ type: "server.connected" })
    } finally {
      await withTimeout(stopGateListener(listener), 15_000, "harness listener stop")
    }
  })

  test.skipIf(!PAIRING_PRESENT)(
    "ceremony: begin -> claim -> Bearer+Basic authed requests -> SSE query-param only -> revoke -> 401",
    async () => {
      const root = await gateEnv()
      const { listener, withTimeout } = await startGateListener({
        username: BASIC_USERNAME,
        password: BASIC_PASSWORD,
      })
      try {
        const basic = basicHeader(BASIC_USERNAME, BASIC_PASSWORD)

        // --- begin (authenticated: the desktop mints codes) ---
        const begin = await jsonRequest(new URL(PAIR_BEGIN, listener.url), "POST", {}, basic)
        expect(begin.status).toBe(200)
        const beginBody = (await begin.json()) as { code: string; url: string; expiresAt: string }
        expect(beginBody.code).toBeTruthy()
        // The QR URL must carry the code in the FRAGMENT (#pair=) — the PWA
        // claim-on-boot parses location.hash; a ?pair= query would never fire.
        expect(beginBody.url).toContain(`#pair=${beginBody.code}`)

        // --- unauthenticated requests are rejected while credentials are set ---
        const probeURL = new URL(`${AUTH_PROBE_PATH}?directory=${encodeURIComponent(root)}`, listener.url)
        expect((await fetch(probeURL)).status).toBe(401)

        // --- claim (public by design: it IS the auth bootstrap) ---
        const claim = await jsonRequest(new URL(PAIR_CLAIM, listener.url), "POST", {
          code: beginBody.code,
          name: "gate-e2e",
        })
        expect(claim.status).toBe(200)
        const claimBody = (await claim.json()) as {
          token: string
          device: { id: string; name: string }
          server: { name: string; version: string }
        }
        expect(claimBody.token).toBeTruthy()
        expect(claimBody.device.id).toBeTruthy()

        const bearer = { authorization: `Bearer ${claimBody.token}` }
        const deviceBasic = basicHeader(BASIC_USERNAME, claimBody.token)

        // --- authed requests with the device token, both header forms ---
        expect((await fetch(probeURL, { headers: bearer })).status).toBe(200)
        expect((await fetch(probeURL, { headers: deviceBasic })).status).toBe(200)

        // --- SSE receives events using ONLY the query-param token ---
        const sseURL = new URL(
          `${EVENT_PATH}?directory=${encodeURIComponent(root)}&${QUERY_TOKEN_PARAM}=${encodeURIComponent(claimBody.token)}`,
          listener.url,
        )
        const connected = await withTimeout(
          readSseUntil(sseURL, (data) => data.includes("server.connected"), 10_000),
          15_000,
          "ceremony SSE connect",
        )
        expect(JSON.parse(connected)).toMatchObject({ type: "server.connected" })

        // Live fan-out: an authed mutation must arrive on the query-param stream.
        const streamPromise = withTimeout(
          readSseUntil(sseURL, (data) => data.includes("session.created"), 10_000),
          15_000,
          "ceremony SSE fan-out",
        )
        const created = await fetch(new URL(`/session?directory=${encodeURIComponent(root)}`, listener.url), {
          method: "POST",
          headers: bearer,
        })
        expect(created.status).toBe(200)
        expect(JSON.parse(await streamPromise)).toMatchObject({ type: "session.created" })

        // --- list devices includes the new device ---
        const list = await fetch(new URL(DEVICES_LIST, listener.url), { headers: basic })
        expect(list.status).toBe(200)
        expect((await list.json()) as unknown[]).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: claimBody.device.id, name: "gate-e2e" })]),
        )

        // --- revoke (desktop Basic) ---
        const revoke = await fetch(
          new URL(DEVICE_REVOKE.replace(":deviceID", claimBody.device.id), listener.url),
          { method: "DELETE", headers: basic },
        )
        expect(revoke.status).toBe(200)
        expect(await revoke.json()).toBe(true)

        // --- revoked token 401s in every form ---
        expect((await fetch(probeURL, { headers: bearer })).status).toBe(401)
        expect((await fetch(probeURL, { headers: deviceBasic })).status).toBe(401)
      } finally {
        await withTimeout(stopGateListener(listener), 15_000, "ceremony listener stop")
      }
    },
  )

  test.skipIf(!PAIRING_PRESENT)(
    "negative: expired pair code is rejected",
    async () => {
      const root = await gateEnv()
      const { listener, withTimeout } = await startGateListener({
        username: BASIC_USERNAME,
        password: BASIC_PASSWORD,
      })
      try {
        const basic = basicHeader(BASIC_USERNAME, BASIC_PASSWORD)
        const begin = await jsonRequest(new URL(PAIR_BEGIN, listener.url), "POST", {}, basic)
        expect(begin.status).toBe(200)
        const { code } = (await begin.json()) as { code: string }
        // Wait past the real 90s TTL — the code must die of age, not attempts.
        await new Promise((resolve) => setTimeout(resolve, PAIR_TTL_MS + 1_000))
        const claim = await jsonRequest(new URL(PAIR_CLAIM, listener.url), "POST", { code, name: "gate-expired" })
        expect(claim.status).toBe(400)
        expect(await claim.json()).toMatchObject({ name: "PairCodeError", data: { reason: "expired" } })
      } finally {
        await withTimeout(stopGateListener(listener), 15_000, "expired-code listener stop")
      }
    },
    150_000,
  )

  test.skipIf(!PAIRING_PRESENT)("negative: wrong code hits attempt cap and kills the code", async () => {
    const root = await gateEnv()
    const { listener, withTimeout } = await startGateListener({
      username: BASIC_USERNAME,
      password: BASIC_PASSWORD,
    })
    try {
      const basic = basicHeader(BASIC_USERNAME, BASIC_PASSWORD)
      const begin = await jsonRequest(new URL(PAIR_BEGIN, listener.url), "POST", {}, basic)
      expect(begin.status).toBe(200)
      const { code } = (await begin.json()) as { code: string }

      // Five failed claims exhaust the code (design: wrong code x5 -> dead).
      for (let i = 0; i < 5; i++) {
        const wrong = await jsonRequest(new URL(PAIR_CLAIM, listener.url), "POST", {
          code: "000000",
          name: `gate-wrong-${i}`,
        })
        expect(wrong.status).toBe(400)
      }

      // The REAL code is now dead too.
      const real = await jsonRequest(new URL(PAIR_CLAIM, listener.url), "POST", { code, name: "gate-after-cap" })
      expect(real.status).toBe(400)
      expect(await real.json()).toMatchObject({ name: "PairCodeError", data: { reason: "exhausted" } })
    } finally {
      await withTimeout(stopGateListener(listener), 15_000, "attempt-cap listener stop")
    }
  })

  test.skipIf(!PAIRING_PRESENT)("negative: claimed code cannot be claimed twice", async () => {
    const root = await gateEnv()
    const { listener, withTimeout } = await startGateListener({
      username: BASIC_USERNAME,
      password: BASIC_PASSWORD,
    })
    try {
      const basic = basicHeader(BASIC_USERNAME, BASIC_PASSWORD)
      const begin = await jsonRequest(new URL(PAIR_BEGIN, listener.url), "POST", {}, basic)
      const { code } = (await begin.json()) as { code: string }
      const first = await jsonRequest(new URL(PAIR_CLAIM, listener.url), "POST", { code, name: "gate-first" })
      expect(first.status).toBe(200)
      const second = await jsonRequest(new URL(PAIR_CLAIM, listener.url), "POST", { code, name: "gate-second" })
      expect(second.status).toBe(400)
      expect(await second.json()).toMatchObject({ name: "PairCodeError", data: { reason: "invalid" } })
    } finally {
      await withTimeout(stopGateListener(listener), 15_000, "reused-code listener stop")
    }
  })

  test.skipIf(!PAIRING_PRESENT)("negative: claim hammering trips the rate limit", async () => {
    const root = await gateEnv()
    const { listener, withTimeout } = await startGateListener({
      username: BASIC_USERNAME,
      password: BASIC_PASSWORD,
    })
    try {
      const statuses: number[] = []
      for (let i = 0; i < 60; i++) {
        const response = await jsonRequest(new URL(PAIR_CLAIM, listener.url), "POST", {
          code: `rate${i}`,
          name: "gate-rate",
        })
        statuses.push(response.status)
        if (response.status === 429) break
      }
      expect(statuses).toContain(429)
    } finally {
      await withTimeout(stopGateListener(listener), 15_000, "rate-limit listener stop")
    }
  })
})
