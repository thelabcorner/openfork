/**
 * Loopback HTTP benchmark for Fetch Response -> Node ServerResponse delivery.
 * Compare legacy full-body arrayBuffer buffering to bounded stream.pipeline.
 *
 * bun packages/opencode/script/bench-oxp-response-stream.ts
 * Reuses a single HTTP keep-alive connection per mode; each request constructs
 * a fresh Fetch Response from the same immutable payload. No workspace writes.
 */
import { createServer, request, Agent, type ServerResponse } from "node:http"
import { performance } from "node:perf_hooks"
import { sendMcpResponse } from "../src/oxp/response-stream"

async function legacy(res: ServerResponse, response: Response) {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => { headers[key] = value })
  const body = response.body ? Buffer.from(await response.arrayBuffer()) : undefined
  if (body) headers["content-length"] = String(body.byteLength)
  res.writeHead(response.status, headers)
  return new Promise<boolean>((resolve) => {
    const done = () => { res.off("close", close); resolve(true) }
    const close = () => { res.off("finish", done); resolve(res.writableFinished) }
    res.once("finish", done)
    res.once("close", close)
    res.end(body)
  })
}

function percentile(xs: number[], fraction: number) {
  const sorted = xs.toSorted((a, b) => a - b)
  return +(sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0).toFixed(3)
}
async function trial(mode: "legacy" | "stream", bytes: number, iterations: number) {
  // Use a valid JSON string payload of the exact advertised UTF-8 size.
  const data = Buffer.from(JSON.stringify("a".repeat(bytes - 2)), "utf8")
  const bridge = mode === "stream" ? sendMcpResponse : legacy
  const server = createServer((_, res) => {
    void bridge(res, new Response(data, { headers: { "content-type": "application/json" } }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as { port: number }
  const agent = new Agent({ keepAlive: true, maxSockets: 1 })
  const timings: number[] = []
  const firstBytes: number[] = []
  try {
    for (let i = 0; i < iterations + 8; i++) {
      const start = performance.now()
      const first = { value: 0 }
      const size = await new Promise<number>((resolve, reject) => {
        const req = request({ hostname: "127.0.0.1", port: address.port, agent }, (res) => {
          let received = 0
          res.on("data", (chunk) => {
            if (!first.value) first.value = performance.now() - start
            received += chunk.length
          })
          res.once("end", () => resolve(received))
          res.once("error", reject)
        })
        req.once("error", reject)
        req.end()
      })
      if (size !== bytes) throw new Error(`Wrong response length ${size}, expected ${bytes}`)
      if (i >= 8) {
        timings.push(performance.now() - start)
        firstBytes.push(first.value || performance.now() - start)
      }
    }
    return {
      mode, bytes, iterations,
      latencyP50Ms: percentile(timings, 0.5),
      latencyP95Ms: percentile(timings, 0.95),
      firstByteP50Ms: percentile(firstBytes, 0.5),
      throughputMiBPerSec: +((bytes * iterations / 1024 / 1024) / (timings.reduce((a, b) => a + b, 0) / 1000)).toFixed(1),
    }
  } finally {
    agent.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

for (const [bytes, iterations] of [[512, 180], [32 * 1024, 100], [1024 * 1024, 40], [8 * 1024 * 1024, 12]] as const) {
  // Alternate case order across sizes to reduce single-systematic warmup bias.
  const modes: Array<"legacy" | "stream"> = bytes <= 32768 ? ["legacy", "stream"] : ["stream", "legacy"]
  for (const mode of modes) console.log(JSON.stringify(await trial(mode, bytes, iterations)))
}
