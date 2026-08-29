/**
 * Offline multi-account registry/router tests.
 *
 * Run: bun run script/workbuddy-accounts-test.ts
 */
import { mkdirSync, writeFileSync, utimesSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { AccountRegistry, AccountRouter, AccountVault, stableAccountIdentity } from "../packages/opencode/src/plugin/workbuddy-accounts"

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) passed++
  else failed++
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -> ${detail}` : ""}`)
}

function info(path: string, uid: string, nickname: string, token: string, domain = "www.workbuddy.ai") {
  writeFileSync(path, JSON.stringify({ auth: { accessToken: token, refreshToken: `rt-${uid}`, domain, expiresAt: Date.now() + 3600000 }, account: { uid, enterpriseId: `ent-${uid}`, nickname } }))
}

const root = join(tmpdir(), `wb-accounts-${Date.now()}`)
mkdirSync(root, { recursive: true })
const a1 = join(root, "a.info")
const a1dup = join(root, "a-rotated.info")
const b = join(root, "b.info")
info(a1, "uid-a", "Account A", "token-a")
info(a1dup, "uid-a", "Account A", "token-a-new")
info(b, "uid-b", "Account B", "token-b")
// Ensure the rotated duplicate wins deterministic newest-file selection.
const now = new Date()
utimesSync(a1, new Date(now.getTime() - 10000), new Date(now.getTime() - 10000))
utimesSync(a1dup, now, now)

const registry = new AccountRegistry({ authFiles: [a1, a1dup, b], persistenceDir: join(root, "state"), vault: new AccountVault(join(root, "vault")) })
const accounts = registry.all()
check("discovers two authenticated accounts", accounts.length === 2, accounts.map((a) => a.uid).join(","))
check("stable account identity prefers UID", accounts.every((a) => a.id.startsWith("wb-")), accounts.map((a) => a.id).join(","))
check("duplicate credential files deduplicate by UID", accounts.filter((a) => a.uid === "uid-a").length === 1)
check("newest duplicate credential is selected", accounts.find((a) => a.uid === "uid-a")?.credential.accessToken === "token-a-new")
check("stable identity is independent of filename", stableAccountIdentity(accounts.find((a) => a.uid === "uid-a")!.credential) === accounts.find((a) => a.uid === "uid-a")!.id)
const renamed = { ...accounts.find((a) => a.uid === "uid-a")!.credential, nickname: "Renamed Account A", path: "different.info" }
check("stable identity survives Tencent nickname changes", stableAccountIdentity(renamed) === accounts.find((a) => a.uid === "uid-a")!.id)

const collisionVault = new AccountVault(join(root, "collision-vault"))
collisionVault.save({ path: "", accessToken: "global", refreshToken: "rg", domain: "www.workbuddy.ai", uid: "same-uid", enterpriseId: "global-ent", expiresAt: 0, nickname: "Same User" })
collisionVault.save({ path: "", accessToken: "cn", refreshToken: "rc", domain: "www.codebuddy.cn", uid: "same-uid", enterpriseId: "cn-ent", expiresAt: 0, nickname: "Same User" })
const collisionFiles = collisionVault.list()
check("Global and CN same-UID accounts use distinct vault records", collisionFiles.length === 2 && new Set(collisionFiles.map((item) => item.path)).size === 2, collisionFiles.map((item) => item.path).join(","))

const router = new AccountRouter({ registry })
const a = accounts.find((item) => item.uid === "uid-a")!
const bAccount = accounts.find((item) => item.uid === "uid-b")!
const first = router.select("session-alpha", "hy4-preview", a.id)
check("explicit account selection binds session", first?.account.id === a.id && first.reason === "explicit")
// An explicit account choice always rebinds, even on an already-bound session.
// Affinity only blocks *automatic* hopping; it must not make an account-qualified
// model id a no-op, or picking account B would keep serving A (and A's limits).
const same = router.select("session-alpha", "hy4-preview", bAccount.id)
check("explicit account selection rebinds a bound session", same?.account.id === bAccount.id && same.reason === "explicit")
const rebound = router.select("session-alpha", "hy4-preview")
check("affinity then holds the rebound account", rebound?.account.id === bAccount.id && rebound.reason === "affinity")
const second = router.select("session-beta", "hy4-preview", bAccount.id)
check("two sessions can intentionally use different accounts", second?.account.id === bAccount.id)
const auto = router.select("session-gamma", "hy4-preview")
check("automatic selection binds a new session", Boolean(auto?.account))
check("bindings are session-scoped", router.bindingsSnapshot().length === 3)

// Independent governors: a state fact on A must not contaminate B.
const aLimitResult = await a.governor.runGeneration({
  priority: 2, genKey: "a-limit", session: "session-alpha", currentToken: a.credential.accessToken,
  isExpired: () => false, refresh: async () => false,
  transport: async () => new Response(JSON.stringify({ msg: "usage exceeds frequency limit; reset at 2099-01-01 00:00:00 UTC+8" }), { status: 429 }),
})
check("Account A learns WINDOW_LIMITED", a.governor.metrics().state === "WINDOW_LIMITED", a.governor.metrics().state)
aLimitResult.lease.release()
check("Account B remains READY", bAccount.governor.metrics().state === "READY", bAccount.governor.metrics().state)
const afterLimit = router.select("session-delta", "hy4-preview")
check("automatic assignment prefers READY B over WINDOW_LIMITED A", afterLimit?.account.id === bAccount.id, afterLimit?.account.id)
const credentialRef = a.credential
a.credential.accessToken = "in-memory-refreshed-a"
const rescannedA = registry.get(a.id)!
check("registry scan preserves long-lived credential object identity", rescannedA.credential === credentialRef)
check("registry scan does not overwrite an in-memory refresh", rescannedA.credential.accessToken === "in-memory-refreshed-a")

let bCalls = 0
const bResult = await bAccount.governor.runGeneration({
  priority: 2, genKey: "b-ok", session: "session-beta", currentToken: bAccount.credential.accessToken,
  isExpired: () => false, refresh: async () => false,
  transport: async () => { bCalls++; return new Response("ok", { status: 200 }) },
})
check("Account B can generate while A is window-limited", bResult.committed && bCalls === 1)
bResult.lease.release()

// Simulate official desktop account switching: only B remains in the current
// .info location. The OpenFork vault must still retain A and B.
const switchedRegistry = new AccountRegistry({ authFiles: [b], persistenceDir: join(root, "state-2"), vault: registry.vault })
const afterDesktopSwitch = switchedRegistry.all()
check("vault retains Account A after desktop switches to B", afterDesktopSwitch.some((account) => account.uid === "uid-a"))
check("vault retains Account B after desktop switches to B", afterDesktopSwitch.some((account) => account.uid === "uid-b"))
check("vault records are independent from desktop .info paths", afterDesktopSwitch.every((account) => account.authPath.includes(`${join(root, "vault")}`)))

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
