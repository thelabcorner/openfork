/// <reference types="bun" />
// Minimal local-only OpenAI-compatible endpoint that accepts a request and
// stalls its SSE stream for a bounded time. Used exclusively to hold an ACP
// prompt in flight so `session/cancel` can be exercised without any external
// provider network access. Nothing is logged beyond a request counter.

export type StallMock = {
  readonly baseURL: string
  readonly port: number
  requestCount: () => number
  lastPath: () => string | undefined
  stop: () => Promise<void>
}

export function startStallMock(options?: { stallMs?: number }): StallMock {
  const stallMs = Math.max(500, options?.stallMs ?? 4000)
  let requests = 0
  let lastPath: string | undefined
  const encoder = new TextEncoder()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method === "POST") {
        requests++
        lastPath = url.pathname
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  id: "cert-mock",
                  object: "chat.completion.chunk",
                  created: 0,
                  model: "test-model",
                  choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
                })}\n\n`,
              ),
            )
            // Hold the stream open until the bounded stall expires or the client
            // aborts. Never completes with a normal finish before that.
            setTimeout(() => {
              try {
                controller.enqueue(encoder.encode("data: [DONE]\n\n"))
                controller.close()
              } catch {
                // client already aborted
              }
            }, stallMs)
          },
          cancel() {
            // client aborted (cancellation path)
          },
        })
        return new Response(stream, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
        })
      }
      return new Response("not found", { status: 404 })
    },
  })
  const port = server.port ?? 0
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    port,
    requestCount: () => requests,
    lastPath: () => lastPath,
    stop: async () => {
      await server.stop(true)
    },
  }
}
