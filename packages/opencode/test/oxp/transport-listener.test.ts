import { describe, expect, test } from "bun:test"
import { Client as ModernClient, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport as LegacyTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { startLeanOxpListener } from "../../src/oxp/transport-listener"
import { OXP_STATIC_TRANSPORT } from "../../src/oxp/transport-manifest"

function response() {
  return {
    result: {
      content: [{ type: "text" as const, text: "ok" }],
      structuredContent: { output: "ok" },
    },
  }
}

describe("OXP lightweight real listener", () => {
  test("binds the same unguessable endpoint for modern/legacy list and executes only via its callback", async () => {
    let calls = 0
    const endpoint = await startLeanOxpListener({
      async execute() {
        calls++
        return response()
      },
    })
    const modern = new ModernClient(
      { name: "lean-modern", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    )
    const legacy = new LegacyClient({ name: "lean-legacy", version: "1.0.0" })
    try {
      expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[A-Za-z0-9_-]{43}$/)
      expect(endpoint.surfaceFingerprint).toBe(OXP_STATIC_TRANSPORT.fingerprint)
      await modern.connect(new StreamableHTTPClientTransport(new URL(endpoint.url)))
      await legacy.connect(new LegacyTransport(new URL(endpoint.url)))
      expect((await modern.listTools()).tools).toHaveLength(14)
      expect((await legacy.listTools()).tools).toHaveLength(14)
      expect(calls).toBe(0)
      const result = await modern.callTool({ name: "read", arguments: { rootID: "fixture" } })
      expect(result.isError).not.toBe(true)
      expect(calls).toBe(1)
    } finally {
      await Promise.all([modern.close().catch(() => undefined), legacy.close().catch(() => undefined)])
      await endpoint.stop()
    }
  }, 15_000)

  test("blocks invalid paths and hostile Host/Origin headers before executor", async () => {
    let calls = 0
    const endpoint = await startLeanOxpListener({
      async execute() {
        calls++
        return response()
      },
    })
    try {
      const invalidPath = await fetch(endpoint.url + "-invalid", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
      expect(invalidPath.status).toBe(404)
      const badOrigin = await fetch(endpoint.url, {
        method: "POST", headers: { origin: "https://attacker.invalid", "content-type": "application/json" },
        body: "{}",
      })
      expect(badOrigin.status).toBe(403)
      const noPost = await fetch(endpoint.url)
      expect(noPost.status).toBe(405)
      expect(calls).toBe(0)
    } finally {
      await endpoint.stop()
    }
  }, 15_000)

  test("coalesces concurrent stop callers, rejects requests during retirement", async () => {
    const endpoint = await startLeanOxpListener({ async execute() { return response() } })
    await Promise.all([endpoint.stop({ forceAfterMs: 500 }), endpoint.stop({ forceAfterMs: 500 })])
    await expect(fetch(endpoint.url, { method: "POST", body: "{}" })).rejects.toThrow()
  })

  test("arms each after-response continuation once only after the client receives its MCP reply", async () => {
    let receipts = 0
    const endpoint = await startLeanOxpListener({
      async execute() {
        return { ...response(), afterResponse: () => { receipts++ } }
      },
    })
    const client = new ModernClient(
      { name: "lean-receipt", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    )
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url)))
      for (let i = 0; i < 8; i++) {
        const result = await client.callTool({ name: "read", arguments: { rootID: "fixture" } })
        expect(result.isError).not.toBe(true)
      }
      // The server observes HTTP finish after the response bytes are handed
      // off. The client may complete before the server's microtask settles.
      for (let retry = 0; retry < 20 && receipts !== 8; retry++) await Bun.sleep(5)
      expect(receipts).toBe(8)
    } finally {
      await client.close().catch(() => undefined)
      await endpoint.stop()
    }
  }, 15_000)
})
