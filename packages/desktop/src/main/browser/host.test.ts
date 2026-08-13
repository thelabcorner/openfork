import { afterAll, beforeAll, expect, test } from "bun:test"
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

const makeHost = async (dispatch: (tabId: string | undefined, operation: BrowserOperation) => Promise<Record<string, unknown>>) => {
  const h = new BrowserHost({
    hostId: "test-host",
    hostEpoch: 1,
    windowId: "test-window",
    capabilities,
    sidecarProvider: () => null, // no sidecar in tests; hello just retries (unref'd)
    getSessionContext: () => ({ sessionId: "sess-test" }),
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
  input: {},
  ...overrides,
})

beforeAll(async () => {
  const started = await makeHost(async () => ({ status: { ok: true } }))
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
  const response = await post(url, "/v1/browser/request", { nope: true }, {
    authorization: `Bearer ${host.callbackUrlToken}`,
  })
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
    const abortResponse = await post(hanging.url, `/v1/browser/request/${requestId}/abort`, {}, {
      authorization: `Bearer ${hanging.host.callbackUrlToken}`,
    })
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
