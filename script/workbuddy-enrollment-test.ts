/**
 * Offline OAuth enrollment/vault test.
 *
 * It mocks Tencent's normal state -> token -> account flow, enrolls two distinct
 * accounts, then simulates the desktop auth location containing only B. The
 * OpenFork-owned vault must keep both A and B.
 *
 * Run: bun run script/workbuddy-enrollment-test.ts
 */
import { mkdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { AccountRegistry, AccountVault, pollWorkBuddyOAuth, startWorkBuddyOAuth } from "../packages/opencode/src/plugin/workbuddy-accounts"

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) passed++
  else failed++
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -> ${detail}` : ""}`)
}

const root = join(tmpdir(), `wb-enrollment-${Date.now()}`)
mkdirSync(root, { recursive: true })
const vault = new AccountVault(join(root, "vault"))
const originalFetch = globalThis.fetch
let stateNumber = 0
let pollCounts = new Map<string, number>()

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  if (url.includes("/v2/plugin/auth/state")) {
    const state = `oauth-state-${++stateNumber}`
    pollCounts.set(state, 0)
    return new Response(JSON.stringify({ code: 0, data: { state, authUrl: `https://login.example/${state}` } }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Set-Cookie": `sid=${state}; Path=/` },
    })
  }
  if (url.includes("/v2/plugin/auth/token?state=")) {
    const state = new URL(url).searchParams.get("state")!
    const count = (pollCounts.get(state) ?? 0) + 1
    pollCounts.set(state, count)
    if (count === 1) return new Response(JSON.stringify({ code: 10001, msg: "login ing" }), { status: 200 })
    const uid = state.endsWith("1") ? "uid-a" : "uid-b"
    return new Response(JSON.stringify({ code: 0, data: { accessToken: `access-${uid}`, refreshToken: `refresh-${uid}`, expiresIn: 3600, domain: "www.workbuddy.ai" } }), { status: 200 })
  }
  if (url.includes("/v2/plugin/login/account?state=")) {
    const state = new URL(url).searchParams.get("state")!
    const uid = state.endsWith("1") ? "uid-a" : "uid-b"
    return new Response(JSON.stringify({ code: 0, data: { uid, enterpriseId: `ent-${uid}`, nickname: uid === "uid-a" ? "Account A" : "Account B" } }), { status: 200 })
  }
  throw new Error(`unexpected mock URL ${url}`)
}) as typeof fetch

try {
  const aStart = await startWorkBuddyOAuth("global")
  check("OAuth start returns a browser URL", aStart.url.includes("oauth-state-1"), aStart.url)
  const aPending = await pollWorkBuddyOAuth(aStart.state, vault)
  check("first OAuth poll is pending", aPending.status === "pending")
  const aDone = await pollWorkBuddyOAuth(aStart.state, vault)
  check("first OAuth enrollment returns uid-a", aDone.status === "success" && aDone.credential.uid === "uid-a")

  const bStart = await startWorkBuddyOAuth("global")
  const bPending = await pollWorkBuddyOAuth(bStart.state, vault)
  const bFinal = await pollWorkBuddyOAuth(bStart.state, vault)
  check("second OAuth flow has independent state", bStart.state !== aStart.state)
  check("second OAuth first poll is pending", bPending.status === "pending")
  check("second OAuth enrollment completes", bFinal.status === "success" && bFinal.credential.uid === "uid-b")

  // The vault is now authoritative and contains both enrolled users.
  const saved = vault.list()
  check("vault stores two UID-scoped credentials", saved.length === 2, saved.map((item) => item.uid).join(","))

  const currentDesktop = join(root, "current", "workbuddy-desktop.info")
  mkdirSync(join(root, "current"), { recursive: true })
  // This test intentionally provides only B in the official desktop location.
  const bJson = JSON.stringify({ auth: { accessToken: "desktop-b", refreshToken: "desktop-refresh-b", domain: "www.workbuddy.ai", expiresAt: Date.now() + 3600000 }, account: { uid: "uid-b", enterpriseId: "ent-uid-b", nickname: "Account B" } })
  await Bun.write(currentDesktop, bJson)
  const registry = new AccountRegistry({ authFiles: [currentDesktop], vault, persistenceDir: join(root, "state") })
  const afterSwitch = registry.all()
  check("desktop switch with only B does not remove enrolled A", afterSwitch.some((account) => account.uid === "uid-a"))
  check("desktop switch keeps enrolled B", afterSwitch.some((account) => account.uid === "uid-b"))
  check("enrolled paths are OpenFork vault paths", afterSwitch.every((account) => account.authPath.includes("vault")))
} finally {
  globalThis.fetch = originalFetch
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
