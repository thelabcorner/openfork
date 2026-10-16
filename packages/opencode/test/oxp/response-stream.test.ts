import { describe, expect, test } from "bun:test"
import { createServer, request } from "node:http"
import type { AddressInfo } from "node:net"
import { sendMcpResponse } from "../../src/oxp/response-stream"

async function listener(makeResponse: () => Response) {
  let completed: Promise<boolean> | undefined
  const server = createServer((_, res) => {
    completed = sendMcpResponse(res, makeResponse())
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    get completed() { return completed },
    async close() { await new Promise<void>((resolve) => server.close(() => resolve())) },
  }
}

async function readAll(port: number) {
  return new Promise<{ body: Buffer; status: number; headers: Record<string, unknown> }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path: "/", method: "GET" }, (res) => {
      const chunks: Buffer[] = []
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
      res.once("end", () => resolve({ body: Buffer.concat(chunks), status: res.statusCode ?? 0, headers: res.headers }))
      res.once("error", reject)
    })
    req.once("error", reject)
    req.end()
  })
}

describe("OXP MCP response streaming / receipt boundary", () => {
  test("preserves binary bytes, HTTP status and headers without retaining body copies", async () => {
    const body = Buffer.alloc(8 * 1024 * 1024)
    for (let i = 0; i < body.length; i++) body[i] = i % 251
    const app = await listener(() => {
      let index = 0
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (index === body.length) return controller.close()
          controller.enqueue(body.subarray(index, index + 64 * 1024))
          index += 64 * 1024
        },
      })
      return new Response(stream, { status: 201, headers: { "content-type": "application/octet-stream", "content-length": "1" } })
    })
    try {
      const result = await readAll(app.port)
      expect(result.status).toBe(201)
      expect(result.headers["content-type"]).toBe("application/octet-stream")
      expect(result.headers["content-length"]).toBeUndefined()
      expect(Buffer.compare(result.body, body)).toBe(0)
      expect(await app.completed).toBe(true)
    } finally {
      await app.close()
    }
  })

  test("makes the first HTTP chunk visible before a deferred second chunk", async () => {
    let release!: () => void
    let released = false
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first-"))
        release = () => {
          if (released) return
          released = true
          controller.enqueue(new TextEncoder().encode("second"))
          controller.close()
        }
      },
    }))
    const app = await listener(() => response)
    try {
      const observed = await new Promise<{ part: string; ended: Promise<string> }>((resolve, reject) => {
        const req = request({ hostname: "127.0.0.1", port: app.port }, (res) => {
          let whole = ""
          const ended = new Promise<string>((done) => res.once("end", () => done(whole)))
          res.on("data", (data) => {
            whole += Buffer.from(data).toString()
            if (whole === "first-") resolve({ part: whole, ended })
          })
        })
        req.once("error", reject)
        req.end()
      })
      expect(observed.part).toBe("first-")
      release()
      expect(await observed.ended).toBe("first-second")
      expect(await app.completed).toBe(true)
    } finally {
      release?.()
      await app.close()
    }
  }, 10_000)

  test("does not mark a dropped receiver as an HTTP-completed response", async () => {
    let wasCancelled = false
    const app = await listener(() => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 512))
      },
      cancel() { wasCancelled = true },
    })))
    try {
      await new Promise<void>((resolve, reject) => {
        const req = request({ hostname: "127.0.0.1", port: app.port }, (res) => {
          res.once("data", () => {
            res.destroy()
            resolve()
          })
          res.once("error", () => resolve())
        })
        req.once("error", reject)
        req.end()
      })
      expect(await app.completed).toBe(false)
      expect(wasCancelled).toBe(true)
    } finally {
      await app.close()
    }
  }, 10_000)

  test("ends an empty response before reporting delivery success", async () => {
    const app = await listener(() => new Response(null, { status: 204 }))
    try {
      const result = await readAll(app.port)
      expect(result.status).toBe(204)
      expect(result.body.length).toBe(0)
      expect(await app.completed).toBe(true)
    } finally {
      await app.close()
    }
  })

  test("concurrent consumers complete independently without global response buffers", async () => {
    let finished = 0
    const app = await listener(() => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(64 * 1024).fill(42))
          controller.close()
        },
      })
      return new Response(stream)
    })
    try {
      const results = await Promise.all(Array.from({ length: 100 }, () => readAll(app.port)))
      for (const result of results) {
        expect(result.status).toBe(200)
        expect(result.body.length).toBe(64 * 1024)
        expect(result.body[0]).toBe(42)
        finished++
      }
      expect(finished).toBe(100)
    } finally {
      await app.close()
    }
  }, 15_000)
})
