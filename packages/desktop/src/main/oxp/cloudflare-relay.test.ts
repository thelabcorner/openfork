import { afterEach, expect, test } from "bun:test"
import { createServer } from "node:http"
import { startOxpCloudflareRelay, type OxpCloudflareRelay } from "./cloudflare-relay"

let upstream: ReturnType<typeof createServer> | undefined
let relay: OxpCloudflareRelay | undefined

afterEach(async () => {
  await relay?.stop()
  relay = undefined
  if (upstream) await new Promise<void>((resolve) => upstream!.close(() => resolve()))
  upstream = undefined
})

test("Cloudflare relay forwards only the bearer route and translates MCP metadata", async () => {
  let seenPath = ""
  let seenHost = ""
  let sawOrigin = false
  upstream = createServer((request, response) => {
    seenPath = request.url ?? ""
    seenHost = request.headers.host ?? ""
    sawOrigin = request.headers.origin !== undefined
    if (request.url?.startsWith("/.well-known/")) {
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ resource: "http://127.0.0.1/resource", authorization_servers: [] }))
      return
    }
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }))
  })
  await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve))
  const address = upstream.address()
  if (!address || typeof address === "string") throw new Error("test upstream did not bind")
  relay = await startOxpCloudflareRelay(0)
  relay.setTarget(`http://127.0.0.1:${address.port}/mcp/local-secret`, "https://mcp.example.test/mcp/backup-secret")

  const response = await fetch(`http://127.0.0.1:${relay.port}/mcp/backup-secret`, {
    method: "POST",
    headers: { host: "mcp.example.test", origin: "https://mcp.example.test", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ result: { ok: true } })
  expect(seenPath).toBe("/mcp/local-secret")
  expect(seenHost).toBe(`127.0.0.1:${address.port}`)
  expect(sawOrigin).toBe(false)

  const metadata = await fetch(`http://127.0.0.1:${relay.port}/.well-known/oauth-protected-resource/mcp/backup-secret`, {
    headers: { host: "mcp.example.test" },
  })
  expect(metadata.status).toBe(200)
  expect(await metadata.json()).toMatchObject({ resource: "https://mcp.example.test/mcp/backup-secret" })

  const denied = await fetch(`http://127.0.0.1:${relay.port}/mcp/local-secret`, { headers: { host: "mcp.example.test" } })
  expect(denied.status).toBe(404)
})
