/**
 * End-to-end check of the WorkBuddy provider plugin's loopback proxy.
 *
 * Exercises: health, model catalog, streaming (incl. quirk normalization),
 * non-streaming folding, tool calls, and tool-result continuation.
 *
 * Run: bun run script/workbuddy-smoke.ts
 */
import { WorkBuddyPlugin } from "../packages/opencode/src/plugin/workbuddy"

const input: any = {
  client: {},
  project: { id: "test" },
  worktree: "/tmp",
  directory: "/tmp",
  experimental_workspace: { register() {} },
  serverUrl: new URL("http://localhost:4096"),
}

const pass: string[] = []
const fail: string[] = []
function check(name: string, ok: boolean, detail = "") {
  ;(ok ? pass : fail).push(name)
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -> ${detail}` : ""}`)
}

const hooks = await WorkBuddyPlugin(input)
check("plugin loads and exposes a provider hook", hooks.provider?.id === "workbuddy")

// The provider hook requires a provider object to merge into.
const provider: any = { id: "workbuddy", models: {} }
const models = await hooks.provider!.models!(provider, {})
const ids = Object.keys(models)
check("model catalog exposes hy4-preview", ids.includes("hy4-preview"), ids.join(", "))

const entry = models["hy4-preview"]
const baseURL: string = entry.api.url
const token: string = entry.headers.Authorization.replace("Bearer ", "")
check("api url is loopback", /^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(baseURL), baseURL)
check("model npm is openai-compatible", entry.api.npm === "@ai-sdk/openai-compatible")

const H = { "Content-Type": "application/json", Authorization: `Bearer ${token}` }

// --- health -------------------------------------------------------------------
const health = await fetch(`http://${new URL(baseURL).host}/health`).then((r) => r.json())
check("health reports signed-in session", health.signed_in === true, JSON.stringify(health))

// --- models -------------------------------------------------------------------
const list = await fetch(`${baseURL}/models`, { headers: H }).then((r) => r.json())
check("/v1/models returns a catalog", list.data?.length > 0, `${list.data?.length} models`)

// --- authn on the proxy -------------------------------------------------------
const bad = await fetch(`${baseURL}/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer wrong" },
  body: JSON.stringify({ model: "hy4-preview", messages: [{ role: "user", content: "hi" }] }),
})
check("proxy rejects a bad local token", bad.status === 401, `status ${bad.status}`)

// --- streaming ----------------------------------------------------------------
const t0 = Date.now()
const streamRes = await fetch(`${baseURL}/chat/completions`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({
    model: "hy4-preview",
    messages: [{ role: "user", content: "Reply with exactly: HY4_OK" }],
    stream: true,
    max_tokens: 200,
  }),
})
const raw = await streamRes.text()
check("streaming returns 200", streamRes.status === 200, `status ${streamRes.status} in ${Date.now() - t0}ms`)

const frames = raw
  .split("\n")
  .filter((l) => l.startsWith("data:") && l.trim() !== "data: [DONE]")
  .map((l) => JSON.parse(l.slice(5).trim()))
let content = ""
let reasoning = ""
let emptyToolCalls = 0
let realToolCalls = 0
for (const f of frames) {
  for (const c of f.choices ?? []) {
    const d = c.delta ?? {}
    if (d.content) content += d.content
    if (d.reasoning_content) reasoning += d.reasoning_content
    if (Array.isArray(d.tool_calls)) d.tool_calls.length === 0 ? emptyToolCalls++ : realToolCalls++
  }
}
check("stream produces content", content.length > 0, JSON.stringify(content.trim()))
check("stream carries reasoning_content", reasoning.length > 0, JSON.stringify(reasoning.slice(0, 60)))
check("empty tool_calls arrays are stripped", emptyToolCalls === 0, `empty=${emptyToolCalls} real=${realToolCalls}`)

// --- non-streaming (backend rejects it; proxy must fold) ----------------------
const nonStream = await fetch(`${baseURL}/chat/completions`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({
    model: "hy4-preview",
    messages: [{ role: "user", content: "Reply with exactly: FOLDED" }],
    stream: false,
    max_tokens: 200,
  }),
}).then((r) => r.json())
check("non-streaming is folded into one completion", nonStream.object === "chat.completion", JSON.stringify(nonStream).slice(0, 160))
check("folded completion has content", (nonStream.choices?.[0]?.message?.content ?? "").length > 0, JSON.stringify(nonStream.choices?.[0]?.message?.content))

// --- system-first requirement -------------------------------------------------
const noSystem = await fetch(`${baseURL}/chat/completions`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({
    model: "hy4-preview",
    messages: [{ role: "user", content: "Reply with exactly: NOSYS" }],
    stream: false,
    max_tokens: 200,
  }),
}).then((r) => r.json())
check("proxy injects the required system message", (noSystem.choices?.[0]?.message?.content ?? "").length > 0, JSON.stringify(noSystem.choices?.[0]?.message?.content).slice(0, 80))

// --- tool calling -------------------------------------------------------------
const tools = [
  {
    type: "function",
    function: {
      name: "get_test_value",
      description: "Return a known test value",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
]
const toolTurn = await fetch(`${baseURL}/chat/completions`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({
    model: "hy4-preview",
    messages: [{ role: "user", content: "Call get_test_value now." }],
    tools,
    stream: false,
    max_tokens: 400,
  }),
}).then((r) => r.json())

const calls = toolTurn.choices?.[0]?.message?.tool_calls ?? []
check("model emits a tool call", calls.length > 0, JSON.stringify(calls).slice(0, 200))
check("tool call args are valid JSON", calls.length > 0 && (() => { try { JSON.parse(calls[0].function.arguments); return true } catch { return false } })())

// --- tool result continuation -------------------------------------------------
if (calls.length > 0) {
  const continuation = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      model: "hy4-preview",
      messages: [
        { role: "user", content: "Call get_test_value now." },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: calls[0].id, type: "function", function: { name: calls[0].function.name, arguments: calls[0].function.arguments } }],
        },
        { role: "tool", tool_call_id: calls[0].id, content: JSON.stringify({ value: "ALPHA-7" }) },
      ],
      tools,
      stream: false,
      max_tokens: 300,
    }),
  }).then((r) => r.json())
  const text = continuation.choices?.[0]?.message?.content ?? ""
  check("model consumes tool result and continues", text.includes("ALPHA-7"), JSON.stringify(text).slice(0, 160))
}

// --- unknown model maps to a clear error --------------------------------------
const unknown = await fetch(`${baseURL}/chat/completions`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({ model: "definitely-not-a-model", messages: [{ role: "user", content: "hi" }], stream: false }),
})
const unknownBody = await unknown.json()
check("unknown model yields a typed error", unknown.status === 404 || unknown.status === 400, `status ${unknown.status} ${JSON.stringify(unknownBody.error?.type)}`)

await hooks.dispose?.()
console.log(`\n${pass.length} passed, ${fail.length} failed`)
if (fail.length) {
  console.log("failed: " + fail.join(", "))
  process.exit(1)
}
