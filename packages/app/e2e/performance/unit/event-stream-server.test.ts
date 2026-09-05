import { expect, test } from "bun:test"
import { get, type IncomingMessage } from "node:http"
import { createEventStreamServer } from "../../utils/event-stream-server"

test("delivers later events over the same response without reconnecting", async () => {
  const events: unknown[] = []
  let connections = 0
  const server = await createEventStreamServer({
    interval: 1,
    connected: () => {
      connections++
      return { type: "connected" }
    },
    events: () => events.splice(0),
  })
  let response: IncomingMessage | undefined
  try {
    response = await new Promise<IncomingMessage>((resolve, reject) => {
      get(`${server.url}/global/event`, resolve).once("error", reject)
    })
    const reader = response[Symbol.asyncIterator]()
    const first = await reader.next()
    expect(new TextDecoder().decode(first.value)).toContain('"connected"')
    events.push({ type: "delta", value: "later" })
    const next = await reader.next()
    expect(next.done).toBe(false)
    expect(new TextDecoder().decode(next.value)).toContain('"later"')
    expect(connections).toBe(1)
  } finally {
    response?.destroy()
    server.close()
  }
})
