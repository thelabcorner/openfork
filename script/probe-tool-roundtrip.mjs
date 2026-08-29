// Isolate the tool-result round trip: which upstream message shape does the
// Global backend accept for assistant-tool_calls + tool result?
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const BACKEND = "https://www.workbuddy.ai"
const UA = "codebuddy2openai/2.0"
const redact = (s) => String(s).replace(/[A-Za-z0-9_\-]{26,}/g, "<REDACTED>")

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
  "User-Agent": UA,
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_test_value",
      description: "Return a known test value",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
]

async function run(label, messages, { timeout = 90000 } = {}) {
  const body = { model: "hy4-preview", messages, tools: TOOLS, stream: true, stream_options: { include_usage: true }, max_tokens: 400 }
  const t0 = Date.now()
  try {
    const res = await fetch(`${BACKEND}/v2/chat/completions`, {
      method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
    })
    const raw = await res.text()
    const frames = raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim())
      .filter((d) => d && d !== "[DONE]").map((d) => { try { return JSON.parse(d) } catch { return null } }).filter(Boolean)
    let content = "", finish = null, reasoning = ""
    const calls = new Map()
    for (const f of frames) for (const c of f.choices || []) {
      if (c.finish_reason) finish = c.finish_reason
      const d = c.delta || {}
      if (d.content) content += d.content
      if (d.reasoning_content) reasoning += d.reasoning_content
      for (const tc of d.tool_calls || []) {
        const i = tc.index ?? 0
        const s = calls.get(i) || { id: null, name: null, args: "" }
        if (tc.id) s.id = tc.id
        if (tc.function?.name) s.name = tc.function.name
        if (tc.function?.arguments) s.args += tc.function.arguments
        calls.set(i, s)
      }
    }
    console.log(`\n[${(Date.now() - t0) / 1000}s] ${label}`)
    console.log(`  status=${res.status} frames=${frames.length} finish=${finish}`)
    if (reasoning) console.log(`  reasoning=${JSON.stringify(redact(reasoning.slice(0, 120)))}`)
    if (content) console.log(`  content  =${JSON.stringify(redact(content.slice(0, 160)))}`)
    for (const [i, c] of calls) console.log(`  call[${i}] name=${c.name} args=${c.args}`)
    if (res.status !== 200) console.log(`  RAW: ${redact(raw.replace(/\s+/g, " ").slice(0, 300))}`)
    return { calls: [...calls.values()], content, ok: res.status === 200 }
  } catch (e) {
    console.log(`\n[${(Date.now() - t0) / 1000}s] ${label}\n  ERROR: ${e.name}: ${e.message}`)
    return { ok: false, calls: [] }
  }
}

const SYS = { role: "system", content: "You are a helpful assistant. Use tools when needed." }
const USER = { role: "user", content: "Call get_test_value to retrieve the test value." }

// Step 1: get a real tool call id
const a = await run("STEP 1: issue tool call", [SYS, USER])
if (!a.calls.length) { console.log("\nno tool call -> abort"); process.exit(1) }
const callId = a.calls[0].id
const callName = a.calls[0].name
console.log(`\n>>> captured id=${String(callId).slice(0, 16)}… name=${callName}`)

// Step 2 variants for the continuation turn
const variants = [
  ["assistant content:null + tool role", [
    SYS, USER,
    { role: "assistant", content: null, tool_calls: [{ id: callId, type: "function", function: { name: callName, arguments: "{}" } }] },
    { role: "tool", tool_call_id: callId, content: JSON.stringify({ value: "ALPHA-7" }) },
  ]],
  ["assistant content:'' + tool role", [
    SYS, USER,
    { role: "assistant", content: "", tool_calls: [{ id: callId, type: "function", function: { name: callName, arguments: "{}" } }] },
    { role: "tool", tool_call_id: callId, content: JSON.stringify({ value: "ALPHA-7" }) },
  ]],
  ["assistant content:text + tool role", [
    SYS, USER,
    { role: "assistant", content: "I'll call the tool to retrieve the test value.", tool_calls: [{ id: callId, type: "function", function: { name: callName, arguments: "{}" } }] },
    { role: "tool", tool_call_id: callId, content: JSON.stringify({ value: "ALPHA-7" }) },
  ]],
  ["user-relayed result (no tool role)", [
    SYS, USER,
    { role: "assistant", content: "I'll call the tool to retrieve the test value." },
    { role: "user", content: `Tool ${callName} returned: ${JSON.stringify({ value: "ALPHA-7" })}. Report the value.` },
  ]],
]

for (const [label, msgs] of variants) {
  const r = await run(`STEP 2 [${label}]`, msgs)
  if (r.ok) { console.log(`  => VARIANT WORKS: ${label}`); break }
}
