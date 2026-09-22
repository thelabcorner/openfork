import { describe, expect, test } from "bun:test"
import { streamServerEvents, type ServerEventStreamCursor } from "./server-event-stream"

const response = (body: string) =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body))
        controller.close()
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )

describe("streamServerEvents", () => {
  test("parses JSON data and ignores heartbeat-only frames", async () => {
    const fetcher = (() =>
      Promise.resolve(
        response(': ping\n\nid: 7\ndata: {"type":"server.connected","data":{"ok":true}}\n\n'),
      )) as unknown as typeof fetch
    const cursor: ServerEventStreamCursor = {}
    const abort = new AbortController()

    const events: unknown[] = []
    for await (const event of streamServerEvents({
      url: "http://localhost:4096/api/event",
      fetch: fetcher,
      signal: abort.signal,
      cursor,
    })) {
      events.push(event)
    }

    expect(events).toEqual([{ type: "server.connected", data: { ok: true } }])
    expect(cursor.lastEventID).toBe("7")
  })

  test("replays the last event id and accepts server retry hints", async () => {
    let request: Request | undefined
    const fetcher = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      request = new Request(input, init)
      return Promise.resolve(response("retry: 1250\nid: 9\ndata: ok\n\n"))
    }) as typeof fetch
    const cursor: ServerEventStreamCursor = { lastEventID: "8" }

    const values: unknown[] = []
    for await (const event of streamServerEvents({
      url: "http://localhost:4096/global/event",
      fetch: fetcher,
      signal: new AbortController().signal,
      cursor,
    })) {
      values.push(event)
    }

    expect(request?.headers.get("Last-Event-ID")).toBe("8")
    expect(values).toEqual(["ok"])
    expect(cursor).toEqual({ lastEventID: "9", retryMs: 1250 })
  })
})