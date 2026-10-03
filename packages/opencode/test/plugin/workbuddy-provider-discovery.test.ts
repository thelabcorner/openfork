import { afterEach, expect, test } from "bun:test"
import { createServer } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WorkBuddyPlugin, setTestAccountStore, setTestBackend } from "@/plugin/workbuddy"
import { AccountVault } from "@/plugin/workbuddy-accounts"

const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  setTestBackend(undefined)
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

test("passive WorkBuddy model materialization never waits on upstream discovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "workbuddy-provider-discovery-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  new AccountVault(root).save({
    path: join(root, "seed.json"),
    accessToken: "PASSIVE_TEST_TOKEN",
    refreshToken: "PASSIVE_TEST_REFRESH",
    domain: "www.workbuddy.ai",
    uid: "passive-test-user",
    enterpriseId: "",
    expiresAt: Date.now() + 60_000,
    nickname: "passive@example.com",
    enrollmentEpoch: "passive-test-epoch",
  })
  setTestAccountStore(root)

  let upstreamRequests = 0
  const server = createServer((_request, response) => {
    upstreamRequests++
    response.writeHead(503, { "content-type": "application/json" })
    response.end(JSON.stringify({ error: "passive catalog reads must not reach upstream" }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("fake WorkBuddy backend did not bind")
  setTestBackend(`http://127.0.0.1:${address.port}`)

  const hooks = await WorkBuddyPlugin({} as never)
  cleanups.push(() => hooks.dispose?.())
  const provider = hooks.provider
  expect(provider?.discoveryMode).toBe("replace")
  expect(provider?.discoverModels).toBeDefined()

  const passive = await provider!.models!(
    {
      id: "workbuddy",
      name: "WorkBuddy",
      env: [],
      options: {},
      models: {},
    } as never,
    {},
  )

  expect(Object.keys(passive).length).toBeGreaterThan(0)
  expect(Object.keys(passive).some((id) => id.includes("@wb-"))).toBe(true)
  expect(upstreamRequests).toBe(0)
})