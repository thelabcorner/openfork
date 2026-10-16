/**
 * OXP's lean, secret loopback MCP listener.
 *
 * No imports from config, root, Session, capability, worker or the privileged
 * execution graph. An executable callback comes from the one host runtime
 * owner; it must authorize on every call, including after lazy activation.
 */
import { randomBytes, timingSafeEqual } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { Socket } from "node:net"
import type { CallToolResult } from "@modelcontextprotocol/server"
import { createOxpTransportProtocol, type ExecutedCall } from "./transport-protocol"
import { OXP_STATIC_TRANSPORT } from "./transport-manifest"
import { paginateToolList, registerLegacyManifest } from "./transport-pagination"
import { sendMcpResponse } from "./response-stream"
import { projectInternalErrorBody } from "./transport-incident"

const BODY_CAP = 8 * 1024 * 1024

export interface LeanEndpoint {
  readonly port: number
  readonly url: string
  readonly metadataUrl: string
  readonly surfaceFingerprint: string
  readonly stop: (options?: { readonly forceAfterMs?: number }) => Promise<void>
}
export interface LeanListenerOptions {
  readonly execute: (name: string, args: unknown, meta: Readonly<Record<string, unknown>> | undefined, signal: AbortSignal) => Promise<ExecutedCall>
  /** The full runtime can preserve its richer incident/error projection.
   * The cold host's no-executor path remains opaque and schema compatible. */
  readonly internalError?: (
    cause: unknown,
    phase: "tool_boundary" | "result_validation" | "result_projection",
    name?: string,
    action?: string,
  ) => CallToolResult
  readonly onTransportError?: (cause: unknown, phase: "request_body" | "mcp_transport") => string | undefined
  /** Invoked when an accepted socket is about to begin a protocol request. */
  readonly onRequest?: () => void
  readonly onTransportDuration?: (elapsedMs: number) => void
}

function equal(a: string, b: string) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
function allowedRequest(req: IncomingMessage, hosts: ReadonlySet<string>) {
  if (!hosts.has((req.headers.host ?? "").toLowerCase())) return false
  const origin = req.headers.origin
  if (!origin) return true
  try {
    const value = new URL(origin)
    return value.protocol === "http:" && hosts.has(value.host.toLowerCase()) && value.pathname === "/"
  } catch {
    return false
  }
}
function failure(res: ServerResponse, status: number, code: string) {
  if (res.headersSent || res.destroyed) return
  const body = JSON.stringify({ error: code })
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  })
  res.end(body)
}
async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const raw of req) {
      const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
      size += data.byteLength
      if (size > BODY_CAP) return { error: "payload_too_large" as const }
      chunks.push(data)
    }
    const raw = chunks.length === 1 ? chunks[0]!.toString("utf8") : Buffer.concat(chunks).toString("utf8")
    return { body: raw ? JSON.parse(raw) as unknown : undefined }
  } catch {
    return { error: "invalid_json" as const }
  }
}
export function bridgeRequestCancellation(req: IncomingMessage, res: ServerResponse) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  const close = () => { if (!res.writableFinished) abort() }
  req.once("aborted", abort)
  res.once("close", close)
  return {
    signal: controller.signal,
    dispose() {
      req.off("aborted", abort)
      res.off("close", close)
    },
  }
}
function internalToolError(incidentID?: string): CallToolResult {
  const text = incidentID
    ? `OXP_INTERNAL: Unexpected OXP failure recorded as ${incidentID}; query openfork_diagnostics with incidentID=${incidentID}.`
    : "OXP_INTERNAL: Unexpected OXP execution failure; inspect host diagnostics"
  return {
    content: [{ type: "text", text }],
    structuredContent: {
      output: text,
      error: {
        code: "OXP_INTERNAL",
        message: incidentID ? `Unexpected OXP failure recorded as ${incidentID}` : "Unexpected OXP execution failure",
        retryable: false,
        ...(incidentID ? { metadata: { incidentID } } : {}),
      },
    },
    isError: true,
  }
}

export async function startLeanOxpListener(options: LeanListenerOptions): Promise<LeanEndpoint> {
  const incident = (cause: unknown, phase: "request_body" | "mcp_transport") => {
    try {
      return options.onTransportError?.(cause, phase)
    } catch {
      // Incident recording is never allowed to shadow the original failure.
      return undefined
    }
  }
  const replyJsonRpcIncident = (res: ServerResponse, request: unknown, id?: string) => {
    if (!id || res.headersSent) return false
    const response = projectInternalErrorBody(request, id)
    if (response === undefined) return false
    const serialized = JSON.stringify(response)
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(serialized),
    })
    res.end(serialized)
    return true
  }
  const token = randomBytes(32).toString("base64url")
  const basePath = `/mcp/${token}`
  const metadataPath = `/.well-known/oauth-protected-resource${basePath}`
  const sockets = new Set<Socket>()
  const hosts = new Set<string>()
  let endpointUrl = ""
  let stopping = false
  let stoppingPromise: Promise<void> | undefined
  const protocol = createOxpTransportProtocol({
    paginate: paginateToolList,
    registerLegacy: registerLegacyManifest,
    execute: options.execute,
    internalError: (cause, phase, name, action) =>
      options.internalError
        ? options.internalError(cause, phase, name, action)
        : internalToolError(incident(cause, "mcp_transport")),
  })
  const server = createServer((req, res) => {
    const pathname = (req.url ?? "").split("?", 1)[0] ?? ""
    if (stopping || !allowedRequest(req, hosts)) {
      req.resume()
      failure(res, 403, "forbidden")
      return
    }
    if (equal(pathname, metadataPath)) {
      req.resume()
      if (req.method !== "GET") {
        failure(res, 405, "method_not_allowed")
        return
      }
      const body = JSON.stringify({
        resource: endpointUrl,
        resource_name: "OpenFork OXP",
        authorization_servers: [],
        scopes_supported: [],
      })
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(body),
      })
      res.end(body)
      return
    }
    if (!equal(pathname, basePath)) {
      req.resume()
      failure(res, 404, "not_found")
      return
    }
    if (req.method !== "POST") {
      req.resume()
      failure(res, 405, "method_not_allowed")
      return
    }
    const length = req.headers["content-length"]
    if (length !== undefined) {
      const declared = Number(length)
      if (!Number.isSafeInteger(declared) || declared < 0) {
        req.resume()
        failure(res, 400, "invalid_content_length")
        return
      }
      if (declared > BODY_CAP) {
        req.resume()
        failure(res, 413, "payload_too_large")
        return
      }
    }
    options.onRequest?.()
    void readBody(req).then(async (parsed) => {
      if (parsed.error) {
        req.resume()
        failure(res, parsed.error === "payload_too_large" ? 413 : 400, parsed.error)
        return
      }
      if (stopping) {
        failure(res, 503, "endpoint_stopping")
        return
      }
      const transportAt = performance.now()
      const cancellation = bridgeRequestCancellation(req, res)
      try {
        const headers = new Headers()
        for (const [name, value] of Object.entries(req.headers)) {
          if (value === undefined || name.toLowerCase() === "content-length") continue
          if (Array.isArray(value)) for (const entry of value) headers.append(name, entry)
          else headers.set(name, value)
        }
        const request = new Request(`http://127.0.0.1${req.url ?? "/"}`, {
          method: req.method,
          headers,
          body: parsed.body === undefined ? undefined : JSON.stringify(parsed.body),
          signal: cancellation.signal,
        })
        const response = await protocol.handler.fetch(request)
        if (cancellation.signal.aborted || res.destroyed) return
        const finished = await sendMcpResponse(res, response)
        if (finished) {
          const after = protocol.takeAfterResponse(request)
          if (after) await Promise.resolve(after()).catch(() => undefined)
        } else {
          // Do not retain an undelivered receipt callback after client abort.
          protocol.takeAfterResponse(request)
        }
      } catch (error) {
        const id = incident(error, "mcp_transport")
        if (replyJsonRpcIncident(res, parsed.body, id)) return
        failure(res, 500, "mcp_transport_error")
        if (res.headersSent && !res.writableFinished) res.destroy()
      } finally {
        cancellation.dispose()
        options.onTransportDuration?.(performance.now() - transportAt)
      }
    }).catch((error) => {
      incident(error, "request_body")
      failure(res, 500, "mcp_transport_error")
    })
  })
  server.headersTimeout = 30_000
  server.requestTimeout = 300_000
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("OXP listener did not bind TCP")
    const port = address.port
    hosts.add(`127.0.0.1:${port}`)
    hosts.add(`localhost:${port}`)
    hosts.add(`[::1]:${port}`)
    endpointUrl = `http://127.0.0.1:${port}${basePath}`
    const metadataUrl = `http://127.0.0.1:${port}${metadataPath}`
    return Object.freeze({
      port,
      url: endpointUrl,
      metadataUrl,
      surfaceFingerprint: OXP_STATIC_TRANSPORT.fingerprint,
      stop: (settings: { readonly forceAfterMs?: number } = {}) =>
        (stoppingPromise ??= (async () => {
          stopping = true
          let timeout: ReturnType<typeof setTimeout> | undefined
          const forced = new Promise<void>((resolve) => {
            timeout = setTimeout(() => {
              for (const socket of sockets) socket.destroy()
              resolve()
            }, Math.max(1, settings.forceAfterMs ?? 1_000))
            timeout.unref?.()
          })
          const closed = new Promise<void>((resolve) => server.close(() => resolve()))
          try {
            await Promise.race([Promise.all([closed, protocol.handler.close().catch(() => undefined)]), forced])
          } finally {
            if (timeout) clearTimeout(timeout)
          }
        })()),
    })
  } catch (error) {
    server.close()
    throw error
  }
}
