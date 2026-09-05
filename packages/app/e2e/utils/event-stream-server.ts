import { createServer } from "node:http"

/** Persistent SSE transport for streaming tests; a fulfilled Playwright route
 * closes its body and unintentionally benchmarks reconnect/backoff instead. */
export async function createEventStreamServer(input: {
  connected: (path: string) => unknown
  events: (path: string) => unknown[]
  interval: number
}) {
  // Stop timers independently of sockets so teardown cannot enqueue more work.
  let stopped = false
  const timers = new Set<ReturnType<typeof setInterval>>()
  const server = createServer((request, response) => {
    response.setHeader("access-control-allow-origin", "*")
    response.setHeader("access-control-allow-headers", "*")
    if (request.method === "OPTIONS") {
      response.writeHead(204).end()
      return
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    const path = new URL(request.url ?? "/", "http://localhost").pathname
    response.write(`data: ${JSON.stringify(input.connected(path))}\n\n`)
    // Simulated network cadence, not test-readiness synchronization. Never pull
    // another batch while the socket is backpressured.
    const timer = setInterval(() => {
      if (stopped || response.destroyed || response.writableNeedDrain) return
      const events = input.events(path)
      if (events.length) response.write(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""))
    }, input.interval)
    timers.add(timer)
    // A torn-down client resets the socket mid-write; without this the
    // 'error' is unhandled and fails the host test process.
    response.once("error", () => {})
    response.once("close", () => {
      clearInterval(timer)
      timers.delete(timer)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing test stream address")
  return {
    url: `http://127.0.0.1:${address.port}`,
    stop() {
      stopped = true
      for (const timer of timers) {
        clearInterval(timer)
        timers.delete(timer)
      }
    },
    close() {
      stopped = true
      for (const timer of timers) {
        clearInterval(timer)
        timers.delete(timer)
      }
      server.closeAllConnections()
      server.close()
    },
  }
}
