import { describe, expect, test } from "bun:test"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { Client as ModernClient, StreamableHTTPClientTransport as ModernHTTP } from "@modelcontextprotocol/client"
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport as LegacyHTTP } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createOxpTransportProtocol } from "../../src/oxp/transport-protocol"
import { OXP_STATIC_TRANSPORT } from "../../src/oxp/transport-manifest"
import { paginateToolList, registerLegacyManifest } from "../../src/oxp/transport-pagination"
import { sendMcpResponse } from "../../src/oxp/response-stream"

function mockProtocol() {
  let executed = 0
  const protocol = createOxpTransportProtocol({
    paginate: paginateToolList,
    registerLegacy: registerLegacyManifest,
    async execute() {
      executed++
      throw new Error("No workspace execution owner installed in standalone transport")
    },
    internalError(_error, _phase, name) {
      return {
        isError: true,
        content: [{ type: "text", text: "NO_EXECUTOR" }],
        structuredContent: { output: "NO_EXECUTOR", error: { code: "NO_EXECUTOR", message: "No execution runtime", retryable: false } },
      }
    },
  })
  return { protocol, get executed() { return executed } }
}

async function loopback(protocol: ReturnType<typeof mockProtocol>["protocol"]) {
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const headers = new Headers()
      for (const [key, value] of Object.entries(req.headers)) {
        if (key.toLowerCase() === "content-length" || value === undefined) continue
        if (Array.isArray(value)) for (const entry of value) headers.append(key, entry)
        else headers.set(key, value)
      }
      const request = new Request("http://127.0.0.1/mcp", {
        method: req.method,
        headers,
        body: Buffer.concat(chunks).toString("utf8"),
      })
      const response = await protocol.handler.fetch(request)
      await sendMcpResponse(res, response)
    })().catch(() => res.destroy())
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: new URL(`http://127.0.0.1:${port}/mcp`),
    async close() { await new Promise<void>((resolve) => server.close(() => resolve())) },
  }
}

describe("OXP standalone, execution-free MCP transport plane", () => {
  test("modern client initializes and lists all exact schemas, then fails closed on tools/call", async () => {
    const mock = mockProtocol()
    const endpoint = await loopback(mock.protocol)
    const client = new ModernClient(
      { name: "standalone-modern", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    )
    try {
      await client.connect(new ModernHTTP(endpoint.url))
      const listed = await client.listTools()
      expect(listed.tools.map((tool) => tool.name)).toEqual(OXP_STATIC_TRANSPORT.tools.map((tool) => tool.name).sort())
      for (const expected of OXP_STATIC_TRANSPORT.tools) {
        const projected = listed.tools.find((tool) => tool.name === expected.name)
        expect(projected?.inputSchema).toEqual(expected.inputSchema)
        expect(projected?.outputSchema).toEqual(expected.outputSchema)
        expect(projected?.annotations).toEqual(expected.annotations)
        expect(projected?._meta).toEqual(expected._meta)
        // The MCP client normalizes away top-level securitySchemes; the OXP
        // declaration is still carried in canonical _meta.securitySchemes.
      }
      expect(client.getServerVersion()?.version).toContain(OXP_STATIC_TRANSPORT.fingerprint.slice(0, 12))
      expect(mock.executed).toBe(0)
      const result = await client.callTool({ name: "read", arguments: { rootID: "not-an-approved-root", path: "x" } })
      expect(result.isError).toBe(true)
      expect(mock.executed).toBe(1)
    } finally {
      await client.close().catch(() => undefined)
      await endpoint.close()
    }
  }, 12_000)

  test("legacy client negotiates and sees the complete transport manifest without workspace services", async () => {
    const mock = mockProtocol()
    const endpoint = await loopback(mock.protocol)
    const client = new LegacyClient({ name: "standalone-legacy", version: "1.0.0" })
    try {
      await client.connect(new LegacyHTTP(endpoint.url))
      const listed = await client.listTools()
      expect(listed.tools.map((tool) => tool.name)).toEqual(OXP_STATIC_TRANSPORT.tools.map((tool) => tool.name).sort())
      for (const tool of listed.tools) expect(tool.outputSchema?.required).toBeUndefined()
      expect(mock.executed).toBe(0)
    } finally {
      await client.close().catch(() => undefined)
      await endpoint.close()
    }
  }, 12_000)
})
