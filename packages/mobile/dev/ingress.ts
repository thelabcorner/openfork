import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http"
import type { Duplex } from "node:stream"

const PROXY_HEADERS = [
  "cf-connecting-ip",
  "cf-ray",
  "cf-visitor",
  "forwarded",
  "true-client-ip",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
] as const

export type DevIngressVerdict =
  | { ok: true }
  | { ok: false; reason: "proxy" | "remote-address" | "host" | "origin" }

function firstHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value
}

function normalizeAddress(value: string | undefined) {
  const address = value?.trim().toLowerCase()
  if (!address) return undefined
  return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address
}

function privateIPv4(host: string) {
  const parts = host.split(".")
  if (parts.length !== 4) return false
  const octets = parts.map((part) => Number(part))
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const a = octets[0]!
  const b = octets[1]!
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  )
}

function privateIPv6(host: string) {
  const value = host.toLowerCase()
  if (value === "::1") return true
  if (value.startsWith("fc") || value.startsWith("fd")) return true
  return /^fe[89ab]/.test(value)
}

export function isPrivateDevHost(value: string | undefined) {
  const host = normalizeAddress(value?.replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, ""))
  if (!host) return false
  if (host === "localhost" || host.endsWith(".localhost")) return true
  return privateIPv4(host) || privateIPv6(host)
}

function hostnameFromAuthority(value: string | undefined) {
  if (!value) return undefined
  try {
    return new URL(`http://${value}`).hostname
  } catch {
    return undefined
  }
}

function hostnameFromOrigin(value: string | undefined) {
  if (!value || value === "null") return undefined
  try {
    return new URL(value).hostname
  } catch {
    return ""
  }
}

export function devIngressVerdict(input: {
  headers: IncomingHttpHeaders
  remoteAddress?: string
}): DevIngressVerdict {
  if (PROXY_HEADERS.some((name) => firstHeader(input.headers[name]) !== undefined)) {
    return { ok: false, reason: "proxy" }
  }

  if (!isPrivateDevHost(input.remoteAddress)) return { ok: false, reason: "remote-address" }

  const host = hostnameFromAuthority(firstHeader(input.headers.host))
  if (!isPrivateDevHost(host)) return { ok: false, reason: "host" }

  const origin = hostnameFromOrigin(firstHeader(input.headers.origin))
  if (origin !== undefined && !isPrivateDevHost(origin)) return { ok: false, reason: "origin" }

  return { ok: true }
}

export function devIngressAllowed(request: IncomingMessage) {
  return devIngressVerdict({
    headers: request.headers,
    remoteAddress: request.socket.remoteAddress,
  }).ok
}

export function privateDevIngressMiddleware(
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
) {
  const verdict = devIngressVerdict({ headers: request.headers, remoteAddress: request.socket.remoteAddress })
  if (verdict.ok) return next()

  response.statusCode = 403
  response.setHeader("Content-Type", "text/plain; charset=utf-8")
  response.setHeader("Cache-Control", "no-store")
  response.end("OpenFork mobile development server is private-network only.\n")
}

export function rejectPublicDevUpgrade(request: IncomingMessage, socket: Duplex) {
  if (devIngressAllowed(request)) return false
  socket.write(
    "HTTP/1.1 403 Forbidden\r\n" +
      "Connection: close\r\n" +
      "Cache-Control: no-store\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      "Content-Length: 0\r\n\r\n",
  )
  socket.destroy()
  return true
}