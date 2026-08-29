// Probe raw backend behaviour for the remaining protocol questions.
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const BACKEND = process.argv[2] || "https://www.workbuddy.ai"
const MODEL = process.argv[3] || "hy4-preview"

function loadCredential() {
  const dir = join(process.env.LOCALAPPDATA || "", "CodeBuddyExtension", "Data", "Public", "auth")
  const f = readdirSync(dir).find((x) => /\.info$/i.test(x))
  const p = JSON.parse(readFileSync(join(dir, f), "utf8"))
  return { auth: p.auth || {}, account: p.account || {} }
}
const cred = loadCredential()
const headers = {
  "Content-Type": "application/json",
  Accept: "application/json",
  Authorization: `Bearer ${cred.auth.accessToken}`,
  "X-User-Id": cred.account.uid || "",
  "X-Enterprise-Id": cred.account.enterpriseId || "",
  "X-Tenant-Id": cred.account.enterpriseId || "",
  "X-Domain": cred.auth.domain || "www.workbuddy.ai",
  "User-Agent": "codebuddy2openai/2.0",
}
const redact = (s) => String(s).replace(/[A-Za-z0-9_\-]{26,}/g, "<REDACTED>")

async function post(label, body) {
  const t0 = Date.now()
  try {
    const res = await fetch(`${BACKEND}/v2/chat/completions`, {
      method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
    })
    const raw = await res.text()
    console.log(`\n[${(Date.now() - t0) / 1000}s] ${label}\n  status=${res.status}`)
    console.log(`  ${redact(raw.replace(/\s+/g, " ").slice(0, 500))}`)
    return { status: res.status, raw }
  } catch (e) {
    console.log(`\n[${(Date.now() - t0) / 1000}s] ${label}\n  ERROR ${e.name}: ${e.message}`)
    return { status: 0, raw: "" }
  }
}

const SYS = { role: "system", content: "You are a helpful assistant." }

// 1. Does the backend accept NON-streaming?
await post("NON-STREAM (stream:false)", {
  model: MODEL, messages: [SYS, { role: "user", content: "Reply with exactly: OK" }],
  stream: false, max_tokens: 50,
})

// 2. Does it accept max_completion_tokens (OpenCode/AI-SDK often sends this)?
await post("STREAM + max_completion_tokens", {
  model: MODEL, messages: [SYS, { role: "user", content: "Reply with exactly: OK" }],
  stream: true, stream_options: { include_usage: true }, max_completion_tokens: 50,
})

// 3. tool_choice: required on a real tool
await post("STREAM + tool_choice required", {
  model: MODEL, messages: [SYS, { role: "user", content: "Get the test value." }],
  tools: [{ type: "function", function: { name: "get_test_value", description: "Return a known test value", parameters: { type: "object", properties: {} } } }],
  tool_choice: "required", stream: true, max_tokens: 200,
})

// 4. Parallel tool calls: does it emit >1 tool_call in a single turn?
const r = await post("STREAM + 2 tools requested in parallel", {
  model: MODEL,
  messages: [SYS, { role: "user", content: "In ONE response, call BOTH ping_alpha and ping_beta at the same time." }],
  tools: [
    { type: "function", function: { name: "ping_alpha", description: "ping alpha", parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "ping_beta", description: "ping beta", parameters: { type: "object", properties: {} } } },
  ],
  stream: true, max_tokens: 300,
})
// count distinct tool call ids
const ids = new Set()
for (const m of r.raw.matchAll(/"id":"(chatcmpl-tool-[^"]+)"/g)) ids.add(m[1])
const names = new Set()
for (const m of r.raw.matchAll(/"name":"(ping_[a-z]+)"/g)) names.add(m[1])
console.log(`  distinct tool ids=${ids.size} names=${[...names].join(",") || "-"}`)
