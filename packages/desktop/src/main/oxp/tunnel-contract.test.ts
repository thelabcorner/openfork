import { describe, expect, test } from "bun:test"
import {
  MAX_TUNNEL_LOG_LINE_CHARS,
  NO_OUTAGE,
  boundedTunnelLineReader,
  describeNetworkError,
  isAuthFailure,
  isUnreachableError,
  outageConfirmed,
  outageRecovered,
  parseLoopbackHealthUrl,
  redactTunnelText,
  routeObservation,
  restartBackoffMs,
  tunnelLaunchSpec,
} from "./tunnel-contract"

describe("OXP OpenAI tunnel contract", () => {
  test("keeps both API key and secret local MCP URL out of argv", () => {
    const secret = "sk-secret-never-argv"
    const local = "http://127.0.0.1:41234/mcp/secret-local-route"
    const spec = tunnelLaunchSpec({
      localUrl: local,
      tunnelID: `tunnel_${"a".repeat(32)}`,
      apiKey: secret,
      healthFile: "C:\\Temp\\health.url",
    })
    expect(spec.args.join(" ")).not.toContain(secret)
    expect(spec.args.join(" ")).not.toContain(local)
    expect(spec.env.CONTROL_PLANE_API_KEY).toBe(secret)
    expect(spec.env.MCP_SERVER_URL).toContain(local)
    expect(spec.args).toContain("127.0.0.1:0")
  })

  test("distinguishes fresh remote route proof from a sustained network outage", () => {
    const now = 1_000_000
    expect(routeObservation(now - 10_000, null, NO_OUTAGE, now)).toBe("connected")
    // A readable zero means the tunnel client has completed its first poll
    // cycle even before it has a successful timestamp; the standalone oracle
    // treats that as locally/route ready rather than an indeterminate failure.
    expect(routeObservation(0, null, NO_OUTAGE, now)).toBe("connected")
    expect(routeObservation(now - 200_000, now - 200_000, NO_OUTAGE, now)).toBe("offline")
    expect(routeObservation(now - 200_000, null, { since: now - 40_000, handshakeBefore: now - 200_000 }, now)).toBe("offline")
    expect(routeObservation(null, now - 1_000, NO_OUTAGE, now)).toBe("unknown")
  })

  test("requires a sustained outage and clears it only after a newer completed poll", () => {
    const now = 1_000_000
    const run = { since: now - 34_000, handshakeBefore: now - 80_000 }
    expect(outageConfirmed(run, now)).toBe(false)
    expect(outageConfirmed({ ...run, since: now - 36_000 }, now)).toBe(true)
    expect(outageRecovered(run, now - 80_000)).toBe(false)
    expect(outageRecovered(run, now - 79_999)).toBe(true)
    expect(outageRecovered({ since: now - 10_000, handshakeBefore: null }, now - 1_000)).toBe(true)
  })

  test("classifies only control-plane poll network errors as OpenAI outages", () => {
    expect(isUnreachableError("poll failed: dial tcp: i/o timeout")).toBe(true)
    expect(isUnreachableError("poll timed out; backing off: no such host")).toBe(true)
    expect(isUnreachableError("mcp probe failed: i/o timeout")).toBe(false)
    expect(describeNetworkError("poll failed: no such host")).toBe("no internet connection")
    expect(describeNetworkError("poll failed: connection reset")).toBe("the connection dropped")
  })

  test("treats credential/tunnel authorization failures as terminal and bounds restart backoff", () => {
    expect(isAuthFailure("control plane returned HTTP 401 Unauthorized")).toBe(true)
    expect(isAuthFailure("HTTP 403 forbidden")).toBe(true)
    expect(isAuthFailure("poll failed: dial tcp: i/o timeout")).toBe(false)
    expect(restartBackoffMs(1)).toBe(2_000)
    expect(restartBackoffMs(2)).toBe(4_000)
    expect(restartBackoffMs(6)).toBe(60_000)
    expect(restartBackoffMs(100)).toBe(60_000)
  })

  test("redacts both connector credentials and secret loopback routes from child diagnostics", () => {
    const apiKey = "sk-should-never-leak"
    const localUrl = "http://127.0.0.1:4567/mcp/secret-route"
    const text = redactTunnelText(
      `WARN request failed apiKey=${apiKey} MCP_SERVER_URL=url=${localUrl},channel=main`,
      [apiKey, localUrl],
    )
    expect(text).not.toContain(apiKey)
    expect(text).not.toContain(localUrl)
    expect(text.match(/\[REDACTED\]/g)?.length).toBe(2)
  })

  test("accepts only the exact loopback HTTP health origin emitted by the pinned client", () => {
    expect(parseLoopbackHealthUrl("http://127.0.0.1:43210/\n")).toBe("http://127.0.0.1:43210")
    expect(parseLoopbackHealthUrl("https://127.0.0.1:43210")).toBeNull()
    expect(parseLoopbackHealthUrl("http://localhost:43210")).toBeNull()
    expect(parseLoopbackHealthUrl("http://127.0.0.1:43210/path")).toBeNull()
    expect(parseLoopbackHealthUrl("http://127.0.0.1:43210/?x=1")).toBeNull()
    expect(parseLoopbackHealthUrl("http://example.com:43210")).toBeNull()
    expect(parseLoopbackHealthUrl(`http://127.0.0.1:43210/${"x".repeat(600)}`)).toBeNull()
  })

  test("drops oversized newline-terminated and unterminated child log records before parsing", () => {
    const lines: string[] = []
    const read = boundedTunnelLineReader((line) => lines.push(line))
    read(Buffer.from(`ok\n${"x".repeat(MAX_TUNNEL_LOG_LINE_CHARS + 1)}\n`))
    read(Buffer.from("y".repeat(MAX_TUNNEL_LOG_LINE_CHARS + 1)))
    read(Buffer.from("\nstill-ok\n"))
    expect(lines).toEqual(["ok", "still-ok"])
  })
})
