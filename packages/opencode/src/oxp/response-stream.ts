import type { ServerResponse } from "node:http"

/**
 * Await HTTP backpressure with explicit peer-disconnect handling.
 * Node accepts Uint8Array writes directly, avoiding Response.arrayBuffer()
 * and Readable.fromWeb() adapter allocation for the common one-chunk case.
 */
function drained(res: ServerResponse): Promise<boolean> {
  if (res.destroyed) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    const finish = (ready: boolean) => {
      res.off("drain", onDrain)
      res.off("close", onClose)
      res.off("error", onError)
      resolve(ready)
    }
    const onDrain = () => finish(true)
    const onClose = () => finish(false)
    const onError = () => finish(false)
    res.once("drain", onDrain)
    res.once("close", onClose)
    res.once("error", onError)
    // The socket can close between the initial check and listener setup.
    if (res.destroyed) finish(false)
  })
}

/**
 * Stream Fetch response bytes to an MCP loopback client, respecting Node HTTP
 * backpressure. The response body is never aggregated or copied into a new
 * body-sized Buffer. This also supports progressively produced responses.
 *
 * Returns true only after the HTTP response has finished; caller post-response
 * mutations MUST be gated on that result. On error/disconnect, discard the
 * unconsumed source and never claim delivery success.
 */
export async function sendMcpResponse(res: ServerResponse, response: Response): Promise<boolean> {
  if (res.destroyed || res.writableEnded) {
    await response.body?.cancel().catch(() => undefined)
    return false
  }
  const headers: Record<string, string> = {}
  response.headers.forEach((value, name) => {
    // The Fetch body may have been transformed. Node must own framing;
    // forwarding an incorrect Content-Length can silently truncate JSON-RPC.
    if (name.toLowerCase() !== "content-length") headers[name] = value
  })
  let settle!: (ok: boolean) => void
  const completed = new Promise<boolean>((resolve) => { settle = resolve })
  const cleanup = () => {
    res.off("finish", onFinish)
    res.off("close", onClose)
    res.off("error", onError)
  }
  const onFinish = () => { cleanup(); settle(true) }
  const onClose = () => { cleanup(); settle(res.writableFinished) }
  const onError = () => { cleanup(); settle(false) }
  res.once("finish", onFinish)
  res.once("close", onClose)
  res.once("error", onError)
  res.writeHead(response.status, headers)

  if (!response.body) {
    res.end()
    return completed
  }

  const reader = response.body.getReader()
  // JSON responses are framed documents: later chunks can use bounded writev
  // groups without delaying the first byte. Binary, SSE and unknown media
  // types may have independent progressive chunks and must flush immediately.
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
  const mediaType = contentType.split(";", 1)[0]!.trim()
  const batchable = mediaType === "application/json" || mediaType.endsWith("+json")
  const pending: Uint8Array[] = []
  let pendingBytes = 0
  let firstChunk = true
  const flush = async () => {
    if (pending.length === 0) return true
    let writable = true
    res.cork()
    try {
      for (const chunk of pending) if (!res.write(chunk)) writable = false
    } finally {
      res.uncork()
      pending.length = 0
      pendingBytes = 0
    }
    return writable || await drained(res)
  }
  const cancel = () => {
    if (!res.writableFinished) void reader.cancel().catch(() => undefined)
  }
  res.once("close", cancel)
  try {
    let writable = true
    while (!res.destroyed) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (!batchable || firstChunk) {
        firstChunk = false
        if (!res.write(chunk.value) && !(await drained(res))) {
          writable = false
          break
        }
        continue
      }
      pending.push(chunk.value)
      pendingBytes += chunk.value.byteLength
      if (pendingBytes >= 128 * 1024 && !(await flush())) {
        writable = false
        break
      }
    }
    if (!res.destroyed && writable && await flush()) res.end()
    return await completed
  } catch (error) {
    if (res.destroyed) return false
    // A producer failure is an actual transport incident, not an ordinary
    // peer cancellation. Close the partial wire body and let the caller's
    // incident recorder classify it. Never return an HTTP success receipt.
    res.destroy()
    throw error
  } finally {
    res.off("close", cancel)
    reader.releaseLock()
  }
}
