import { POLL_FRESH_MS } from "./tunnel-health"

export type Outage = { since: number; handshakeBefore: number | null }
export const NO_OUTAGE: Outage = Object.freeze({ since: 0, handshakeBefore: null })
export const UNREACHABLE_CONFIRM_MS = 35_000
export const MAX_RESTART_BACKOFF_MS = 60_000
export const MAX_TUNNEL_LOG_LINE_CHARS = 16_384
const CONTROL_PLANE_POLL = /\bpoll (?:failed|timed out(?:;\s*backing off)?)\b/i
const UNREACHABLE_NETWORK = /no such host|dial tcp|i\/o timeout|timed out|context deadline exceeded|connection (was )?(aborted|refused|reset)|network is (unreachable|down)|no route to host|tls handshake timeout|temporary failure in name resolution|forcibly closed/i
const AUTH_FAILURE = /\b(401|403|unauthorized|invalid[_ ]api[_ ]key|invalid_request_error|forbidden)\b/i

export function isAuthFailure(raw: string) {
  return AUTH_FAILURE.test(String(raw || ""))
}

export function restartBackoffMs(attempt: number) {
  const normalized = Math.max(1, Math.min(31, Math.floor(attempt)))
  return Math.min(MAX_RESTART_BACKOFF_MS, 2_000 * 2 ** (normalized - 1))
}

export function describeNetworkError(raw: string) {
  if (/no such host|name resolution/i.test(raw)) return "no internet connection"
  if (/connection (was )?(aborted|reset)|forcibly closed/i.test(raw)) return "the connection dropped"
  if (/refused/i.test(raw)) return "the connection was refused"
  if (/timeout|timed out|context deadline exceeded/i.test(raw)) return "the connection timed out"
  if (/network is (unreachable|down)|no route to host/i.test(raw)) return "the network is unreachable"
  return "a network error"
}

export function isUnreachableError(raw: string) {
  const text = String(raw || "")
  return CONTROL_PLANE_POLL.test(text) && UNREACHABLE_NETWORK.test(text)
}

export function redactTunnelText(raw: unknown, secrets: readonly string[]) {
  let value = String(raw ?? "")
  for (const secret of secrets) {
    if (!secret) continue
    value = value.split(secret).join("[REDACTED]")
  }
  return value
}

export function parseLoopbackHealthUrl(raw: string) {
  const value = raw.trim()
  if (!value || value.length > 512) return null
  try {
    const url = new URL(value)
    const port = Number(url.port)
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65_535 ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "")
    ) {
      return null
    }
    return `http://127.0.0.1:${port}`
  } catch {
    return null
  }
}

export function boundedTunnelLineReader(onLine: (line: string) => void) {
  let carry = ""
  return (chunk: Buffer) => {
    carry += chunk.toString("utf8")
    let at = carry.indexOf("\n")
    while (at !== -1) {
      const line = carry.slice(0, at).trimEnd()
      carry = carry.slice(at + 1)
      if (line && line.length <= MAX_TUNNEL_LOG_LINE_CHARS) onLine(line)
      at = carry.indexOf("\n")
    }
    // Never retain an unbounded attacker-/child-controlled partial record.
    if (carry.length > MAX_TUNNEL_LOG_LINE_CHARS) carry = ""
  }
}

export function outageConfirmed(run: Outage, now: number) {
  return run.since !== 0 && now - run.since >= UNREACHABLE_CONFIRM_MS
}

export function outageRecovered(run: Outage, lastHandshake: number | null) {
  if (run.since === 0 || lastHandshake === null) return false
  return run.handshakeBefore === null || lastHandshake > run.handshakeBefore
}

export function tunnelLaunchSpec(input: { localUrl: string; tunnelID: string; apiKey: string; healthFile: string }) {
  return {
    args: [
      "run",
      "--control-plane.tunnel-id",
      input.tunnelID,
      "--health.listen-addr",
      "127.0.0.1:0",
      "--health.url-file",
      input.healthFile,
      "--log.format",
      "json",
      "--log.level",
      "info",
    ],
    env: {
      CONTROL_PLANE_API_KEY: input.apiKey,
      MCP_SERVER_URL: `url=${input.localUrl},channel=main`,
    },
  }
}

export function routeObservation(
  pollLastSuccess: number | null,
  lastHandshake: number | null,
  outage: Outage,
  now = Date.now(),
): "connected" | "offline" | "unknown" {
  if (pollLastSuccess === null) return "unknown"
  if (outageConfirmed(outage, now)) return "offline"
  if (lastHandshake === null) return "connected"
  return now - lastHandshake > POLL_FRESH_MS ? "offline" : "connected"
}
