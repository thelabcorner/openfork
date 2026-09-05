/**
 * Authenticated probe against the running dev stack.
 *
 *   bun packages/mobile/dev/probe.ts /session?limit=3
 *   bun packages/mobile/dev/probe.ts /session/<id>/message?limit=2
 *
 * Hits the path twice — through the Vite dev proxy on :3301 and straight at
 * the sidecar — and prints both, because "does the proxy change the answer?"
 * is the question that matters and the one that used to be unanswerable
 * without a credential. Read-only: it starts nothing and restarts nothing.
 */
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { agentTokenPath, deviceAuthorization, readAgentToken } from "./agent-token"
import { DEV_TARGET_STATUS_PATH } from "./constants"
import { handshakePath, readHandshake } from "./handshake"

const mobileDir = dirname(fileURLToPath(import.meta.url)).replace(/[\\/]dev$/, "")
const DEV_SERVER = process.env.OPENCODE_DEV_SERVER_URL?.trim() || "http://127.0.0.1:3301"

const path = process.argv[2] ?? DEV_TARGET_STATUS_PATH
const method = (process.argv[3] ?? "GET").toUpperCase()

const handshake = readHandshake(handshakePath(mobileDir))?.handshake
const agent = readAgentToken(agentTokenPath(mobileDir))

if (!agent) {
  console.error(
    [
      `No dev tooling token at ${join(mobileDir, ".opencode-dev-agent-token.json")}.`,
      "It is minted by the desktop on startup — run `bun run dev` from packages/desktop once,",
      "with a build that includes ensureAgentToken(), and it will persist from then on.",
    ].join("\n"),
  )
  process.exit(2)
}

async function hit(label: string, base: string) {
  const url = new URL(path, `${base.replace(/\/$/, "")}/`)
  const started = Date.now()
  try {
    const response = await fetch(url, {
      method,
      headers: { authorization: deviceAuthorization(agent!.token), accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    })
    const text = await response.text()
    const ms = Date.now() - started
    console.log(`\n── ${label} ${method} ${url.pathname}${url.search}`)
    console.log(`   HTTP ${response.status} ${response.headers.get("content-type") ?? ""} ${ms}ms`)
    console.log(text.length > 1200 ? `${text.slice(0, 1200)}\n   …(${text.length} bytes total)` : text)
    return { status: response.status, length: text.length }
  } catch (error) {
    console.log(`\n── ${label} ${method} ${url.pathname}${url.search}`)
    console.log(`   FAILED ${String(error)}`)
    return { status: 0, length: 0 }
  }
}

console.log(`handshake: ${handshake ? `${handshake.url} instance ${handshake.instanceID}` : "none"}`)
console.log(`device:    ${agent.deviceName} (${agent.deviceID}) created ${agent.createdAt}`)

const viaProxy = await hit("via dev proxy", DEV_SERVER)
const direct = handshake ? await hit("direct sidecar", handshake.url) : undefined

if (direct) {
  const same = viaProxy.status === direct.status
  console.log(`\n${same ? "MATCH" : "MISMATCH"}: proxy ${viaProxy.status} vs direct ${direct.status}`)
  // A difference here is the proxy's fault by definition: same credential,
  // same path, same process on the other end.
  if (!same) process.exitCode = 1
}
