import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { timingSafeEqual } from "node:crypto"
import { Readable } from "node:stream"

/**
 * Stable, loopback-only origin for a user-managed Cloudflare Tunnel.
 * The secret OXP path is the only route forwarded. Cloudflare's public Host
 * header is deliberately replaced with the local Host accepted by OXP.
 */
export type OxpCloudflareRelay = {
  port: number
  setTarget(url: string | undefined, publicUrl?: string): void
  stop(): Promise<void>
}

function reply(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" })
  res.end(message)
}

export async function startOxpCloudflareRelay(port = 42991): Promise<OxpCloudflareRelay> {
  let target: URL | undefined
  let external: URL | undefined
  let closed: Promise<void> | undefined
  const server = createServer((incoming, outgoing) => {
    const current = target
    if (!current) {
      incoming.resume()
      reply(outgoing, 503, "OXP endpoint is not ready")
      return
    }
    const pathname = (incoming.url ?? "").split("?", 1)[0]
    const routePath = external?.pathname
    if (!routePath) {
      incoming.resume()
      reply(outgoing, 503, "OXP Cloudflare route is not configured")
      return
    }
    const metadataPrefix = "/.well-known/oauth-protected-resource"
    const isMetadata = pathname?.startsWith(metadataPrefix) ?? false
    const offeredRoute = isMetadata ? pathname!.slice(metadataPrefix.length) : pathname ?? ""
    if (!offeredRoute.startsWith("/mcp/")) {
      incoming.resume()
      reply(outgoing, 404, "Not found")
      return
    }
    // The route token is a bearer secret. Compare it without early exit.
    const offered = Buffer.from(offeredRoute)
    const expected = Buffer.from(routePath)
    if (offered.length !== expected.length || !timingSafeEqual(offered, expected)) {
      incoming.resume()
      reply(outgoing, 404, "Not found")
      return
    }
    const localPath = isMetadata ? `/.well-known/oauth-protected-resource${current.pathname}` : current.pathname
    const query = (incoming.url ?? "").includes("?") ? (incoming.url ?? "").slice((incoming.url ?? "").indexOf("?")) : ""
    const url = new URL(`${localPath}${query}`, current.origin)
    const headers = new Headers()
    for (const [name, value] of Object.entries(incoming.headers)) {
      const normalized = name.toLowerCase()
      if (value === undefined || ["content-length", "transfer-encoding", "connection", "host", "origin"].includes(normalized)) continue
      if (Array.isArray(value)) value.forEach((item) => headers.append(name, item))
      else headers.set(name, value)
    }
    headers.set("host", current.host)
    // The local listener only accepts loopback HTTP origins. A public HTTPS
    // Origin is not needed for MCP and must not be trusted at this boundary.
    const upstream = fetch(url, {
      method: incoming.method,
      headers,
      body: incoming.method === "GET" || incoming.method === "HEAD" ? undefined : Readable.toWeb(incoming) as unknown as BodyInit,
      // Node requires duplex for streaming request bodies.
      ...(incoming.method === "GET" || incoming.method === "HEAD" ? {} : { duplex: "half" as const }),
      redirect: "manual",
    })
    void upstream.then(async (response) => {
      if (outgoing.destroyed) return
      if (isMetadata && response.ok) {
        const body = await response.text()
        let rewritten = body
        try {
          const metadata = JSON.parse(body) as Record<string, unknown>
          if (typeof metadata.resource === "string" && external) metadata.resource = external.toString()
          rewritten = JSON.stringify(metadata)
        } catch {
          // Preserve the upstream response if it is not the metadata shape.
        }
        outgoing.writeHead(response.status, {
          "content-type": "application/json",
          "cache-control": "no-store",
          "content-length": Buffer.byteLength(rewritten),
        })
        outgoing.end(rewritten)
        return
      }
      const responseHeaders: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() === "transfer-encoding" || key.toLowerCase() === "connection") return
        responseHeaders[key] = value
      })
      outgoing.writeHead(response.status, responseHeaders)
      if (!response.body) return outgoing.end()
      const reader = response.body.getReader()
      try {
        while (true) {
          const part = await reader.read()
          if (part.done || outgoing.destroyed) break
          if (!outgoing.write(Buffer.from(part.value))) await new Promise<void>((resolve) => outgoing.once("drain", resolve))
        }
        if (!outgoing.destroyed) outgoing.end()
      } finally {
        reader.releaseLock()
      }
    }).catch(() => {
      if (!outgoing.headersSent) reply(outgoing, 502, "OXP endpoint unavailable")
      else outgoing.destroy()
    })
  })
  server.headersTimeout = 30_000
  server.requestTimeout = 300_000
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  return {
    port: address.port,
    setTarget(value, publicUrl) {
      if (value === undefined) {
        target = undefined
        external = undefined
        return
      }
      const url = new URL(value)
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.pathname.startsWith("/mcp/")) {
        throw new Error("Cloudflare relay target must be a secret loopback OXP URL")
      }
      target = url
      if (publicUrl) {
        const remote = new URL(publicUrl)
        if (remote.protocol !== "https:") throw new Error("Cloudflare backup URL must use HTTPS")
        external = remote
      }
    },
    stop() {
      return (closed ??= new Promise<void>((resolve) => server.close(() => resolve())))
    },
  }
}
