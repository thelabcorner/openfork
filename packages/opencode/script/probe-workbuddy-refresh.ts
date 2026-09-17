// Live verification of the WorkBuddy automatic re-auth path.
//
// This exercises the REAL Tencent refresh endpoint with a REAL vault account,
// through the plugin's production `reauthenticateAccount` entry point. The
// merged parameter set and the no-Authorization header shape are taken from
// the official client (resources/app.asar -> cli/dist/codebuddy.js,
// AccountScopedExternalLinkAuthenticationProvider.refreshSession).
//
// SECURITY: reads the OpenFork vault at runtime and prints ONLY status and
// metadata (never token material). A successful refresh rotates the token pair
// in the OpenFork vault exactly like normal production operation; if the
// backend rejects the refresh token, the "rejected" verdict is reported and
// nothing is mutated.
//
// Usage:
//   bun script/probe-workbuddy-refresh.ts <uid-prefix>
//
// An explicit account is required: a successful refresh rotates that
// account's token pair in the vault, so a stray invocation must not pick one
// by itself.

import { AccountRegistry } from "../src/plugin/workbuddy-accounts"
import { reauthenticateAccount, validateAccountAuth } from "../src/plugin/workbuddy"

const registry = new AccountRegistry()
const accounts = registry.all().filter((account) => account.credential.refreshToken)

const prefix = process.argv[2]
if (!prefix) {
  console.error("usage: bun script/probe-workbuddy-refresh.ts <uid-prefix>")
  console.error("refusing to run without an explicit account: a successful refresh rotates that account's tokens")
  process.exit(1)
}
const account = accounts.find((candidate) => candidate.uid.startsWith(prefix) || candidate.id.includes(prefix))

if (!account) {
  console.error(`no vault account matching "${prefix}" with a refresh token`)
  process.exit(1)
}

const beforeAccess = account.credential.accessToken
const beforeRefresh = account.credential.refreshToken

console.log(`account    : ${account.nickname || account.uid} (${account.id.slice(0, 18)}…)`)
console.log(`domain     : ${account.credential.domain}`)
console.log(`expiresAt  : ${account.credential.expiresAt ? new Date(account.credential.expiresAt).toISOString() : "unknown"}`)
console.log(`governor   : ${account.governor.metrics().state}`)
console.log("")

const outcome = await reauthenticateAccount(account)
console.log(`refresh    : ${outcome}`)
console.log(`rotated    : access=${account.credential.accessToken !== beforeAccess} refresh=${account.credential.refreshToken !== beforeRefresh}`)
console.log(`expiresAt  : ${account.credential.expiresAt ? new Date(account.credential.expiresAt).toISOString() : "unknown"}`)

const verdict = await validateAccountAuth(account)
console.log(`validate   : ${verdict}`)
console.log(`governor   : ${account.governor.metrics().state}`)
console.log(`lastAuth   : ${JSON.stringify(account.governor.metrics().lastAuthFailure)}`)
