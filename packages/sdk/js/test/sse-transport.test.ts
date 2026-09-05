import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { createSseClient as v1 } from "../src/gen/core/serverSentEvents.gen"
import { createSseClient as v2 } from "../src/v2/gen/core/serverSentEvents.gen"

for (const [name, client] of [["v1", v1], ["v2", v2]] as const) {
  describe(`${name} SSE transport`, () => {
    let restoreFetch: (() => void) | undefined
    afterEach(() => { restoreFetch?.(); restoreFetch = undefined })
    const transport = (options: Parameters<typeof v2>[0]) => {
      // The older V1 generator uses global fetch, while V2 accepts a fetch
      // option. Keep both variants entirely within the same fake transport.
      if (name === "v1") {
        const fetch = spyOn(globalThis, "fetch").mockImplementation((input, init) => options.fetch!(new Request(input, init)))
        restoreFetch = () => fetch.mockRestore()
      }
      return client(options)
    }
    test("consumer return cancels the underlying response", async () => {
      let cancelled = false
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode('id: epoch:1\ndata: {"ok":true}\n\n')) },
        cancel() { cancelled = true },
      })
      const { stream } = transport({ url: "http://localhost/event", fetch: async () => new Response(body) })
      expect((await stream.next()).done).toBe(false)
      await stream.return()
      expect(cancelled).toBe(true)
    })

    test("does not acknowledge a frame rejected by its validator", async () => {
      const cursors: Array<string | null> = []
      let requests = 0
      const { stream } = transport({
        url: "http://localhost/event", sseSleepFn: async () => {},
        fetch: async (request) => {
          cursors.push(new Request(request).headers.get("Last-Event-ID"))
          return new Response(++requests === 1 ? 'id: epoch:9\ndata: {"bad":true}\n\n' : "")
        },
        responseValidator: async () => { throw new Error("invalid") },
      })
      await stream.next()
      expect(cursors).toEqual([null, null])
    })

    test("heartbeats restore healthy retry delay after an idle interval", async () => {
      let now = 0
      const time = spyOn(Date, "now").mockImplementation(() => now)
      const random = spyOn(Math, "random").mockReturnValue(0.5)
      const delays: number[] = []
      let requests = 0
      let controller!: ReadableStreamDefaultController<Uint8Array>
      const { stream } = transport({
        url: "http://localhost/event", sseDefaultRetryDelay: 100,
        sseSleepFn: async (delay) => { delays.push(delay) },
        onSseEvent: () => { now = 31_000 },
        fetch: async () => {
          if (++requests <= 2) throw new Error("offline")
          if (requests > 3) return new Response("")
          return new Response(new ReadableStream<Uint8Array>({
            start(value) {
              controller = value
              value.enqueue(new TextEncoder().encode(': heartbeat\n\ndata: {}\n\n'))
            },
          }))
        },
      })
      try {
        await stream.next()
        controller.error(new Error("disconnected"))
        await stream.next()
        expect(delays).toEqual([50, 100, 50])
      } finally {
        await stream.return()
        time.mockRestore()
        random.mockRestore()
      }
    })
  })
}
