import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import solid from "vite-plugin-solid"
import { ENV_PROXY_TARGET, ENV_RUN_ID } from "./dev/constants"
import { handshakePath } from "./dev/handshake"
import { createApiProxy } from "./dev/proxy"
import { createTargetResolver } from "./dev/target"

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

/**
 * Owns both the verification gate and the forwarding. Deliberately not Vite's
 * `server.proxy`: routing there is fixed at config time, so a per-request
 * verified target cannot be expressed without an option Vite does not have.
 * See dev/proxy.ts.
 */
const api = createApiProxy({
  resolver,
  apiPrefixes: API_PREFIXES,
  onLog: (level, message) => {
    if (level === "warn") console.warn(`[opencode:mobile] ${message}`)
    else console.info(`[opencode:mobile] ${message}`)
  },
})

export default defineConfig({
  plugins: [
    {
      name: "opencode:verified-sidecar-binding",
      configureServer(server) {
        // Registered inside configureServer (not in a returned thunk) so it runs
        // *before* Vite's own stack — nothing reaches the SPA fallback until the
        // target has proven its identity, and nothing is forwarded at all until
        // then.
        server.middlewares.use((request, response, next) => api.handle(request, response, next))
        server.httpServer?.on("upgrade", (request, socket, head) => {
          api.handleUpgrade(request, socket, head)
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
    // No `proxy` key: API traffic is forwarded by the plugin above, which is
    // the only place that knows which backend has been verified.
  },
  build: {
    target: "esnext",
  },
})
