// Live protocol probe against the Tencent WorkBuddy / CodeBuddy backend.
//
// Uses the community-proven request shape (codebuddy2openai / workbuddy2api):
//   POST https://copilot.tencent.com/v2/chat/completions     (stream forced on)
//   POST https://copilot.tencent.com/v2/plugin/auth/token/refresh
//
// SECURITY: the desktop credential is read at runtime and never printed or persisted.
//
// Usage:
//   node script/probe-workbuddy-api.mjs models          # probe candidate model ids
//   node script/probe-workbuddy-api.mjs stream <model>  # dump a sanitized SSE transcript

import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

// Global realm backend. NOTE: copilot.tencent.com is the CN CodeBuddy realm and
// rejects WorkBuddy Global credentials with 401. Verified experimentally.
const BACKEND = "https://www.workbuddy.ai"
const USER_AGENT = "codebuddy2openai/2.0"
const TIMEOUT_MS = 45000

function loadCredential() {
  const dir = join(process.env.LOCALAPPDATA || "", "CodeBuddyExtension", "Data", "Public", "auth")
  const file = readdirSync(dir).find((f) => /\.info$/i.test(f))
  const parsed = JSON.parse(readFileSync(join(dir, file), "utf8"))
  return { auth: parsed.auth || {}, account: parsed.account || {} }
}

// Header construction mirrors the proven reference implementation exactly.
function buildHeaders({ auth, account }, domain) {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${auth.accessToken}`,
    "X-User-Id": account.uid || "",
    "X-Enterprise-Id": account.enterpriseId || "",
    "X-Tenant-Id": account.enterpriseId || "",
    "X-Domain": domain,
    "User-Agent": USER_AGENT,
  }
}

const redact = (s) => String(s).replace(/[A-Za-z0-9_\-]{28,}/g, "<REDACTED>")

/** Run one streaming completion; return status + parsed deltas. */
async function streamChat({ model, domain, prompt = "Reply with exactly: OK", maxTokens = 24 }) {
  const cred = loadCredential()
  const body = {
    model,
    // Backend contract (code 11128): the FIRST message must be a system prompt.
    messages: [
      { role: "system", content: "You are a helpful assistant. Be concise." },
      { role: "user", content: prompt },
    ],
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: maxTokens,
  }
  const started = Date.now()
  let res
  try {
    res = await fetch(`${BACKEND}/v2/chat/completions`, {
      method: "POST",
      headers: buildHeaders(cred, domain),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    return { status: "ERR", ms: Date.now() - started, error: e.message, raw: "" }
  }
  const raw = await res.text()
  // Parse SSE payloads
  const frames = []
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue
    const d = line.slice(5).trim()
    if (!d || d === "[DONE]") continue
    try { frames.push(JSON.parse(d)) } catch {}
  }
  const ttft = Date.now() - started
  let content = "", reasoning = "", finish = null, respModel = null, usage = null
  const deltaKeys = new Set()
  let emptyToolCalls = 0, realToolCalls = 0
  for (const f of frames) {
    if (f.model) respModel = f.model
    if (f.usage) usage = f.usage
    for (const c of f.choices || []) {
      if (c.finish_reason) finish = c.finish_reason
      const d = c.delta || {}
      for (const k of Object.keys(d)) deltaKeys.add(k)
      if (d.content) content += d.content
      if (d.reasoning_content) reasoning += d.reasoning_content
      if (Array.isArray(d.tool_calls)) {
        if (d.tool_calls.length === 0) emptyToolCalls++
        else realToolCalls++
      }
    }
  }
  return {
    status: res.status, ms: ttft, respModel, finish, usage,
    content: content.trim(), reasoning: reasoning.trim(),
    deltaKeys: [...deltaKeys], emptyToolCalls, realToolCalls,
    frames: frames.length, raw,
  }
}

const cred = loadCredential()
const CRED_DOMAIN = cred.auth.domain || "www.codebuddy.cn"
console.log(`account : ${cred.account.nickname} / ${cred.account.uid}`)
console.log(`realm   : ${CRED_DOMAIN}  (credential's own X-Domain)`)
console.log(`backend : ${BACKEND}\n`)

const mode = process.argv[2] || "models"

if (mode === "models") {
  // hy3-preview-agent is a published, community-verified id -> proves headers are correct.
  const candidates = [
    "hy3-preview-agent", // CONTROL: known-good
    "hy4-preview",
    "hy4",
    "hy4-preview-agent",
    "auto",
  ]
  for (const domain of [CRED_DOMAIN, "www.codebuddy.cn"]) {
    console.log(`\n${"=".repeat(74)}\nX-Domain = ${domain}\n${"=".repeat(74)}`)
    console.log("model                 status   ms    resp-model            finish      content")
    for (const m of candidates) {
      const r = await streamChat({ model: m, domain })
      const status = String(r.status).padEnd(8)
      const ms = String(r.ms).padEnd(6)
      const rm = String(r.respModel ?? "-").slice(0, 20).padEnd(21)
      const fin = String(r.finish ?? "-").padEnd(11)
      const snippet = redact((r.content || r.error || r.raw.slice(0, 90)).replace(/\s+/g, " ")).slice(0, 46)
      console.log(`${m.padEnd(21)} ${status} ${ms} ${rm} ${fin} ${snippet}`)
    }
  }
}

if (mode === "catalog") {
  // There is no upstream /v2/models endpoint (404). Enumerate by probing candidates.
  const candidates = [
    "hy4-preview", "hy4", "hy4-pro", "hy3-preview-agent", "hy3-preview",
    "glm-5.2", "glm-5.1", "glm-5v-turbo",
    "kimi-k2.7", "kimi-k2.6", "kimi-k2.5",
    "deepseek-v4-pro", "deepseek-v4-flash",
    "minimax-m3-pay", "minimax-m3",
    "auto",
  ]
  console.log("model                 status  verdict   resp-model")
  const good = []
  for (const m of candidates) {
    const r = await streamChat({ model: m, domain: CRED_DOMAIN, prompt: "Say OK", maxTokens: 8 })
    const ok = r.status === 200
    if (ok) good.push(r.respModel || m)
    const verdict = ok ? "AVAILABLE" : String(r.status)
    console.log(`${m.padEnd(21)} ${String(r.status).padEnd(7)} ${verdict.padEnd(9)} ${r.respModel ?? "-"}`)
  }
  console.log(`\nAVAILABLE on ${CRED_DOMAIN}: ${good.join(", ")}`)
}

if (mode === "tools") {
  const cred = loadCredential()
  const domain = CRED_DOMAIN
  const tools = [
    {
      type: "function",
      function: {
        name: "get_test_value",
        description: "Return a known test value",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    },
    {
      type: "function",
      function: {
        name: "read_lines",
        description: "Read n lines from a named file",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "file path" },
            n: { type: "integer", description: "line count" },
          },
          required: ["path", "n"],
        },
      },
    },
  ]
  const ask = async (messages, label) => {
    const body = {
      model: "hy4-preview",
      messages,
      tools,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 800,
    }
    const res = await fetch(`${BACKEND}/v2/chat/completions`, {
      method: "POST",
      headers: buildHeaders(cred, domain),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    })
    const raw = await res.text()
    const frames = raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim())
      .filter((d) => d && d !== "[DONE]").map((d) => { try { return JSON.parse(d) } catch { return null } }).filter(Boolean)
    // reassemble tool calls by index
    const calls = new Map()
    let content = "", reasoning = "", finish = null, usage = null, emptyTC = 0
    for (const f of frames) {
      if (f.usage) usage = f.usage
      for (const c of f.choices || []) {
        if (c.finish_reason) finish = c.finish_reason
        const d = c.delta || {}
        if (d.content) content += d.content
        if (d.reasoning_content) reasoning += d.reasoning_content
        if (Array.isArray(d.tool_calls)) {
          if (!d.tool_calls.length) { emptyTC++; continue }
          for (const tc of d.tool_calls) {
            const i = tc.index ?? 0
            const s = calls.get(i) || { id: null, name: null, args: "" }
            if (tc.id) s.id = tc.id
            if (tc.function?.name) s.name = tc.function.name
            if (tc.function?.arguments) s.args += tc.function.arguments
            calls.set(i, s)
          }
        }
      }
    }
    console.log(`\n--- ${label} ---`)
    console.log(`status=${res.status} frames=${frames.length} finish=${finish} emptyToolCallDeltas=${emptyTC}`)
    if (reasoning) console.log(`reasoning: ${JSON.stringify(redact(reasoning.slice(0, 200)))}`)
    if (content) console.log(`content  : ${JSON.stringify(redact(content.slice(0, 200)))}`)
    for (const [i, c] of calls) {
      console.log(`tool_call[${i}]: id=${String(c.id).slice(0, 12)}… name=${c.name} args=${c.args}`)
      try { console.log(`              parsed=${JSON.stringify(JSON.parse(c.args))}`) } catch { console.log("              args NOT valid JSON") }
    }
    if (usage) console.log(`usage    : prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} reasoning=${usage.completion_tokens_details?.reasoning_tokens} credit=${usage.credit}`)
    return { calls: [...calls.values()], finish, content }
  }

  // Test A: single tool call
  const r1 = await ask(
    [
      { role: "system", content: "You are a helpful assistant. Use tools when asked." },
      { role: "user", content: "Call get_test_value to retrieve the test value." },
    ],
    "TEST A: single tool call",
  )

  // Test B: feed a synthetic tool result back -> does it continue?
  if (r1.calls.length) {
    const first = r1.calls[0]
    const msgs = [
      { role: "system", content: "You are a helpful assistant. Use tools when asked." },
      { role: "user", content: "Call get_test_value to retrieve the test value." },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: first.id, type: "function", function: { name: first.name, arguments: first.args } }],
      },
      { role: "tool", tool_call_id: first.id, content: JSON.stringify({ value: "ALPHA-7" }) },
    ]
    await ask(msgs, "TEST B: tool result continuation")

    // Test C: two sequential tools -> tool A, result, then tool B
    const msgs2 = [
      ...msgs,
      { role: "user", content: "Now read 3 lines from /tmp/demo.txt using read_lines." },
    ]
    await ask(msgs2, "TEST C: second sequential tool")
  } else {
    console.log("\nNo tool call returned - skipping B/C")
  }
}

if (mode === "stream") {
  const model = process.argv[3] || "hy4-preview"
  const r = await streamChat({ model, domain: CRED_DOMAIN, prompt: "Reply with exactly: HY4_OK", maxTokens: 600 })
  console.log(`model=${model}  status=${r.status}  ms=${r.ms}  frames=${r.frames}`)
  console.log(`response.model : ${r.respModel}`)
  console.log(`finish_reason  : ${r.finish}`)
  console.log(`delta keys     : ${r.deltaKeys.join(", ")}`)
  console.log(`usage          : ${JSON.stringify(r.usage)}`)
  console.log(`content        : ${JSON.stringify(r.content)}`)
  console.log(`reasoning      : ${JSON.stringify(r.reasoning.slice(0, 300))}`)
  console.log(`empty tool_calls deltas : ${r.emptyToolCalls}`)
  console.log(`real  tool_calls deltas : ${r.realToolCalls}`)
  console.log(`\n--- raw SSE (first 3000 chars, redacted) ---`)
  console.log(redact(r.raw.slice(0, 3000)))
}
