/**
 * The dev server's API proxy, written out by hand.
 *
 * It used to be Vite's `server.proxy` with a `router` callback returning the
 * verified URL. `router` is an **http-proxy-middleware** option; Vite proxies
 * with `http-proxy`, which has no such option and silently ignores it. Every
 * request therefore went to the deliberately-unroutable placeholder target and
 * the whole API answered an empty `500` — a total outage that looked exactly
 * like "the PWA cannot reach opencode".
 *
 * The lesson encoded here: the binding target must be applied by code this
 * repo owns and `dev/proxy.test.ts` exercises end to end over real sockets, not
 * handed to a third-party option whose absence fails silently.
 */
import http from "node:http"
import https from "node:https"
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http"
import type { Duplex } from "node:stream"
import { DEV_TARGET_STATUS_PATH, INSTANCE_EXPECT_HEADER } from "./constants"
import type { TargetResolution, TargetResolver } from "./target"

/** Per RFC 9110 these describe a single hop and must not be forwarded. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

export function pathnameOf(url: string | undefined) {
  const value = url ?? "/"
  const end = value.search(/[?#]/)
  return end === -1 ? value : value.slice(0, end)
}

/** First path segment, e.g. `/session/abc` -> `session`. */
export function firstSegment(pathname: string) {
  return pathname.split("/")[1] ?? ""
}

function outboundHeaders(headers: IncomingHttpHeaders, host: string, expectInstance?: string) {
  const out: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue
    if (HOP_BY_HOP.has(key.toLowerCase())) continue
    out[key] = value
  }
  // `changeOrigin`: the sidecar validates Host/Origin, and it knows itself by
  // its own ephemeral authority, not by the phone's tunnel hostname.
  out["host"] = host
  // Never let the upstream compress. opencode's `/event` stream is SSE, and a
  // compressing hop buffers it into uselessness.
  out["accept-encoding"] = "identity"
  // The actual guarantee. Verifying the identity and *then* connecting leaves a
  // window where the port could change hands; naming the instance in the
  // request itself means the wrong process refuses instead of answering. A
  // client must never be able to forge a different pin than the verified one.
  if (expectInstance) out[INSTANCE_EXPECT_HEADER] = expectInstance
  else delete out[INSTANCE_EXPECT_HEADER]
  return out
}

function joinPath(basePath: string, requestUrl: string) {
  const base = basePath.replace(/\/+$/, "")
  return base ? `${base}${requestUrl}` : requestUrl
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  if (response.headersSent || response.writableEnded) return
  response.statusCode = status
  response.setHeader("content-type", "application/json")
  response.setHeader("cache-control", "no-store")
  response.end(JSON.stringify(body))
}

function unavailable(response: ServerResponse, result: Extract<TargetResolution, { ok: false }>) {
  // 503 with a name/data envelope so it reads like an opencode API error in the
  // network tab, and carries the fix rather than just the symptom.
  sendJson(response, 503, {
    name: result.code,
    data: { message: `${result.message} ${result.hint}`, hint: result.hint, detail: result.detail },
  })
}

export type ApiProxyOptions = {
  resolver: Pick<TargetResolver, "resolve">
  /** Path prefixes owned by the API; everything else falls through to Vite. */
  apiPrefixes: readonly string[]
  onLog?: (level: "info" | "warn", message: string) => void
}

export function createApiProxy(options: ApiProxyOptions) {
  const prefixes = new Set(options.apiPrefixes)
  const isApiPath = (pathname: string) => prefixes.has(firstSegment(pathname))

  function forward(request: IncomingMessage, response: ServerResponse, targetUrl: string, expectInstance?: string) {
    const target = new URL(targetUrl)
    const driver = target.protocol === "https:" ? https : http
    const upstream = driver.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: request.method,
      path: joinPath(target.pathname, request.url ?? "/"),
      headers: outboundHeaders(request.headers, target.host, expectInstance),
      // No timeout on purpose: `/event` is a long-lived SSE stream and any
      // socket deadline here would sever it on an idle project.
    })

    upstream.on("response", (upstreamResponse) => {
      const headers: Record<string, string | string[]> = {}
      for (const [key, value] of Object.entries(upstreamResponse.headers)) {
        if (value === undefined) continue
        if (HOP_BY_HOP.has(key.toLowerCase())) continue
        headers[key] = value
      }
      response.writeHead(upstreamResponse.statusCode ?? 502, headers)
      // Flush the head before the first chunk so an SSE client sees the stream
      // open immediately instead of after the first event.
      response.flushHeaders()
      upstreamResponse.pipe(response)
    })

    upstream.on("error", (error) => {
      options.onLog?.("warn", `proxy to ${targetUrl} failed: ${(error as Error).message}`)
      sendJson(response, 502, {
        name: "DesktopSidecarProxyError",
        data: { message: `Could not reach the verified opencode at ${targetUrl}.`, detail: (error as Error).message },
      })
      response.destroy()
    })

    // A phone that navigates away mid-stream must not leave the sidecar
    // writing into a dead socket.
    response.on("close", () => {
      if (!upstream.destroyed) upstream.destroy()
    })
    request.pipe(upstream)
  }

  function upgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    targetUrl: string,
    expectInstance?: string,
  ) {
    const target = new URL(targetUrl)
    const driver = target.protocol === "https:" ? https : http
    const upstream = driver.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: request.method,
      path: joinPath(target.pathname, request.url ?? "/"),
      headers: {
        ...outboundHeaders(request.headers, target.host, expectInstance),
        // `connection`/`upgrade` are hop-by-hop and stripped above, but *this*
        // hop is the upgrade — without them the sidecar answers a plain 200 and
        // the socket never switches protocols.
        connection: "Upgrade",
        upgrade: request.headers["upgrade"] ?? "websocket",
      },
    })
    upstream.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
      const lines = [`HTTP/1.1 ${upstreamResponse.statusCode} ${upstreamResponse.statusMessage}`]
      for (const [key, value] of Object.entries(upstreamResponse.headers)) {
        if (value === undefined) continue
        for (const one of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${one}`)
      }
      socket.write(`${lines.join("\r\n")}\r\n\r\n`)
      if (upstreamHead?.length) socket.write(upstreamHead)
      if (head?.length) upstreamSocket.write(head)
      upstreamSocket.pipe(socket).pipe(upstreamSocket)
    })
    upstream.on("error", () => socket.destroy())
    socket.on("error", () => upstream.destroy())
    upstream.end()
  }

  return {
    isApiPath,

    /**
     * Connect-style middleware. Registered *before* Vite's own stack so nothing
     * reaches the SPA fallback (which answers every unknown path with HTML, and
     * would turn a misbinding into a confusing parse error instead of a 503).
     */
    handle(request: IncomingMessage, response: ServerResponse, next: () => void) {
      const pathname = pathnameOf(request.url)

      if (pathname === DEV_TARGET_STATUS_PATH) {
        void options.resolver
          .resolve()
          .then((result) =>
            sendJson(
              response,
              200,
              result.ok
                ? { bound: true, instanceID: result.instanceID, identity: result.identity, source: result.source }
                : { bound: false, code: result.code, message: result.message, hint: result.hint },
            ),
          )
          .catch((error) => sendJson(response, 500, { name: "DevTargetStatusError", data: { message: String(error) } }))
        return
      }

      if (!isApiPath(pathname)) return next()

      void options.resolver
        .resolve()
        .then((result) => {
          if (!result.ok) return unavailable(response, result)
          forward(request, response, result.url, result.instanceID)
        })
        .catch((error) => {
          options.onLog?.("warn", `could not resolve a verified backend: ${String(error)}`)
          sendJson(response, 503, {
            name: "DesktopSidecarUnavailableError",
            data: { message: "Could not resolve a verified opencode backend.", detail: String(error) },
          })
        })
    },

    /** `httpServer.on("upgrade")` handler. Vite's HMR socket is not an API path. */
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
      if (!isApiPath(pathnameOf(request.url))) return false
      void options.resolver
        .resolve()
        .then((result) => {
          if (!result.ok) {
            socket.end(`HTTP/1.1 503 Service Unavailable\r\n\r\n${result.message} ${result.hint}`)
            return
          }
          upgrade(request, socket, head, result.url, result.instanceID)
        })
        .catch(() => socket.destroy())
      return true
    },
  }
}
