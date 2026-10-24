import { afterEach, expect, test } from "bun:test"
import { createServer } from "node:http"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WorkBuddyPlugin, classifyUnavailableWorkBuddy, setTestAccountStore, setTestBackend } from "@/plugin/workbuddy"
import { AccountVault } from "@/plugin/workbuddy-accounts"
import type { WorkBuddyAccount } from "@/plugin/workbuddy-accounts"
import { WorkBuddyEntitlementGovernor } from "@/plugin/workbuddy-governor"

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

test("concurrent live WorkBuddy discovery shares one account catalog request", async () => {
  const root = mkdtempSync(join(tmpdir(), "workbuddy-live-discovery-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  new AccountVault(root).save({
    path: join(root, "seed.json"),
    accessToken: "LIVE_TEST_TOKEN",
    refreshToken: "LIVE_TEST_REFRESH",
    domain: "www.workbuddy.ai",
    uid: "live-test-user",
    enterpriseId: "",
    expiresAt: Date.now() + 60_000,
    nickname: "live@example.com",
    enrollmentEpoch: "live-test-epoch",
  })
  setTestAccountStore(root)

  let upstreamRequests = 0
  const upstreamPaths: string[] = []
  const server = createServer((request, response) => {
    upstreamRequests++
    upstreamPaths.push(new URL(request.url ?? "/", "http://localhost").pathname)
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({
      data: {
        models: [{
          id: "fresh-model",
          name: "Fresh model",
          maxInputTokens: 65_536,
          maxOutputTokens: 8_192,
          supportsReasoning: true,
        }],
        agents: [{ name: "cli", models: ["fresh-model"] }],
      },
    }))
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
  const provider = hooks.provider!
  const input = { id: "workbuddy", name: "WorkBuddy", env: [], options: {}, models: {} } as never
  const [first, second] = await Promise.all([
    provider.discoverModels!(input, {}),
    provider.discoverModels!(input, {}),
  ])

  expect(upstreamPaths).toEqual(["/v3/config"])
  expect(upstreamRequests).toBe(1)
  expect(Object.keys(first)).toContain("fresh-model")
  expect(Object.keys(first).some((id) => id.startsWith("fresh-model@wb-"))).toBe(true)
  expect(Object.keys(second).sort()).toEqual(Object.keys(first).sort())
})

test("live discovery lets either enrolled account pin models advertised only by the other", async () => {
  const root = mkdtempSync(join(tmpdir(), "workbuddy-cross-account-pin-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const vault = new AccountVault(root)
  for (const [index, token] of ["ACCOUNT_A", "ACCOUNT_B"].entries()) {
    vault.save({
      path: join(root, `seed-${index}.json`),
      accessToken: token,
      refreshToken: `REFRESH_${token}`,
      domain: "www.workbuddy.ai",
      uid: `user-${index}`,
      enterpriseId: "",
      expiresAt: Date.now() + 60_000,
      nickname: `account-${index}@example.com`,
      enrollmentEpoch: `cross-account-${index}`,
    })
  }
  setTestAccountStore(root)

  const server = createServer((request, response) => {
    const name = request.headers.authorization?.includes("ACCOUNT_A") ? "model-only-a" : "model-only-b"
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({
      data: {
        models: [{ id: name, name, maxInputTokens: 65_536, maxOutputTokens: 8_192, supportsReasoning: true }],
        agents: [{ name: "cli", models: [name] }],
      },
    }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("mock WorkBuddy backend did not bind")
  setTestBackend(`http://127.0.0.1:${address.port}`)

  const hooks = await WorkBuddyPlugin({} as never)
  cleanups.push(() => hooks.dispose?.())
  const models = await hooks.provider!.discoverModels!(
    { id: "workbuddy", name: "WorkBuddy", env: [], options: {}, models: {} } as never,
    {},
  )

  const a = Object.keys(models).filter((id) => id.startsWith("model-only-a@wb-"))
  const b = Object.keys(models).filter((id) => id.startsWith("model-only-b@wb-"))
  expect(a).toHaveLength(2)
  expect(b).toHaveLength(2)
  // The selector can hard-pin either account to either model even when that
  // account's own catalog does not offer it. Execution still checks entitlement.
  expect(a.map((id) => id.split("@")[1]).sort()).toEqual(b.map((id) => id.split("@")[1]).sort())
  for (const id of [...a, ...b]) {
    expect(models[id]?.api.id).toBe(id)
    expect(models[id]?.headers["X-WorkBuddy-Account"]).toBe(id.split("@")[1])
  }
})

test("fresh funded billing clears a persisted quota block but not other account restrictions", () => {
  const root = mkdtempSync(join(tmpdir(), "workbuddy-quota-recovery-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, "state.json")
  writeFileSync(file, JSON.stringify({ schema: 2, state: "QUOTA_EXHAUSTED", resetAt: null, limitedEpoch: "original", at: Date.now() }))
  const governor = new WorkBuddyEntitlementGovernor({ persistenceFile: file })
  expect(governor.metrics().state).toBe("QUOTA_EXHAUSTED")
  governor.setPackageCredits(0)
  expect(governor.metrics().state).toBe("QUOTA_EXHAUSTED")
  governor.setPackageCredits(Number.NaN)
  expect(governor.metrics().state).toBe("QUOTA_EXHAUSTED")
  governor.setPackageCredits(1)
  expect(governor.metrics().state).toBe("READY")
  expect(new WorkBuddyEntitlementGovernor({ persistenceFile: file }).metrics().state).toBe("READY")
  governor.markAccountForbidden(11140)
  governor.setPackageCredits(100)
  expect(governor.metrics().state).toBe("ACCOUNT_FORBIDDEN")
})

test("a terminal exhausted and restricted account pool returns non-retryable errors", () => {
  const root = mkdtempSync(join(tmpdir(), "workbuddy-pool-errors-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, "quota.json")
  writeFileSync(file, JSON.stringify({ schema: 2, state: "QUOTA_EXHAUSTED", resetAt: null, limitedEpoch: "epoch", at: Date.now() }))
  const quota = new WorkBuddyEntitlementGovernor({ persistenceFile: file })
  const forbidden = new WorkBuddyEntitlementGovernor({ persistenceFile: join(root, "forbidden.json") })
  forbidden.markAccountForbidden(11140)
  const account = (governor: WorkBuddyEntitlementGovernor): WorkBuddyAccount => ({
    governor,
    catalog: { ids: new Set(["hy4-preview"]), updatedAt: Date.now() },
  }) as WorkBuddyAccount
  const exhausted = account(quota)
  const restricted = account(forbidden)

  expect(classifyUnavailableWorkBuddy([], "hy4-preview", 0)).toMatchObject({ status: 401 })
  expect(classifyUnavailableWorkBuddy([exhausted], "hy4-preview", 0)).toMatchObject({
    status: 402, type: "quota_exhausted",
  })
  expect(classifyUnavailableWorkBuddy([restricted], "hy4-preview", 1)).toMatchObject({
    status: 403, type: "account_forbidden",
  })
  expect(classifyUnavailableWorkBuddy([exhausted, restricted], "hy4-preview", 2)).toMatchObject({
    status: 403, type: "account_forbidden",
  })
  expect(classifyUnavailableWorkBuddy([exhausted], "unknown-model", 0)).toMatchObject({
    status: 404, type: "model_not_found",
  })
  // A user-selected hard pin is valid at selection time even when only a
  // different enrolled account offers the model. On generation, never infer
  // eligibility from that other account or reroute the pinned request.
  const unsupported = { ...exhausted, id: "wb-a" }
  const supported = { ...account(new WorkBuddyEntitlementGovernor({
    persistenceFile: join(root, "supported.json"),
  })), id: "wb-b" }
  expect(classifyUnavailableWorkBuddy([unsupported, supported], "hy4-preview", 0, "wb-b")).toMatchObject({
    status: 429, type: "account_temporarily_unavailable",
  })
  expect(classifyUnavailableWorkBuddy([unsupported, supported], "hy4-preview", 0, "wb-missing")).toMatchObject({
    status: 404, type: "account_not_found",
  })
  const crossAccount = [
    { ...unsupported, catalog: { ids: new Set(["model-only-a"]), updatedAt: Date.now() } },
    { ...supported, catalog: { ids: new Set(["model-only-b"]), updatedAt: Date.now() } },
  ]
  expect(classifyUnavailableWorkBuddy(crossAccount, "model-only-b", 0, "wb-a")).toMatchObject({
    status: 404, type: "model_not_found",
  })
  expect(classifyUnavailableWorkBuddy(crossAccount, "model-only-b", 0, "wb-b")).toMatchObject({
    status: 429, type: "account_temporarily_unavailable",
  })
  expect(classifyUnavailableWorkBuddy([exhausted, account(new WorkBuddyEntitlementGovernor({
    persistenceFile: join(root, "ready.json"),
  }))], "hy4-preview", 1)).toMatchObject({
    status: 429, type: "account_temporarily_unavailable",
  })
})