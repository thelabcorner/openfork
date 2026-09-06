/**
 * Repro for "duplicate generations detected" on every session start.
 *
 * Real-world cause: the title-generation fiber and the main-turn streamText
 * are forked in parallel (prompt.ts:1425-1431, `yield* title(...).forkIn(scope)`),
 * and BOTH pass `user: firstInfo` — the first user message of the session.
 * Workbuddy's chat.headers plugin sets `x-opencode-request = input.message.id`
 * and the proxy builds `genKey = ${accountId}:${requestId}`. The governor's
 * top-level duplicate check (workbuddy-governor.ts:733-735) rejects the
 * SECOND invocation with the same request id, regardless of priority, even
 * though the title (P4) and the main turn (P2) are legitimately distinct
 * generations derived from the same user message.
 *
 * If the bug is reproduced, sending two parallel requests with the same
 * `x-opencode-request` should fail with status 409 on the second one.
 */
import { createServer } from "http"
import { writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { WorkBuddyPlugin, setTestAccountStore, setTestBackend } from "../packages/opencode/src/plugin/workbuddy"

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`PASS  ${name}`) }
  else { failed++; console.log(`FAIL  ${name}  -> ${detail}`) }
}

let completions = 0
const backend = createServer((req, res) => {
  if (!req.url) { res.writeHead(404); res.end(); return }
  const url = new URL(req.url, "http://127.0.0.1")
  if (url.pathname === "/v2/plugin/auth/token/refresh") {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ code: 0, data: { accessToken: "valid-token", refreshToken: "rt", expiresIn: 3600 } }))
    return
  }
  if (url.pathname === "/v2/chat/completions") {
    completions++
    // Delay slightly so the second parallel request lands while the first
    // is still draining — mirroring the title/main-turn race the user hit.
    const sse =
      `data: {"id":"x","model":"hy4-preview","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"}}]}\n\n` +
      `data: [DONE]\n\n`
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      res.end(sse)
    }, 100)
    return
  }
  res.writeHead(404); res.end()
})
await new Promise<void>((r) => backend.listen(0, "127.0.0.1", () => r()))
const baddr = backend.address()
const backendPort = typeof baddr === "object" && baddr ? baddr.port : 0
setTestBackend(`http://127.0.0.1:${backendPort}`)

const infoPath = join(tmpdir(), `wb-repro-${Date.now()}.info`)
writeFileSync(
  infoPath,
  JSON.stringify({
    auth: { accessToken: "valid-token", refreshToken: "rt", domain: "www.workbuddy.ai", expiresAt: Date.now() + 3_600_000 },
    account: { uid: "u1", enterpriseId: "e1", nickname: "TestUser" },
  }),
)
process.env.WORKBUDDY_AUTH_FILE = infoPath
setTestAccountStore(join(tmpdir(), `wb-repro-vault-${Date.now()}`))

const hooks = await WorkBuddyPlugin({ client: {}, project: { id: "test" }, worktree: "/tmp", directory: "/tmp", experimental_workspace: { register() {} }, serverUrl: new URL("http://localhost:4096") } as any)
const provider: any = { id: "workbuddy", models: {} }
const models = await hooks.provider!.models!(provider, {})
const entry = models["hy4-preview"]
const baseURL: string = entry.api.url
const token: string = entry.headers.Authorization.replace("Bearer ", "")
const H = { "Content-Type": "application/json", Authorization: `Bearer ${token}` }

// ---- chat.headers hook: confirm workbuddy namespaces the request id --------
{
  const headerOutput = { headers: {} as Record<string, string> }
  await hooks["chat.headers"]?.({ sessionID: "s", agent: "title", model: entry, provider: {}, message: { id: "msg-X" } }, headerOutput)
  check("title generation gets a namespaced request id", headerOutput.headers["x-opencode-request"] !== "msg-X" && headerOutput.headers["x-opencode-request"]?.includes("msg-X"), `x-opencode-request=${headerOutput.headers["x-opencode-request"]}`)
}
{
  const headerOutput = { headers: {} as Record<string, string> }
  await hooks["chat.headers"]?.({ sessionID: "s", agent: "build", model: entry, provider: {}, message: { id: "msg-X" } }, headerOutput)
  check("main turn uses a different namespace from title", headerOutput.headers["x-opencode-request"] !== "title:msg-X", `x-opencode-request=${headerOutput.headers["x-opencode-request"]}`)
}

// ---- SCENARIO: parallel title + main turn with the same user message id ---
// Both fire concurrently with `x-opencode-request = <same-id>`. After the fix
// they should both succeed because the workbuddy plugin distinguishes them.
{
  completions = 0
  const sameUserMsgId = "msg-parallel-test"

  // Title generation (P4): mimics `prompt.ts:276-292 generateTitle()` which
  // passes `user: firstInfo` and the same logical request id as the main turn.
  const titleOutput = { headers: {} as Record<string, string> }
  await hooks["chat.headers"]?.({ sessionID: "session-A", agent: "title", model: entry, provider: {}, message: { id: sameUserMsgId } }, titleOutput)
  const titleHeaders = { ...H, ...titleOutput.headers }
  const titleBody = JSON.stringify({
    model: "hy4-preview",
    messages: [{ role: "user", content: "Generate a title" }],
    stream: true,
    max_tokens: 32,
  })

  // Main turn (P2): `prompt.ts:1603+` passes `user: lastUser` and re-uses the
  // SAME `x-opencode-request` value because for a fresh session firstInfo === lastUser.
  const mainOutput = { headers: {} as Record<string, string> }
  await hooks["chat.headers"]?.({ sessionID: "session-A", agent: "build", model: entry, provider: {}, message: { id: sameUserMsgId } }, mainOutput)
  const mainHeaders = { ...H, ...mainOutput.headers }
  const mainBody = JSON.stringify({
    model: "hy4-preview",
    messages: [{ role: "user", content: "Real user prompt" }],
    stream: true,
  })

  // Fire BOTH requests in parallel — neither awaits the other — so they hit
  // the proxy while each is still in flight, mirroring the title/fork race.
  const [titleRes, mainRes] = await Promise.all([
    fetch(`${baseURL}/chat/completions`, { method: "POST", headers: titleHeaders, body: titleBody }),
    fetch(`${baseURL}/chat/completions`, { method: "POST", headers: mainHeaders, body: mainBody }),
  ])
  await Promise.all([titleRes.text(), mainRes.text()])

  check("parallel title + main turn: BOTH succeed (no duplicate rejection)",
    titleRes.status === 200 && mainRes.status === 200,
    `title=${titleRes.status} main=${mainRes.status} completions=${completions}`)
  check("parallel title + main turn: upstream saw both requests",
    completions === 2,
    `completions=${completions}`)
}

// ---- SCENARIO: in-flight duplicate (same agent, same user msg, parallel) ----
// A genuine duplicate (AI SDK retry / accidental re-dispatch) should be rejected
// while the first is still draining, so a real bug surfaces immediately rather
// than silently re-burning the account's budget.
{
  completions = 0
  const userMsgId = "msg-double-fire"
  const output = { headers: {} as Record<string, string> }
  await hooks["chat.headers"]?.({ sessionID: "session-A", agent: "build", model: entry, provider: {}, message: { id: userMsgId } }, output)
  const headers = { ...H, ...output.headers }
  const body = JSON.stringify({ model: "hy4-preview", messages: [{ role: "user", content: "hi" }], stream: true })
  // Fire BOTH in parallel (neither awaits the other) so the second lands
  // while the first is still in flight, exercising the duplicate guard.
  const [r1, r2] = await Promise.all([
    fetch(`${baseURL}/chat/completions`, { method: "POST", headers, body }),
    fetch(`${baseURL}/chat/completions`, { method: "POST", headers, body }),
  ])
  await Promise.all([r1.text(), r2.text()])
  const statuses = [r1.status, r2.status].sort()
  check("in-flight duplicate (same agent) is rejected",
    statuses[0] === 200 && statuses[1] === 409,
    `statuses=[${r1.status},${r2.status}] completions=${completions}`)
}

backend.close()
backend.unref()
console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
process.exit(0)