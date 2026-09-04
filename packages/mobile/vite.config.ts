import type { ServerResponse } from "node:http"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import solid from "vite-plugin-solid"
import { DEV_TARGET_STATUS_PATH, ENV_PROXY_TARGET, ENV_RUN_ID } from "./dev/constants"
import { handshakePath } from "./dev/handshake"
import { createTargetResolver, type TargetResolution } from "./dev/target"

const API_PREFIXES = [
  "agent",
  "api",
  "auth",
  "command",
  "config",
  "devices",
  "event",
  "experimental",
  "file",
  "find",
  "fork",
  "formatter",
  "fs",
  "global",
  "instance",
  "log",
  "lsp",
  "mcp",
  "pair",
  "path",
  "permission",
  "project",
  "provider",
  "pty",
  "question",
  "quota",
  "session",
  "session-group",
  "skill",
  "sync",
  "tool",
  "tui",
  "usage",
  "vcs",
]

const mobileDir = dirname(fileURLToPath(import.meta.url))

const override = ENV_PROXY_TARGET.map((name) => process.env[name]?.trim()).find(Boolean)
const runID = process.env[ENV_RUN_ID]?.trim() || undefined

/**
 * The single gate between the PWA and a backend.
 *
 * Historically this proxied to whatever URL a well-known file contained, with
 * no verification at all. On a machine running many opencode processes that
 * meant a stale or recycled port silently attached the phone to an unrelated
 * instance — you would only notice because the sessions belonged to another
 * project. The resolver now requires the target to echo the `instanceID` the
 * desktop minted for this launch before a single request is forwarded.
 */
const resolver = createTargetResolver({
  file: handshakePath(mobileDir),
  override,
  runID,
  // Verify the identity on every request. A 3-second cache is enough time for
  // a dead sidecar's port to be recycled by another process, which is exactly
  // the silent misbinding this proxy is responsible for making impossible.
  revalidateMs: 0,
  onLog: (level, message) => {
    if (level === "warn") console.warn(`[opencode:mobile] ${message}`)
    else console.info(`[opencode:mobile] ${message}`)
  },
})

if (override && runID) {
  console.warn(
    `[opencode:mobile] ignoring proxy override ${override} because this PWA was launched by the desktop handshake (run ${runID}).`,
  )
} else if (override) {
  console.warn(
    `[opencode:mobile] proxy target overridden to ${override} — it is still identity-checked, and pinned to the first instance that answers.`,
  )
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status
  response.setHeader("content-type", "application/json")
  response.setHeader("cache-control", "no-store")
  response.end(JSON.stringify(body))
}

function unavailable(response: ServerResponse, result: Extract<TargetResolution, { ok: false }>) {
  // 503 with a name/data envelope so it reads like an opencode API error in
  // the network tab, and carries the fix rather than just the symptom.
  sendJson(response, 503, {
    name: result.code,
    data: { message: `${result.message} ${result.hint}`, hint: result.hint, detail: result.detail },
  })
}

function proxyOpts() {
  return {
    // Never used: the gate middleware below resolves and verifies before any
    // request reaches the proxy, and `router` then returns that verified URL.
    // A syntactically valid but unroutable target keeps http-proxy happy.
    target: "http://127.0.0.1:1",
    changeOrigin: true,
    router: () => resolver.verifiedUrl() ?? "http://127.0.0.1:1",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    configure(proxy: any) {
      proxy.on("proxyReq", (proxyReq: any) => {
        // Prevent the server's compression middleware from buffering SSE
        // event-streams through the hop (node http-proxy streams fine otherwise).
        proxyReq.setHeader("accept-encoding", "identity")
      })
    },
  }
}

export default defineConfig({
  plugins: [
    {
      name: "opencode:verified-sidecar-binding",
      configureServer(server) {
        // Registered inside configureServer (not in a returned thunk) so it runs
        // *before* Vite's own proxy middleware — the whole point is that nothing
        // reaches the proxy until the target has proven its identity.
        server.middlewares.use((request, response, next) => {
          const pathname = new URL(request.url ?? "/", "http://localhost").pathname

          if (pathname === DEV_TARGET_STATUS_PATH) {
            void resolver.resolve().then((result) => {
              sendJson(
                response,
                200,
                result.ok
                  ? { bound: true, instanceID: result.instanceID, identity: result.identity, source: result.source }
                  : { bound: false, code: result.code, message: result.message, hint: result.hint },
              )
            })
            return
          }

          const prefix = pathname.split("/")[1]
          if (!prefix || !API_PREFIXES.includes(prefix)) return next()

          void resolver.resolve().then((result) => {
            if (result.ok) return next()
            unavailable(response, result)
          })
        })
      },
    },
    solid(),
  ],
  server: {
    host: "0.0.0.0",
    port: 3301,
    // Fail loudly instead of drifting to 3302. A second dev stack silently
    // taking the next port is how a phone bookmarked at :3301 ends up driving
    // a different checkout's backend.
    strictPort: true,
    allowedHosts: true,
    proxy: Object.fromEntries(API_PREFIXES.map((p) => [`/${p}`, proxyOpts()])),
  },
  build: {
    target: "esnext",
  },
})
