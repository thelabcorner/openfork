/**
 * Offline integration test for the WorkBuddy proxy + governor.
 *
 * Spins a FAKE Tencent backend through the test-only transport injector + a
 * FAKE desktop credential (.info file) so we can prove end-to-end proxy behavior
 * WITHOUT burning the live entitlement. Proves the issue #1 fix at the proxy layer:
 * one logical request => exactly one upstream generation even when the local
 * token was stale.
 *
 * Run: bun run script/workbuddy-proxy-test.ts
 */
import { createServer, type Server, type IncomingMessage } from "http"
import { writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { WorkBuddyPlugin, setTestAccountStore, setTestBackend } from "../packages/opencode/src/plugin/workbuddy"

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) passed++
  else failed++
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -> ${detail}` : ""}`)
}

// ---- fake backend ------------------------------------------------------------
type Scenario = "ok" | "first401" | "dead"
let scenario: Scenario = "ok"
let completions = 0
let refreshes = 0
let lastCompletionBody: any = null

function readReq(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on("data", (c) => chunks.push(c as Buffer))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
  })
}

const backend: Server = createServer(async (req, res) => {
  const body = await readReq(req)
  const url = req.url ?? ""
  if (url.includes("/v2/plugin/auth/token/refresh")) {
    refreshes++
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ data: { accessToken: "refreshed-token", expiresIn: 3600 } }))
    return
  }
  if (url.includes("/v2/chat/completions")) {
    completions++
    lastCompletionBody = JSON.parse(body)
    if (scenario === "dead") {
      res.writeHead(401, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ code: 12153, msg: "unauthorized" }))
      return
    }
    if (scenario === "first401" && completions === 1) {
      res.writeHead(401, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ code: 12153, msg: "unauthorized" }))
      return
    }
    const sse =
      'data: {"id":"x","model":"hy4-preview","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"I am thinking."}}]}\n\n' +
      'data: {"id":"x","model":"hy4-preview","choices":[{"index":0,"delta":{"content":"HY4_OK","tool_calls":[]}}]}\n\n' +
      "data: [DONE]\n\n"
    res.writeHead(200, { "Content-Type": "text/event-stream" })
    res.end(sse)
    return
  }
  res.writeHead(404)
  res.end()
})

await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", () => resolve()))
const baddr = backend.address()
const backendPort = typeof baddr === "object" && baddr ? baddr.port : 0
// Test-only upstream injection (NOT a production relay surface).
setTestBackend(`http://127.0.0.1:${backendPort}`)

// ---- fake desktop credential (expired on purpose to exercise proactive refresh)
const infoPath = join(tmpdir(), `wb-test-${Date.now()}.info`)
writeFileSync(
  infoPath,
  JSON.stringify({
    auth: { accessToken: "stale-token", refreshToken: "rt", domain: "www.workbuddy.ai", expiresAt: Date.now() - 10_000 },
    account: { uid: "u1", enterpriseId: "e1", nickname: "TestUser" },
  }),
)
process.env.WORKBUDDY_AUTH_FILE = infoPath
setTestAccountStore(join(tmpdir(), `wb-proxy-vault-${Date.now()}`))

// ---- bring up the plugin proxy ----------------------------------------------
const hooks = await WorkBuddyPlugin({ client: {}, project: { id: "test" }, worktree: "/tmp", directory: "/tmp", experimental_workspace: { register() {} }, serverUrl: new URL("http://localhost:4096") } as any)
const provider: any = { id: "workbuddy", models: {} }
const models = await hooks.provider!.models!(provider, {})
const entry = models["hy4-preview"]
const baseURL: string = entry.api.url
const token: string = entry.headers.Authorization.replace("Bearer ", "")
const H = { "Content-Type": "application/json", Authorization: `Bearer ${token}` }
check("proxy exposes hy4-preview", Boolean(entry), entry?.id)
{
  const headerOutput = { headers: {} as Record<string, string> }
  await hooks["chat.headers"]?.({ sessionID: "hook-session", agent: "build", model: entry, provider: {}, message: { id: "hook-message" } }, headerOutput)
  check("chat.headers injects canonical session affinity", headerOutput.headers["x-opencode-session"] === "hook-session", JSON.stringify(headerOutput))
  check("chat.headers injects stable logical request id", headerOutput.headers["x-opencode-request"] === "hook-message", JSON.stringify(headerOutput))
}

// ---- /health observability --------------------------------------------------
{
  const health = await fetch(`http://${new URL(baseURL).host}/health`).then((r) => r.json())
  check("health reports signed-in", health.signed_in === true)
  check("health discovers one account", Array.isArray(health.accounts) && health.accounts.length === 1, JSON.stringify(health.accounts))
  check("health exposes enrolled auth_file (issue#7 observability)", typeof health.accounts?.[0]?.auth_file === "string" && health.accounts[0].auth_file.startsWith("workbuddy-"), health.accounts?.[0]?.auth_file)
  check("health exposes account metric amplification", typeof health.accounts?.[0]?.metrics?.amplification === "number", JSON.stringify(health.accounts?.[0]?.metrics))
}

// ---- issue#1: expired cred => exactly ONE upstream generation ----------------
{
  scenario = "ok"
  completions = 0
  refreshes = 0
  const res = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ model: "hy4-preview", messages: [{ role: "user", content: "hi" }], stream: true, max_tokens: 200 }),
  })
  const text = await res.text()
  check("issue#1: fake backend received exactly ONE /chat/completions", completions === 1, `completions=${completions}`)
  check("issue#1: proactive refresh fired ONCE", refreshes === 1, `refreshes=${refreshes}`)
  check("stream produced content", text.includes("HY4_OK"), text.slice(0, 80))
}

// ---- 401 recovery => exactly one retry ---------------------------------------
{
  scenario = "first401"
  completions = 0
  refreshes = 0
  // Recovery requires a NON-expired local token: the proactive pre-call refresh
  // must NOT have already fired, so the 401 triggers a single recovery refresh.
  writeFileSync(
    infoPath,
    JSON.stringify({
      auth: { accessToken: "valid-token", refreshToken: "rt", domain: "www.workbuddy.ai", expiresAt: Date.now() + 3_600_000 },
      account: { uid: "u1", enterpriseId: "e1", nickname: "TestUser" },
    }),
  )
  const res = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ model: "hy4-preview", messages: [{ role: "user", content: "hi" }], stream: true, max_tokens: 200 }),
  })
  const text = await res.text()
  check("401 recovery: fake backend received exactly TWO /chat/completions", completions === 2, `completions=${completions}`)
  check("401 recovery: still produced content", text.includes("HY4_OK"), text.slice(0, 80))
}

// ---- quirk normalization + system injection ----------------------------------
{
  scenario = "ok"
  completions = 0
  lastCompletionBody = null
  const res = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ model: "hy4-preview", messages: [{ role: "user", content: "hi" }], stream: true, max_tokens: 200 }),
  })
  const raw = await res.text()
  check("proxy injected a system message (code 11128 contract)", lastCompletionBody?.messages?.[0]?.role === "system", JSON.stringify(lastCompletionBody?.messages?.[0]))
  check("empty tool_calls arrays stripped before client", !raw.includes('"tool_calls":[]'), raw.slice(0, 240))
  check("reasoning_content passed through", raw.includes("reasoning_content"), raw.slice(0, 240))
  check("content passed through", raw.includes("HY4_OK"), raw.slice(0, 240))
}

// ---- dead token => clean 401 to client ---------------------------------------
{
  scenario = "dead"
  const res = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ model: "hy4-preview", messages: [{ role: "user", content: "hi" }], stream: false, max_tokens: 200 }),
  })
  const body = await res.json()
  check("dead token surfaces as auth error (not a hang)", res.status === 401 && body.error?.type === "authentication_error", `status=${res.status} type=${body.error?.type}`)
  const health = await fetch(`http://${new URL(baseURL).host}/health`).then((r) => r.json())
  check("terminal auth error releases account lease", health.accounts?.[0]?.metrics?.active === 0, JSON.stringify(health.accounts?.[0]?.metrics))
}

// ---- session header fallback and affinity observability -----------------------
{
  const headersA = { ...H, "x-session-affinity": "session-alpha" }
  const headersB = { ...H, "X-Session-Id": "session-beta" }
  for (const headers of [headersA, headersB]) {
    const r = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "hy4-preview", messages: [{ role: "user", content: "affinity" }], stream: false, max_tokens: 32 }),
    })
    await r.text()
  }
  const health = await fetch(`http://${new URL(baseURL).host}/health`).then((r) => r.json())
  check("session-affinity fallback headers create distinct bindings", health.bindings?.some((b: any) => b.session === "session-alpha") && health.bindings?.some((b: any) => b.session === "session-beta"), JSON.stringify(health.bindings))
}

// ---- live-catalog overlay: /v1/models reflects discovered ids ---------------
{
  const list = await fetch(`${baseURL}/models`, { headers: H }).then((r) => r.json())
  check("/v1/models returns a non-empty catalog", list.data?.length > 0, `${list.data?.length} models`)
  check("catalog lists hy4-preview", list.data?.some((m: any) => m.id === "hy4-preview"), list.data?.map((m: any) => m.id).join(","))
}

await hooks.dispose?.()
backend.close()
check("proxy disposed cleanly", true)
console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
