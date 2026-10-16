import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import path from "node:path"
import { tunnelLaunchSpec } from "./tunnel-contract"
import { startTunnelSupervisor, type OxpTunnelReport } from "./tunnel-supervisor"

const binary = path.resolve(
  import.meta.dir,
  `../../../resources/tunnel/tunnel-client${process.platform === "win32" ? ".exe" : ""}`,
)

// Exercise the installed checksum-pinned runtime without contacting OpenAI,
// reading user credentials, or changing the running desktop's tunnel.
test.skipIf(!existsSync(binary))(
  "pinned tunnel runtime retries 503 with Retry-After and proves recovery through metrics",
  async () => {
    const polls: number[] = []
    const reports: OxpTunnelReport[] = []
    const logs: Array<{ message: string; extra?: Record<string, unknown>; level?: string }> = []
    const id = `tunnel_${"a".repeat(32)}`
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === `/v1/tunnels/${id}/poll`) {
          polls.push(Date.now())
          if (polls.length <= 2)
            return Response.json(
              {
                error: {
                  code: "tunnel_transport_unavailable",
                  message: "Tunnel transport temporarily unavailable; retry the request",
                },
              },
              { status: 503, headers: { "Retry-After": "1" } },
            )
          await Bun.sleep(1_000)
          return new Response(null, { status: 204 })
        }
        if (url.pathname === `/v1/tunnels/${id}`) return Response.json({ id, name: "local retry test" })
        if (url.pathname === "/mcp" && request.method === "POST") {
          const body = await request.text()
          if (!body) return new Response(null, { status: 400 })
          const rpc = JSON.parse(body) as { id?: number; method?: string; params?: { protocolVersion?: string } }
          if (rpc.id === undefined) return new Response(null, { status: 202 })
          return Response.json({
            jsonrpc: "2.0",
            id: rpc.id,
            result:
              rpc.method === "initialize"
                ? {
                    protocolVersion: rpc.params?.protocolVersion ?? "2025-03-26",
                    capabilities: { tools: {} },
                    serverInfo: { name: "retry-test", version: "1" },
                  }
                : { tools: [] },
          })
        }
        return new Response(null, { status: 404 })
      },
    })
    const base = `http://127.0.0.1:${server.port}`
    const handle = await startTunnelSupervisor({
      binary,
      launch: (healthFile) => {
        const spec = tunnelLaunchSpec({ healthFile, tunnelID: id, apiKey: "fake-secret", localUrl: `${base}/mcp` })
        return {
          args: [...spec.args, "--control-plane.base-url", base],
          env: {
            ...spec.env,
            HTTP_PROXY: "",
            HTTPS_PROXY: "",
            ALL_PROXY: "",
            NO_PROXY: "127.0.0.1",
          },
        }
      },
      secrets: ["fake-secret", `${base}/mcp`],
      report: (report) => reports.push(report),
      log: (message, extra, level) => logs.push({ message, extra, level }),
    })
    try {
      const deadline = Date.now() + 50_000
      while (!reports.some((report) => report.state === "connected") && Date.now() < deadline) await Bun.sleep(50)
      expect(polls.length).toBeGreaterThanOrEqual(3)
      expect(polls[1]! - polls[0]!).toBeGreaterThanOrEqual(1_000)
      expect(polls[2]! - polls[1]!).toBeGreaterThanOrEqual(1_000)
      expect(reports.some((report) => report.state === "connected" && report.handshakeAt)).toBe(true)
      expect(reports.some((report) => report.state === "auth-failed" || report.detail?.includes("Reconnecting"))).toBe(
        false,
      )
      const retry = logs.filter((entry) => entry.message === "OpenAI tunnel control-plane poll is retrying")
      expect(retry).toHaveLength(1)
      expect(retry[0]?.extra?.kind).toBe("service")
      expect(logs.filter((entry) => entry.message === "OpenAI tunnel control-plane poll recovered")).toHaveLength(1)
      expect(
        logs.some(
          (entry) =>
            entry.message === "tunnel-client reported a warning" && String(entry.extra?.detail).includes("503"),
        ),
      ).toBe(false)
    } finally {
      await handle.stop()
      server.stop(true)
    }
  },
  60_000,
)
