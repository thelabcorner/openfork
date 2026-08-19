import { afterAll, beforeAll, expect, test } from "bun:test"
import { createServer } from "node:http"
import { BrowserHost } from "./host"
import type { BrokerResponse, BrowserOperation, HostCapabilities } from "./contracts"

const capabilities: HostCapabilities = {
  maxSnapshotBytes: 256 * 1024,
  maxResultBytes: 64 * 1024,
  supportedAppearances: ["system", "light", "dark"],
  supportsRecording: true,
  cdp: true,
}

let host: BrowserHost
let url = ""

const makeHost = async (
  dispatch: (
    tabId: string | undefined,
    operation: BrowserOperation,
    sessionId: string,
  ) => Promise<Record<string, unknown>>,
) => {
  const h = new BrowserHost({
    hostId: "test-host",
    hostEpoch: 1,
    windowId: "test-window",
    capabilities,
    sidecarProvider: () => null, // no sidecar in tests; hello just retries (unref'd)
    getGuestSnapshot: () => ({ attached: false, activeTabId: null, url: null }),
    dispatch,
  })
  await h.start()
  return { host: h, url: h.callbackUrl }
}

const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })

const envelope = (overrides: Record<string, unknown> = {}) => ({
  requestId: "req-test",
  sessionId: "sess-test",
  messageId: "msg-test",
  timeoutMs: 5_000,
  operation: { name: "status", input: {} },
  ...overrides,
})

beforeAll(async () => {
  const started = await makeHost(async (_tabId, _operation, _sessionId) => ({ status: { ok: true } }))
  host = started.host
  url = started.url
})
afterAll(() => host.stop())

test("rejects requests without the bearer token", async () => {
  const response = await post(url, "/v1/browser/request", envelope())
  expect(response.status).toBe(401)
})

test("rejects requests with a wrong bearer token", async () => {
  const response = await post(url, "/v1/browser/request", envelope(), {
    authorization: "Bearer wrong-token",
  })
  expect(response.status).toBe(401)
})

test("accepts a valid bearer token and dispatches the operation", async () => {
  const response = await post(url, "/v1/browser/request", envelope(), {
    authorization: `Bearer ${host.callbackUrlToken}`,
  })
  expect(response.status).toBe(200)
  const body = (await response.json()) as BrokerResponse
  expect(body.ok).toBe(true)
  if (body.ok) {
    expect(body.requestId).toBe("req-test")
    expect(body.result).toEqual({ status: { ok: true } })
    expect(typeof body.elapsedMs).toBe("number")
  }
})

test("responds an error envelope for an invalid body (HTTP 200)", async () => {
  const response = await post(
    url,
    "/v1/browser/request",
    { nope: true },
    {
      authorization: `Bearer ${host.callbackUrlToken}`,
    },
  )
  expect(response.status).toBe(200)
  const body = (await response.json()) as BrokerResponse
  expect(body.ok).toBe(false)
})

test("times out a slow operation with BrowserTimeout and still answers HTTP 200", async () => {
  const slow = await makeHost(async () => new Promise<Record<string, unknown>>(() => undefined))
  try {
    const response = await post(slow.url, "/v1/browser/request", envelope({ timeoutMs: 200 }), {
      authorization: `Bearer ${slow.host.callbackUrlToken}`,
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as BrokerResponse
    expect(body.ok).toBe(false)
    if (!body.ok) expect(body.error.tag).toBe("BrowserTimeout")
  } finally {
    await slow.host.stop()
  }
})

test("abort interrupts an in-flight operation with BrowserControlInterrupted", async () => {
  const hanging = await makeHost(async () => new Promise<Record<string, unknown>>(() => undefined))
  try {
    const requestId = "req-abort"
    const pending = post(hanging.url, "/v1/browser/request", envelope({ requestId, timeoutMs: 60_000 }), {
      authorization: `Bearer ${hanging.host.callbackUrlToken}`,
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const abortResponse = await post(
      hanging.url,
      `/v1/browser/request/${requestId}/abort`,
      {},
      {
        authorization: `Bearer ${hanging.host.callbackUrlToken}`,
      },
    )
    expect(abortResponse.status).toBe(200)
    const response = await pending
    const body = (await response.json()) as BrokerResponse
    expect(body.ok).toBe(false)
    if (!body.ok) expect(body.error.tag).toBe("BrowserControlInterrupted")
  } finally {
    await hanging.host.stop()
  }
})

test("maps typed operation errors to tagged BrokerResponse errors", async () => {
  const failing = await makeHost(async () => {
    throw new Error("stale ref") as never
  })
  try {
    const response = await post(failing.url, "/v1/browser/request", envelope(), {
      authorization: `Bearer ${failing.host.callbackUrlToken}`,
    })
    const body = (await response.json()) as BrokerResponse
    expect(body.ok).toBe(false)
    if (!body.ok) expect(body.error.retryable).toBe(true)
  } finally {
    await failing.host.stop()
  }
})

test("coalesces overlapping host hello registrations", async () => {
  const releases: VoidFunction[] = []
  let requests = 0
  const sidecar = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/api/browser/host/hello") {
      res.writeHead(404).end()
      return
    }
    req.resume()
    requests++
    releases.push(() => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ data: { accepted: true, brokerProtocolVersion: 2, hostId: "test-host" } }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    sidecar.once("error", reject)
    sidecar.listen(0, "127.0.0.1", () => {
      sidecar.off("error", reject)
      resolve()
    })
  })
  const address = sidecar.address()
  const h = new BrowserHost({
    hostId: "test-host",
    hostEpoch: 1,
    windowId: "test-window",
    capabilities,
    sidecarProvider: () => ({
      url: `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`,
      username: "user",
      password: "pass",
    }),
    getGuestSnapshot: () => ({ attached: false, activeTabId: null, url: null }),
    dispatch: async () => ({ status: { ok: true } }),
  })
  try {
    await h.start()
    await eventually(() => requests === 1)
    h.reRegister()
    h.reRegister()
    h.reRegister()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(requests).toBe(1)
    releases.shift()?.()
    await eventually(() => requests === 2)
    releases.shift()?.()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(requests).toBe(2)
  } finally {
    await h.stop()
    sidecar.closeAllConnections()
    await new Promise<void>((resolve) => sidecar.close(() => resolve()))
  }
})

test("does not queue disconnected heartbeat while hello is in flight", async () => {
  const releases: VoidFunction[] = []
  let requests = 0
  const sidecar = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/api/browser/host/hello") {
      res.writeHead(404).end()
      return
    }
    req.resume()
    requests++
    releases.push(() => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ data: { accepted: true, brokerProtocolVersion: 2, hostId: "test-host" } }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    sidecar.once("error", reject)
    sidecar.listen(0, "127.0.0.1", () => {
      sidecar.off("error", reject)
      resolve()
    })
  })
  const address = sidecar.address()
  const h = new BrowserHost({
    hostId: "test-host",
    hostEpoch: 1,
    windowId: "test-window",
    capabilities,
    sidecarProvider: () => ({
      url: `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`,
      username: "user",
      password: "pass",
    }),
    getGuestSnapshot: () => ({ attached: false, activeTabId: null, url: null }),
    dispatch: async () => ({ status: { ok: true } }),
  })
  try {
    await h.start()
    await eventually(() => requests === 1)
    const testHost = h as unknown as { registerHello: (attempt: number, reason: "heartbeat") => void }
    testHost.registerHello(0, "heartbeat")
    testHost.registerHello(0, "heartbeat")
    releases.shift()?.()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(requests).toBe(1)
  } finally {
    await h.stop()
    sidecar.closeAllConnections()
    await new Promise<void>((resolve) => sidecar.close(() => resolve()))
  }
})

async function eventually(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  expect(predicate()).toBe(true)
}

// --- hello reliability ------------------------------------------------------

/** Fake sidecar for hello-reliability tests: every hello is answered
 * accepted:true only after `release()` is called; once `setHang()` runs,
 * hellos are left unanswered so the host sees a client-side timeout. */
const startHelloSidecar = async () => {
  const releases: VoidFunction[] = []
  let hang = false
  const sidecar = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/api/browser/host/hello") {
      res.writeHead(404).end()
      return
    }
    req.resume()
    if (hang) return
    releases.push(() => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ data: { accepted: true, brokerProtocolVersion: 2, hostId: "test-host" } }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    sidecar.once("error", reject)
    sidecar.listen(0, "127.0.0.1", () => {
      sidecar.off("error", reject)
      resolve()
    })
  })
  const address = sidecar.address()
  return {
    releases,
    setHang: () => {
      hang = true
    },
    url: `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`,
    close: async () => {
      sidecar.closeAllConnections()
      await new Promise<void>((resolve) => sidecar.close(() => resolve()))
    },
  }
}

const helloHost = (overrides: Partial<ConstructorParameters<typeof BrowserHost>[0]> = {}) =>
  new BrowserHost({
    hostId: "test-host",
    hostEpoch: 1,
    windowId: "test-window",
    capabilities,
    sidecarProvider: () => null,
    getGuestSnapshot: () => ({ attached: false, activeTabId: null, url: null }),
    dispatch: async () => ({ status: { ok: true } }),
    ...overrides,
  })

test("does not flap the connection on a transient hello failure", async () => {
  const sidecar = await startHelloSidecar()
  const changes: boolean[] = []
  const h = helloHost({
    sidecarProvider: () => ({ url: sidecar.url, username: "user", password: "pass" }),
    helloTimeoutMs: 100,
    helloBackoffMs: [20, 40, 80],
    onConnectedChange: (connected) => changes.push(connected),
  })
  try {
    await h.start()
    await eventually(() => sidecar.releases.length === 1)
    sidecar.releases.shift()?.() // accept hello #1 -> connected
    await eventually(() => changes.length === 1)
    sidecar.setHang()
    h.reRegister() // hello #2 times out: a transient failure must not disconnect
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(changes).toEqual([true])
  } finally {
    await h.stop()
    await sidecar.close()
  }
})

test("reports disconnected only after consecutive transient failures", async () => {
  const sidecar = await startHelloSidecar()
  const changes: boolean[] = []
  const h = helloHost({
    sidecarProvider: () => ({ url: sidecar.url, username: "user", password: "pass" }),
    helloTimeoutMs: 100,
    helloBackoffMs: [20, 40, 80],
    onConnectedChange: (connected) => changes.push(connected),
  })
  try {
    await h.start()
    await eventually(() => sidecar.releases.length === 1)
    sidecar.releases.shift()?.()
    await eventually(() => changes.length === 1)
    sidecar.setHang()
    h.reRegister() // three consecutive timeouts (attempts 0,1,2) -> real disconnect
    await eventually(() => changes.length === 2)
    expect(changes).toEqual([true, false])
  } finally {
    await h.stop()
    await sidecar.close()
  }
})

test("disconnects immediately on a definite HTTP failure", async () => {
  let fail = false
  const releases: VoidFunction[] = []
  const changes: boolean[] = []
  const sidecar = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/api/browser/host/hello") {
      res.writeHead(404).end()
      return
    }
    req.resume()
    if (fail) {
      res.writeHead(500).end()
      return
    }
    releases.push(() => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ data: { accepted: true, brokerProtocolVersion: 2, hostId: "test-host" } }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    sidecar.once("error", reject)
    sidecar.listen(0, "127.0.0.1", () => {
      sidecar.off("error", reject)
      resolve()
    })
  })
  const address = sidecar.address()
  const h = helloHost({
    sidecarProvider: () => ({
      url: `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`,
      username: "user",
      password: "pass",
    }),
    helloTimeoutMs: 100,
    helloBackoffMs: [20, 40, 80],
    onConnectedChange: (connected) => changes.push(connected),
  })
  try {
    await h.start()
    await eventually(() => releases.length === 1)
    releases.shift()?.()
    await eventually(() => changes.length === 1)
    fail = true
    h.reRegister() // HTTP 500 is a definite failure: disconnect on the FIRST one
    await eventually(() => changes.length === 2)
    expect(changes).toEqual([true, false])
  } finally {
    await h.stop()
    sidecar.closeAllConnections()
    await new Promise<void>((resolve) => sidecar.close(() => resolve()))
  }
})

test("keeps the retry attempt counter monotonic across overlapping entries", async () => {
  const sidecar = await startHelloSidecar()
  const attempts: number[] = []
  const h = helloHost({
    sidecarProvider: () => ({ url: sidecar.url, username: "user", password: "pass" }),
    helloTimeoutMs: 50,
    helloBackoffMs: [20, 40, 80, 160],
    logger: {
      log: () => undefined,
      error: (_message, meta) => {
        if (typeof meta?.["attempt"] === "number") attempts.push(meta["attempt"] as number)
      },
    },
  })
  try {
    await h.start()
    await eventually(() => sidecar.releases.length === 1)
    sidecar.releases.shift()?.() // accept hello #1 -> connected
    await eventually(() => attempts.length === 0)
    sidecar.setHang()
    h.reRegister() // hello #2 (attempt 0) -> timeout -> logged
    await eventually(() => attempts.length === 1)
    expect(attempts[0]).toBe(0)
    // Mid-chain: a heartbeat and another re-register must NOT restart the
    // chain or reset the counter (they are dropped/merged, never started).
    ;(h as unknown as { registerHello: (a: number, r: "heartbeat") => void }).registerHello(0, "heartbeat")
    h.reRegister()
    // Chain continues: attempts 1,2 are quiet; attempt 3 logs (every third).
    await eventually(() => attempts.length === 2)
    expect(attempts).toEqual([0, 3])
  } finally {
    await h.stop()
    await sidecar.close()
  }
})

test("logs hello failures quietly (once per chain, not per attempt)", async () => {
  let requests = 0
  let errorLogs = 0
  const sidecar = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/browser/host/hello") {
      req.resume()
      requests++ // never answer -> client-side timeout
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve, reject) => {
    sidecar.once("error", reject)
    sidecar.listen(0, "127.0.0.1", () => {
      sidecar.off("error", reject)
      resolve()
    })
  })
  const address = sidecar.address()
  const h = helloHost({
    sidecarProvider: () => ({
      url: `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`,
      username: "user",
      password: "pass",
    }),
    helloTimeoutMs: 50,
    helloBackoffMs: [20, 40, 80, 160],
    logger: { log: () => undefined, error: () => errorLogs++ },
  })
  try {
    await h.start()
    await eventually(() => requests >= 4) // attempts 0..3 all failed
    // Attempt 0 (chain start) and attempt 3 are logged; 1 and 2 are not.
    expect(errorLogs).toBeLessThanOrEqual(2)
    expect(errorLogs).toBeGreaterThanOrEqual(1)
  } finally {
    await h.stop()
    sidecar.closeAllConnections()
    await new Promise<void>((resolve) => sidecar.close(() => resolve()))
  }
})

test("hello registration is session-agnostic (no sessionId/workspaceId/directory)", async () => {
  let lastRegistration: unknown = null
  const sidecar = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/api/browser/host/hello") {
      res.writeHead(404).end()
      return
    }
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      lastRegistration = JSON.parse(body)
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ data: { accepted: true, brokerProtocolVersion: 2, hostId: "test-host" } }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    sidecar.once("error", reject)
    sidecar.listen(0, "127.0.0.1", () => {
      sidecar.off("error", reject)
      resolve()
    })
  })
  const address = sidecar.address()
  const h = new BrowserHost({
    hostId: "test-host",
    hostEpoch: 1,
    windowId: "test-window",
    capabilities,
    sidecarProvider: () => ({
      url: `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`,
      username: "user",
      password: "pass",
    }),
    getGuestSnapshot: () => ({ attached: false, activeTabId: null, url: null }),
    dispatch: async () => ({ status: { ok: true } }),
  })
  try {
    await h.start()
    await eventually(() => lastRegistration !== null)
    const registration = lastRegistration as Record<string, unknown>
    expect(registration["sessionId"]).toBeUndefined()
    expect(registration["workspaceId"]).toBeUndefined()
    expect(registration["directory"]).toBeUndefined()
    expect(registration["windowId"]).toBe("test-window")
    expect(registration["protocolVersion"]).toBe(2)
    expect(registration["callbackToken"]).toBe(h.callbackUrlToken)
  } finally {
    await h.stop()
    sidecar.closeAllConnections()
    await new Promise<void>((resolve) => sidecar.close(() => resolve()))
  }
})

test("forwards the requesting sessionId into dispatch", async () => {
  let seenSessionId: string | undefined
  const forwarding = await makeHost(async (_tabId, _operation, sessionId) => {
    seenSessionId = sessionId
    return { status: { ok: true } }
  })
  try {
    const response = await post(forwarding.url, "/v1/browser/request", envelope({ sessionId: "sess-custom" }), {
      authorization: `Bearer ${forwarding.host.callbackUrlToken}`,
    })
    expect(response.status).toBe(200)
    expect(seenSessionId).toBe("sess-custom")
  } finally {
    await forwarding.host.stop()
  }
})
