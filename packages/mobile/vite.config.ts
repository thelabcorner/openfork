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

const proxyTarget = process.env.OPENCODE_DEV_PROXY_TARGET ?? "http://127.0.0.1:4096"

function proxyOpts() {
  return {
    target: proxyTarget,
    changeOrigin: true,
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
  plugins: [solid()],
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
