// Realm diagnostic: determine which backend host + X-Domain the local credential
// actually authorizes, and whether the token is directly usable or needs exchange.
//
// SECURITY: credential read at runtime, never printed or persisted.

import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const USER_AGENT_REF = "codebuddy2openai/2.0"
const UA_BROWSER =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"

function loadCredential() {
  const dir = join(process.env.LOCALAPPDATA || "", "CodeBuddyExtension", "Data", "Public", "auth")
  const file = readdirSync(dir).find((f) => /\.info$/i.test(f))
  const p = JSON.parse(readFileSync(join(dir, file), "utf8"))
  return { auth: p.auth || {}, account: p.account || {}, file }
}

const redact = (s) => String(s).replace(/[A-Za-z0-9_\-]{26,}/g, "<REDACTED>")
const clip = (s, n = 150) => redact(String(s ?? "").replace(/\s+/g, " ").slice(0, n))

async function call(url, { method = "POST", headers = {}, body } = {}) {
  const t0 = Date.now()
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    })
    const text = await res.text()
    return { status: res.status, ms: Date.now() - t0, text }
  } catch (e) {
    return { status: "ERR", ms: Date.now() - t0, text: `${e.name}: ${e.message}` }
  }
}

const cred = loadCredential()
const { auth, account, file } = cred
const CRED_DOMAIN = auth.domain || "www.codebuddy.cn"

console.log(`credential file : ${file}`)
console.log(`account         : ${account.nickname} / ${account.uid} (${account.type})`)
console.log(`X-Domain (own)  : ${CRED_DOMAIN}`)
console.log(`token type      : ${auth.tokenType}`)
console.log(`scope           : ${auth.scope}`)
console.log(`expiresAt       : ${new Date(auth.expiresAt).toISOString()}`)
console.log(`lastRefresh     : ${new Date(auth.lastRefreshTime).toISOString()}\n`)

const baseHeaders = (domain, ua) => ({
  Authorization: `Bearer ${auth.accessToken}`,
  "X-User-Id": account.uid || "",
  "X-Enterprise-Id": account.enterpriseId || "",
  "X-Tenant-Id": account.enterpriseId || "",
  "X-Domain": domain,
  "User-Agent": ua,
})

const chatBody = (model) => ({
  model,
  messages: [{ role: "user", content: "Reply with exactly: OK" }],
  stream: true,
  stream_options: { include_usage: true },
  max_tokens: 16,
})

console.log("=".repeat(100))
console.log("A. WHICH BACKEND HOST DOES THIS CREDENTIAL AUTHORIZE?")
console.log("=".repeat(100))
const hosts = [
  "https://copilot.tencent.com",
  "https://www.workbuddy.ai",
  "https://www.workbuddy.cn",
  "https://api.workbuddy.ai",
]
const rows = []
for (const host of hosts) {
  for (const domain of [CRED_DOMAIN, "www.codebuddy.cn"]) {
    const r = await call(`${host}/v2/chat/completions`, {
      headers: baseHeaders(domain, USER_AGENT_REF),
      body: chatBody("hy3-preview-agent"),
    })
    rows.push({ host, domain, ...r })
    console.log(`${String(r.status).padEnd(5)} ${String(r.ms).padStart(5)}ms  ${host.padEnd(30)} X-Domain=${domain.padEnd(20)} ${clip(r.text, 70)}`)
  }
}

console.log(`\n${"=".repeat(100)}`)
console.log("B. DOES THE USER-AGENT MATTER? (copilot.tencent.com, own realm)")
console.log("=".repeat(100))
for (const ua of [USER_AGENT_REF, UA_BROWSER]) {
  const r = await call("https://copilot.tencent.com/v2/chat/completions", {
    headers: baseHeaders(CRED_DOMAIN, ua),
    body: chatBody("hy3-preview-agent"),
  })
  console.log(`${String(r.status).padEnd(5)} ${String(r.ms).padStart(5)}ms  UA=${ua.slice(0, 34).padEnd(36)} ${clip(r.text, 70)}`)
}

console.log(`\n${"=".repeat(100)}`)
console.log("C. CAN THE TOKEN BE REFRESHED / EXCHANGED? (proves token is live for this backend)")
console.log("=".repeat(100))
for (const host of ["https://copilot.tencent.com", "https://www.workbuddy.ai"]) {
  const r = await call(`${host}/v2/plugin/auth/token/refresh`, {
    headers: {
      ...baseHeaders(CRED_DOMAIN, USER_AGENT_REF),
      "X-Refresh-Token": auth.refreshToken,
      "X-Auth-Refresh-Source": "plugin",
    },
    body: {},
  })
  console.log(`${String(r.status).padEnd(5)} ${String(r.ms).padStart(5)}ms  ${host.padEnd(30)} ${clip(r.text, 120)}`)
}

console.log(`\n${"=".repeat(100)}`)
console.log("D. IS THERE A TOKEN-EXCHANGE / USERINFO ENDPOINT?")
console.log("=".repeat(100))
for (const p of ["/v2/user/info", "/v2/userinfo", "/v2/plugin/auth/token/exchange", "/v2/config", "/v2/models"]) {
  const r = await call(`https://www.workbuddy.ai${p}`, { method: "GET", headers: baseHeaders(CRED_DOMAIN, USER_AGENT_REF) })
  console.log(`${String(r.status).padEnd(5)} ${String(r.ms).padStart(5)}ms  GET www.workbuddy.ai${p.padEnd(34)} ${clip(r.text, 70)}`)
}
