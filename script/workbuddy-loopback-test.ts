/**
 * Regression test: the OpenFork -> embedded WorkBuddy proxy connection must
 * ALWAYS be true loopback and must NOT inherit HTTP_PROXY/HTTPS_PROXY.
 *
 * We stand up a FAKE EXTERNAL proxy that records every request it is asked to
 * forward, point the environment's HTTP(S)_PROXY at it, then prove:
 *   1. the external proxy IS wired (a non-loopback request reaches it), and
 *   2. ZERO loopback (127.0.0.1) requests - including to the embedded WorkBuddy
 *      server and the test fake upstream - ever reach the external proxy.
 *
 * Run: bun run script/workbuddy-loopback-test.ts
 */
import { createServer, type Server } from "http"
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

// 1) A fake EXTERNAL proxy that records what it is asked to forward.
const externalSeen: string[] = []
const external: Server = createServer((req, res) => {
  externalSeen.push(req.url ?? "")
  res.writeHead(502)
  res.end()
})
await new Promise<void>((r) => external.listen(0, "127.0.0.1", () => r()))
const eaddr = external.address()
const eport = typeof eaddr === "object" && eaddr ? eaddr.port : 0

// Point the environment's proxy vars at the fake external proxy. The plugin's
// ensureLoopbackProxyBypass (run at import) must keep 127.0.0.1 out of it.
process.env.HTTP_PROXY = `http://127.0.0.1:${eport}`
process.env.HTTPS_PROXY = `http://127.0.0.1:${eport}`
process.env.http_proxy = `http://127.0.0.1:${eport}`
process.env.https_proxy = `http://127.0.0.1:${eport}`

// 2) A fake Tencent upstream on loopback (also must bypass the external proxy).
const completions = { n: 0 }
const upstream: Server = createServer((req, res) => {
  const url = req.url ?? ""
  if (url.includes("/v2/plugin/auth/token/refresh")) {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ data: { accessToken: "x", expiresIn: 3600 } }))
    return
  }
  if (url.includes("/v2/chat/completions")) {
    completions.n++
    res.writeHead(200, { "Content-Type": "text/event-stream" })
    res.end('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n')
    return
  }
  res.writeHead(404)
  res.end()
})
await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()))
const uaddr = upstream.address()
const uport = typeof uaddr === "object" && uaddr ? uaddr.port : 0
setTestBackend(`http://127.0.0.1:${uport}`)

// 3) Non-loopback probe: proves the external proxy is actually wired in.
try {
  await fetch("http://nonloopback.invalid/probe")
} catch {
  // 502 from the fake proxy is fine; we only care that it was asked.
}
check("external proxy is wired (saw a non-loopback request)", externalSeen.some((u) => u.includes("nonloopback.invalid")), externalSeen.join(" | "))

// 4) Start the plugin and hit the embedded loopback server.
const infoPath = join(tmpdir(), `wb-lb-${Date.now()}.info`)
writeFileSync(
  infoPath,
  JSON.stringify({ auth: { accessToken: "stale", refreshToken: "rt", domain: "www.workbuddy.ai", expiresAt: Date.now() - 10_000 }, account: { uid: "u1", enterpriseId: "e1", nickname: "TestUser" } }),
)
process.env.WORKBUDDY_AUTH_FILE = infoPath
setTestAccountStore(join(tmpdir(), `wb-loopback-vault-${Date.now()}`))

const hooks = await WorkBuddyPlugin({ client: {}, project: { id: "t" }, worktree: "/tmp", directory: "/tmp", experimental_workspace: { register() {} }, serverUrl: new URL("http://localhost:4096") } as any)
const provider: any = { id: "workbuddy", models: {} }
const models = await hooks.provider!.models!(provider, {})
const entry = models["hy4-preview"]
const baseURL: string = entry.api.url
const token: string = entry.headers.Authorization.replace("Bearer ", "")
const H = { "Content-Type": "application/json", Authorization: `Bearer ${token}` }

// embedded server: health + a real generation (which itself calls the loopback upstream)
await fetch(`http://${new URL(baseURL).host}/health`).then((r) => r.json())
await fetch(`${baseURL}/chat/completions`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({ model: "hy4-preview", messages: [{ role: "user", content: "hi" }], stream: true, max_tokens: 200 }),
}).then((r) => r.text())

check("embedded loopback generation reached the upstream", completions.n >= 1, `completions=${completions.n}`)
check(
  "NO loopback (127.0.0.1) request ever reached the external proxy",
  externalSeen.every((u) => !u.includes("127.0.0.1")),
  externalSeen.filter((u) => u.includes("127.0.0.1")).join(" | ") || "none",
)
check("external proxy only saw non-loopback traffic", externalSeen.length > 0 && externalSeen.every((u) => u.includes("nonloopback.invalid")), externalSeen.join(" | "))

await hooks.dispose?.()
external.close()
upstream.close()
console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
