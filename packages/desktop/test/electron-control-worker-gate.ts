import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSidecarControlTransport } from "../src/main/sidecar-control-transport"
import { SqliteWorkerClient } from "../../core/src/database/sqlite-worker-client"

const { app, BrowserWindow, session } = require("electron") as typeof import("electron")
async function run() {
const scratch = await mkdtemp(join(tmpdir(), "openfork-electron-gate-"))
app.setPath("userData", join(scratch, "user-data"))
const closed = new Set<() => void>()
let held = 0
let canceled = 0
let streamActive = 0
let streamPeak = 0
let announceHang!: () => void
const hangStarted = new Promise<void>((resolve) => (announceHang = resolve))
const server = createServer((request, response) => {
  if (request.url?.startsWith("/hold")) {
    held++
    response.writeHead(200, { "content-type": "text/plain" })
    response.flushHeaders()
    response.once("close", () => {
      held--
      if (held === 0) for (const resolve of closed) resolve()
      closed.clear()
    })
    return
  }
  if (request.url?.includes("hang=1")) {
    announceHang()
    response.writeHead(200, { "content-type": "application/json" })
    response.flushHeaders()
    response.once("close", () => {
      if (!response.writableEnded) canceled++
    })
    return
  }
  if (request.url?.startsWith("/stream")) {
    streamActive++
    streamPeak = Math.max(streamPeak, streamActive)
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    let count = 0
    const timer = setInterval(() => response.write(`data: ${"x".repeat(1024)}:${count++}\n\n`), 10)
    response.once("close", () => {
      clearInterval(timer)
      streamActive--
      response.end()
    })
    return
  }
  response.writeHead(200, { "content-type": "application/json" })
  response.end(JSON.stringify({ ok: true }))
})

const listen = () => new Promise<number>((resolve, reject) => {
  server.once("error", reject)
  server.listen(0, "127.0.0.1", () => resolve((server.address() as import("node:net").AddressInfo).port))
})
const waitFor = async (predicate: () => boolean, label: string) => {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

await app.whenReady()
const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } })
await window.loadURL("data:text/html,<title>isolated%20electron%20gate</title>")
const port = await listen()
const origin = `http://127.0.0.1:${port}`
const defaultSession = session.defaultSession
const isolatedSession = session.fromPartition(`openfork-control-gate-${process.pid}`, { cache: false })
const control = createSidecarControlTransport({
  sidecarURL: () => origin,
  fetch: (url, init) => isolatedSession.fetch(url.href, init),
})
const input = (path: string) => ({
  url: `${origin}${path}`,
  method: "POST",
  headers: { authorization: "Basic Z2F0ZTpnYXRl", "content-type": "application/json" },
  body: JSON.stringify({ test: true }),
})

const holdControllers = Array.from({ length: 48 }, () => new AbortController())
const heldResponses: Response[] = []
const heldRequests = holdControllers.map((controller, index) =>
  defaultSession
    .fetch(`${origin}/hold?id=${index}`, { signal: controller.signal })
    .then((response) => heldResponses.push(response))
    .catch(() => undefined),
)
await waitFor(() => held >= 6, "default-session HTTP saturation")
const controlStart = performance.now()
const controlResult = await control(input("/global/event/interest"), new AbortController().signal)
const controlMs = performance.now() - controlStart
const heldAtControlCompletion = held
assert.equal(controlResult.status, 200)
assert.ok(heldAtControlCompletion > 0, "default session should still have held requests during control completion")

const cancelController = new AbortController()
const canceledFetch = control(input("/global/event/interest?hang=1"), cancelController.signal)
void canceledFetch.catch(() => undefined)
await hangStarted
cancelController.abort()
await assert.rejects(canceledFetch)
await waitFor(() => canceled > 0, "isolated sidecar cancellation")

for (const controller of holdControllers) controller.abort()
await Promise.all(heldRequests)

const streamEvidence: Array<{ concurrency: number; bytes: number }> = []
for (const concurrency of [1, 3, 6]) {
  streamPeak = 0
  const readers = await Promise.all(
    Array.from({ length: concurrency }, async () => {
      const controller = new AbortController()
      const response = await defaultSession.fetch(`${origin}/stream`, { signal: controller.signal })
      const reader = response.body!.getReader()
      let bytes = 0
      for (let count = 0; count < 3; count++) {
        const item = await reader.read()
        if (item.done) break
        bytes += item.value.byteLength
      }
      controller.abort()
      await reader.cancel().catch(() => undefined)
      return bytes
    }),
  )
  streamEvidence.push({ concurrency: streamPeak, bytes: readers.reduce((total, value) => total + value, 0) })
  assert.equal(streamPeak, concurrency)
  await waitFor(() => streamActive === 0, `stream teardown at concurrency ${concurrency}`)
}

const worker = new SqliteWorkerClient({ filename: join(scratch, "electron-worker.db"), disableWAL: true })
await worker.ready
let heartbeats = 0
const heartbeat = setInterval(() => heartbeats++, 0)
const sqliteStart = performance.now()
try {
  const rows = (await worker.request({
    kind: "query",
    query: "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 2000000) SELECT sum(x) AS total FROM n",
    params: [],
    arrays: false,
    safeIntegers: false,
  })) as Array<{ total: number }>
  assert.equal(rows[0]?.total, 2_000_001_000_000)
} finally {
  clearInterval(heartbeat)
  await worker.close()
}
const sqliteMs = performance.now() - sqliteStart
assert.ok(heartbeats > 0, "Electron main process event loop must progress while native SQLite computes")

console.log(
  `ELECTRON_GATE_RESULT ${JSON.stringify({
    electron: process.versions.electron,
    node: process.versions.node,
    chromium: process.versions.chrome,
    defaultSessionHeldAtControlCompletion: heldAtControlCompletion,
    controlCompletionMs: Number(controlMs.toFixed(2)),
    cancellationObserved: canceled,
    streams: streamEvidence,
    sqliteWorkerQueryMs: Number(sqliteMs.toFixed(2)),
    parentHeartbeatsDuringSqlite: heartbeats,
  })}`,
)
window.destroy()
server.close()
await rm(scratch, { recursive: true, force: true })
app.quit()
}

void run().catch((error) => {
  console.error(error)
  app.quit()
  process.exitCode = 1
})
