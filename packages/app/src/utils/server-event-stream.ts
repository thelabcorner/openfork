import { createSseParser } from "@opencode-ai/sdk/sse-parser"

export type ServerEventStreamCursor = {
  lastEventID?: string
  retryMs?: number
}

/**
 * Minimal JSON-SSE transport for OpenFork's global event feeds.
 *
 * This intentionally owns exactly one HTTP connection. Reconnection policy
 * belongs to the server SDK context, which already owns liveness, visibility,
 * backoff, repair barriers, and stream-interest state. Keeping retry out of
 * this layer also avoids the old nested retry loops from the generated SDK.
 */
export async function* streamServerEvents<T>(input: {
  url: string | URL
  fetch: typeof globalThis.fetch
  signal: AbortSignal
  cursor: ServerEventStreamCursor
}): AsyncGenerator<T> {
  const headers = new Headers()
  if (input.cursor.lastEventID !== undefined) headers.set("Last-Event-ID", input.cursor.lastEventID)

  const response = await input.fetch(input.url, {
    method: "GET",
    headers,
    signal: input.signal,
    redirect: "follow",
  })
  if (!response.ok) throw new Error(`SSE failed: ${response.status} ${response.statusText}`)
  if (!response.body) throw new Error("No body in SSE response")

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const parser = createSseParser()
  const cancel = () => {
    try {
      void reader.cancel().catch(() => {})
    } catch {
      // Reader may already be closed.
    }
  }
  input.signal.addEventListener("abort", cancel)

  try {
    while (true) {
      const { done, value } = await reader.read()
      const text = decoder.decode(value, { stream: !done })
      for (const frame of parser.push(text, done)) {
        if (frame.id !== undefined) input.cursor.lastEventID = frame.id
        if (frame.retry !== undefined) input.cursor.retryMs = frame.retry
        if (!frame.hasData) continue

        const raw = frame.data ?? ""
        let data: unknown = raw
        try {
          data = JSON.parse(raw)
        } catch {
          // Match the generated client's behavior for non-JSON data frames.
        }
        yield data as T
      }
      if (done) return
    }
  } finally {
    input.signal.removeEventListener("abort", cancel)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}