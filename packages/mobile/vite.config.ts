import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

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

function readDesktopSidecarUrl(): string | undefined {
  try {
    const candidates = [
      join(process.cwd(), ".opencode-dev-url"),
      join(process.cwd(), "packages/mobile/.opencode-dev-url"),
      join(dirname(fileURLToPath(import.meta.url)), ".opencode-dev-url"),
    ]
    for (const p of candidates) {
      if (existsSync(p)) {
        const v = readFileSync(p, "utf8").trim()
        if (v) return v
      }
    }
  } catch {}
  return undefined
}

const configuredProxyTarget = () =>
  readDesktopSidecarUrl() ?? process.env.VITE_OPENCODE_SERVER_URL ?? process.env.OPENCODE_DEV_PROXY_TARGET
const proxyTarget = configuredProxyTarget() ?? "http://127.0.0.1:1"

function proxyOpts() {
  return {
    target: proxyTarget,
    changeOrigin: true,
    // Dynamic router: `concurrently` starts vite and the desktop sidecar
    // in parallel, so at vite startup the sidecar's ephemeral port isn't
    // known yet and `proxyTarget` is still 4096. Reading the well-known
    // file on every request lets the proxy follow the sidecar if it had
    // to fall back to an ephemeral port (overlapping 4096).
    router: () => configuredProxyTarget() ?? proxyTarget,
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
      name: "opencode:require-desktop-sidecar",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const prefix = new URL(request.url ?? "/", "http://localhost").pathname.split("/")[1]
          if (!prefix || !API_PREFIXES.includes(prefix) || configuredProxyTarget()) return next()
          response.statusCode = 503
          response.setHeader("content-type", "application/json")
          response.end(
            JSON.stringify({
              name: "DesktopSidecarUnavailableError",
              data: { message: "The desktop sidecar is not ready. Keep OpenCode Desktop running and try again." },
            }),
          )
        })
      },
    },
    solid(),
  ],
  server: {
    host: "0.0.0.0",
    port: 3301,
    allowedHosts: true,
    proxy: Object.fromEntries(API_PREFIXES.map((p) => [`/${p}`, proxyOpts()])),
  },
  build: {
    target: "esnext",
  },
})
