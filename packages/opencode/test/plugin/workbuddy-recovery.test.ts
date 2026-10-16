import { afterEach, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WorkBuddyPlugin, fetchWithWorkBuddyHeaderTimeout, setTestAccountStore, setTestBackend } from "@/plugin/workbuddy"
import { AccountVault, stableAccountIdentity } from "@/plugin/workbuddy-accounts"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  setTestBackend(undefined)
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

async function setup(credits: number) {
  const root = mkdtempSync(join(tmpdir(), "workbuddy-auto-recovery-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const cred = new AccountVault(root).save({
    path: join(root, "source.json"),
    accessToken: "FAKE_TOKEN",
    refreshToken: "FAKE_REFRESH",
    domain: "www.workbuddy.ai",
    uid: `recovery-${crypto.randomUUID()}`,
    enterpriseId: "",
    expiresAt: Date.now() + 60_000,
    nickname: "test@example.com",
    enrollmentEpoch: "test-epoch",
  })
  const entitlementDir = join(root, "state")
  mkdirSync(entitlementDir, { recursive: true })
  const entitlement = join(entitlementDir, `${stableAccountIdentity(cred)}-entitlement.json`)
  writeFileSync(entitlement, JSON.stringify({
    schema: 2, state: "QUOTA_EXHAUSTED", resetAt: null, limitedEpoch: "test-epoch", at: Date.now(),
  }))
  setTestAccountStore(root)
  const requests = { billing: 0, chat: 0, payment: 0 }
  const server: Server = createServer((req, res) => {
    if (req.url?.startsWith("/v2/billing/meter/get-user-resource")) {
      requests.billing++
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({
        data: { packages: [{
          PackageCode: "basic", CapacitySizePrecise: 100, CapacityRemainPrecise: credits, Status: 0,
        }] },
      }))
      return
    }
    if (req.url?.startsWith("/v2/billing/meter/get-payment-type")) {
      requests.payment++
      res.writeHead(404)
      res.end()
      return
    }
    if (req.url?.startsWith("/v2/chat/completions")) {
      requests.chat++
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.end('data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("fake backend not listening")
  setTestBackend(`http://127.0.0.1:${address.port}`)
  const hooks = await WorkBuddyPlugin({} as never)
  cleanup.push(() => hooks.dispose?.())
  const models = await hooks.provider!.models!({ id: "workbuddy", models: {} } as never, {})
  const model = models["hy4-preview"]
  if (!model) throw new Error("hy4-preview missing from passive catalog")
  const request = async () => fetch(`${model.api.url}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...model.headers,
      "x-opencode-session": "test-recover-session",
      "x-opencode-request": `main:test-${crypto.randomUUID()}`,
    },
    body: JSON.stringify({
      model: "hy4-preview",
      stream: true,
      messages: [{ role: "system", content: "Test" }, { role: "user", content: "OK" }],
    }),
    signal: AbortSignal.timeout(8_000),
  })
  return { root, entitlement, requests, request }
}

test("demand-driven WorkBuddy recovery restores a funded persisted account without manual Limits refresh", async () => {
  const fixture = await setup(15)
  const [first, second] = await Promise.all([fixture.request(), fixture.request()])
  expect(first.status).toBe(200)
  expect(second.status).toBe(200)
  await Promise.all([first.text(), second.text()])
  expect(fixture.requests.billing).toBe(1)
  expect(fixture.requests.payment).toBe(0)
  expect(fixture.requests.chat).toBe(2)
  expect(JSON.parse(readFileSync(fixture.entitlement, "utf8")).state).toBe("READY")
})

test("zero credits never remove the persisted hard block and billing requests are throttled", async () => {
  const fixture = await setup(0)
  const first = await fixture.request()
  expect(first.status).toBe(402)
  await first.text()
  const second = await fixture.request()
  expect(second.status).toBe(402)
  await second.text()
  expect(fixture.requests.billing).toBe(1)
  expect(fixture.requests.chat).toBe(0)
  expect(JSON.parse(readFileSync(fixture.entitlement, "utf8")).state).toBe("QUOTA_EXHAUSTED")
})

test("upstream response headers have an independent timeout without shortening live response streams", async () => {
  const blocked = (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new Error("headers deadline")), { once: true })
  })
  await expect(fetchWithWorkBuddyHeaderTimeout("https://unused.invalid", {}, 15, blocked)).rejects.toThrow("headers deadline")

  const streamFetch = async (_url: string, init: RequestInit) => new Response(new ReadableStream({
    start(controller) {
      init.signal?.addEventListener("abort", () => controller.error(new Error("stream unexpectedly aborted")), { once: true })
      controller.enqueue(new TextEncoder().encode("data: first\n\n"))
      setTimeout(() => {
        controller.enqueue(new TextEncoder().encode("data: second\n\n"))
        controller.close()
      }, 70)
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } })
  const response = await fetchWithWorkBuddyHeaderTimeout("https://unused.invalid/stream", {}, 25, streamFetch)
  expect(response.status).toBe(200)
  expect(await response.text()).toContain("data: second")
})
